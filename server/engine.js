// The ORBIT execution engine:
// transcribe -> understand -> local or AI -> resolve target -> check permission -> execute -> verify -> confirm.
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { parseIntent, stripWake } from './intents.js';
import { CAPABILITIES } from './devices.js';

const ACTIONY = /\b(open|launch|start|run|close|quit|exit|turn|switch|set|put|play|pause|resume|skip|next|mute|unmute|lock|shut|restart|search|google|look up|screenshot|dim|brighten|raise|lower|increase|decrease|louder|quieter|volume|lights?|music|song|playlist|text|message|activate|fire up|bring up|need)\b/i;
const YES = /^(yes|yeah|yep|confirm|confirmed|do it|go ahead|proceed|sure|affirmative)\b/i;
const NO = /^(no|nope|cancel|stop|don't|abort|never ?mind)\b/i;

export class Engine {
  constructor({ brain, memory, devices, home, automations, audit, settings }) {
    Object.assign(this, { brain, memory, devices, home, automations, audit, settings });
    this.pending = new Map();   // requestId -> resolver for device acks
    this.confirms = new Map();  // sessionId -> { intent, expiresAt }
    this.active = new Map();    // sessionId -> AbortController for the current AI stream
    this.recent = [];           // recent commands for the dashboard
  }

  persona() { return { userName: this.settings.data.userName, tone: this.settings.data.tone }; }

  // ---- device transport ----------------------------------------------------
  sendToDevice(device, capability, params) {
    const ws = this.devices.sockets.get(device.id);
    if (!ws) return Promise.resolve({ ok: false, message: `${device.name} is offline.` });
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, message: `${device.name} didn't confirm in time, so I can't say it worked.` }); }, this.settings.ackTimeoutMs);
      this.pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
      ws.send(JSON.stringify({ type: 'command', id, capability, params }));
    });
  }
  onDeviceResult(msg) {
    const done = this.pending.get(msg.id);
    if (done) { this.pending.delete(msg.id); done({ ok: !!msg.ok, message: msg.message, data: msg.data }); }
  }

  // ---- public entry --------------------------------------------------------
  // emit(event, payload) streams state to the UI: state | text | delta | done | action | confirm | error
  async handle({ text, sessionId = 'default', source = 'text', emit = () => {} }) {
    const started = performance.now();
    const said = String(text || '').trim();
    if (!said) return;
    this.cancel(sessionId); // barge-in: a new utterance interrupts the previous answer
    emit('state', { state: 'processing' });

    // Pending confirmation for a sensitive action
    const conf = this.confirms.get(sessionId);
    if (conf && conf.expiresAt > Date.now()) {
      const bare = stripWake(said);
      if (YES.test(bare)) { this.confirms.delete(sessionId); return this.finish(emit, await this.execute(conf.intent, { sessionId, emit, confirmed: true }), started, said); }
      if (NO.test(bare)) { this.confirms.delete(sessionId); return this.finish(emit, { ok: true, say: 'Cancelled.' }, started, said); }
    }
    this.confirms.delete(sessionId);

    const intent = parseIntent(said);
    if (intent) {
      const res = await this.execute(intent, { sessionId, emit, utterance: said });
      if (res?.handled) return;
      if (res) return this.finish(emit, res, started, said, intent);
    }
    // Sounds like an action but wasn't phrased as one: let the fast model map it to a command.
    if (ACTIONY.test(said)) {
      const routed = await this.brain.route(stripWake(said), { routines: this.automations.routines().map((r) => r.name) });
      const second = routed && parseIntent(routed);
      if (second && second.type !== 'greeting') {
        emit('routed', { from: said, to: routed });
        const res = await this.execute(second, { sessionId, emit, utterance: said });
        if (res?.handled) return;
        if (res) return this.finish(emit, res, started, said, second);
      }
    }
    return this.think({ text: stripWake(said) || said, sessionId, emit, started });
  }

  cancel(sessionId) { const c = this.active.get(sessionId); if (c) { c.abort(); this.active.delete(sessionId); } }

  finish(emit, res, started, said, intent) {
    const ms = Math.round(performance.now() - started);
    const entry = { at: new Date().toISOString(), said, reply: res.say, ok: res.ok !== false, ms, kind: intent?.type || 'ai' };
    this.recent.unshift(entry); this.recent.length = Math.min(this.recent.length, 30);
    if (res.confirm) emit('confirm', { prompt: res.say, capability: res.capability });
    emit('done', { text: res.say, ok: res.ok !== false, ms, route: 'local', data: res.data });
    emit('state', { state: res.ok === false ? 'error' : 'idle' });
    return entry;
  }

  // ---- local execution -----------------------------------------------------
  async execute(intent, ctx) {
    const { emit } = ctx;
    switch (intent.type) {
      case 'greeting': return { ok: true, say: this.greeting() };
      case 'stop': this.cancel(ctx.sessionId); return { ok: true, say: '' };
      case 'mic.off': emit('mic', { enabled: false }); return { ok: true, say: 'Listening is off.' };
      case 'local': return { ok: true, say: intent.answer };
      case 'briefing': return { ok: true, say: this.briefing() };
      case 'model.which': { const b = this.brain.status(); return { ok: true, say: b.provider === 'offline' ? "I don't have an AI key yet." : `I'm using ${b.fastModel} for quick answers and ${b.reasoningModel} for harder ones.` }; }
      case 'model.switch': {
        const hit = await this.brain.findModel(intent.name);
        if (!hit) return { ok: false, say: `I couldn't find a model called ${intent.name} among your providers.` };
        this.brain.keyring.setRoutes({ fast: { provider: hit.provider, model: hit.model }, reasoning: { provider: hit.provider, model: hit.model } });
        emit('model', this.brain.status());
        return { ok: true, say: `Switched to ${hit.model}.` };
      }
      case 'memory.add': {
        try { this.memory.add({ text: intent.text, kind: 'fact', source: 'voice' }); emit('memory', {}); return { ok: true, say: "Noted. I'll remember that." }; }
        catch (e) { return { ok: false, say: e.code === 'SENSITIVE' ? "That looks sensitive, so I haven't saved it. You can add it yourself from the Memory screen." : e.message }; }
      }
      case 'memory.forget': {
        const hits = this.memory.recall(intent.text, 3);
        if (!hits.length) return { ok: false, say: "I don't have anything like that stored." };
        this.memory.remove(hits[0].id); emit('memory', {});
        return { ok: true, say: `Forgotten: ${hits[0].text}` };
      }
      case 'routine': return this.runRoutine(intent.name, ctx);
      case 'chain': {
        for (const step of intent.steps) { const r = await this.execute(step, ctx); if (!r.ok) return r; }
        return { ok: true, say: intent.speak };
      }
      case 'home.lights': case 'home.temperature': case 'home.thermostat': return this.homeAction(intent, emit);
      case 'wake.device': return this.wakeOnLan(intent.hint);
      case 'action': return this.deviceAction(intent, ctx);
      default: return null;
    }
  }

  async homeAction(intent, emit) {
    emit('state', { state: 'executing' });
    const tag = this.home.simulated ? ' (simulated)' : '';
    try {
      if (intent.type === 'home.lights') {
        const r = await this.home.lights(intent);
        this.audit.write({ kind: 'home', action: 'lights', params: intent, ok: r.ok, via: this.home.name });
        if (!r.ok) return { ok: false, say: r.message };
        const where = intent.area ? `${intent.area} lights` : 'lights';
        return { ok: true, say: intent.on ? (intent.brightness != null ? `${cap(where)} at ${intent.brightness} percent${tag}.` : `${cap(where)} on${tag}.`) : `${cap(where)} off${tag}.` };
      }
      if (intent.type === 'home.temperature') {
        const r = await this.home.temperature(intent);
        return r.ok ? { ok: true, say: `It's ${r.value}${r.unit.replace('°', ' degrees ').replace(/ C$/, '')} in the ${(r.name || 'room').toLowerCase()}${tag}.` } : { ok: false, say: r.message };
      }
      const r = await this.home.thermostat(intent);
      this.audit.write({ kind: 'home', action: 'thermostat', params: intent, ok: r.ok, via: this.home.name });
      return r.ok ? { ok: true, say: `Thermostat set to ${intent.value} degrees${tag}.` } : { ok: false, say: r.message };
    } catch (e) {
      return { ok: false, say: `${this.home.name} isn't responding.` };
    }
  }

  async deviceAction(intent, ctx) {
    const { emit } = ctx;
    const device = this.devices.resolve(intent.hint);
    if (!device) return { ok: false, say: this.devices.list().length ? 'None of your devices are online right now.' : 'No devices are connected yet. Pair one from the Devices screen.' };
    const capDef = CAPABILITIES[intent.capability];
    if (!device.permissions.includes(intent.capability)) {
      this.audit.write({ kind: 'device', device: device.name, capability: intent.capability, ok: false, reason: 'not permitted' });
      return { ok: false, say: `${device.name} isn't allowed to ${capDef.label.toLowerCase()}. You can grant that in Security.` };
    }
    if (capDef.sensitive && !ctx.confirmed) {
      this.confirms.set(ctx.sessionId, { intent, expiresAt: Date.now() + 30000 });
      const what = intent.capability === 'message.send' ? `send "${intent.params.body}" to ${intent.params.to}` : `${capDef.label.toLowerCase()} on ${device.name}`;
      return { ok: true, confirm: true, capability: intent.capability, say: `Shall I ${what}? Say yes to confirm.` };
    }
    emit('state', { state: 'executing' });
    emit('action', { device: device.name, capability: intent.capability, params: intent.params, status: 'sent' });
    const r = await this.sendToDevice(device, intent.capability, intent.params);
    this.audit.write({ kind: 'device', device: device.name, deviceId: device.id, capability: intent.capability, params: redact(intent.params), ok: r.ok, message: r.message, confirmed: !!ctx.confirmed });
    emit('action', { device: device.name, capability: intent.capability, status: r.ok ? 'ok' : 'failed', message: r.message });
    if (!r.ok) return { ok: false, say: r.message || `${device.name} reported a failure.` };

    if (intent.capability === 'screen.capture' && intent.params.analyze && r.data?.image) {
      await this.think({ text: intent.analyzeQuestion || 'What is on my screen? If there is an error, explain how to fix it.', sessionId: ctx.sessionId, emit, image: { data: r.data.image, mediaType: r.data.mediaType }, started: performance.now() });
      return { ok: true, say: null, handled: true };
    }
    if (intent.capability === 'system.status' && r.data) return { ok: true, say: describeStatus(device.name, r.data), data: r.data };
    return { ok: true, say: r.message && !intent.speak ? r.message : (intent.speak || 'Done.'), data: r.data };
  }

  async runRoutine(name, ctx) {
    const routine = this.automations.find(name);
    if (!routine) return { ok: false, say: `I don't have a ${name} routine. You can create one in Automations.` };
    ctx.emit('state', { state: 'executing' });
    const failed = [];
    for (const step of routine.steps) {
      const intent = parseIntent(step);
      const r = intent ? await this.execute(intent, { ...ctx, confirmed: false }) : { ok: false, say: `I don't know how to "${step}".` };
      if (!r.ok || r.confirm) failed.push(step);
      ctx.emit('action', { routine: routine.label, step, status: r.ok && !r.confirm ? 'ok' : 'failed', message: r.say });
    }
    this.audit.write({ kind: 'routine', routine: routine.label, ok: !failed.length, failed });
    if (!failed.length) return { ok: true, say: `${routine.label} is ready.` };
    if (failed.length === routine.steps.length) return { ok: false, say: `${routine.label} didn't run. ${failed.length} steps failed.` };
    return { ok: false, say: `${routine.label} is partly ready. ${failed.length} of ${routine.steps.length} steps didn't complete.` };
  }

  wakeOnLan(hint) {
    const all = this.devices.store.data.devices.filter((d) => !d.revoked && d.status?.mac);
    const d = (hint && all.find((x) => x.name.toLowerCase().includes(hint.toLowerCase()))) || all[0];
    if (!d) return Promise.resolve({ ok: false, say: "I don't know a network address for that computer yet. Connect its Companion once so I can learn it." });
    const mac = Buffer.from(d.status.mac.replace(/[^0-9a-f]/gi, ''), 'hex');
    const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(mac)]);
    return new Promise((resolve) => {
      const s = dgram.createSocket('udp4');
      s.bind(() => { s.setBroadcast(true); s.send(packet, 9, '255.255.255.255', () => { s.close(); this.audit.write({ kind: 'device', device: d.name, capability: 'wake', ok: true }); resolve({ ok: true, say: `Wake signal sent to ${d.name}. I'll tell you when it's online.` }); }); });
    });
  }

  // ---- AI reasoning --------------------------------------------------------
  async think({ text, sessionId, emit, image = null, started }) {
    const ctrl = new AbortController();
    this.active.set(sessionId, ctrl);
    const memories = this.memory.recall(text);
    if (memories.length) emit('memory', { recalled: memories.map((m) => m.id) });
    let full = '', meta = null;
    try {
      for await (const part of this.brain.answer({ text, image, history: this.memory.context(sessionId), memories, devices: this.devices.list(), persona: this.persona(), signal: ctrl.signal })) {
        if (part.meta) { meta = part.meta; emit('state', { state: 'speaking', ...meta }); continue; }
        full += part.delta;
        emit('delta', { text: part.delta });
      }
      this.memory.pushTurn(sessionId, 'user', text);
      this.memory.pushTurn(sessionId, 'assistant', full);
      const ms = Math.round(performance.now() - started);
      this.recent.unshift({ at: new Date().toISOString(), said: text, reply: full.slice(0, 200), ok: true, ms, kind: `ai:${meta?.tier}` });
      this.recent.length = Math.min(this.recent.length, 30);
      emit('done', { text: full, ok: true, ms, route: meta?.tier, model: meta?.model });
      emit('state', { state: 'idle' });
    } catch (e) {
      if (ctrl.signal.aborted) { emit('done', { text: full, ok: true, interrupted: true }); return; }
      emit('error', { message: e.message });
      emit('done', { text: "I couldn't reach my reasoning engine. Local commands still work.", ok: false });
      emit('state', { state: 'error' });
    } finally { if (this.active.get(sessionId) === ctrl) this.active.delete(sessionId); }
  }

  // ---- proactive -----------------------------------------------------------
  greeting(now = new Date()) {
    const h = now.getHours();
    const part = h < 5 ? 'evening' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
    return `Good ${part}. I'm here. What can I do for you?`;
  }
  briefing(now = new Date()) {
    const today = this.automations.reminders().filter((r) => !r.done && new Date(r.at).toDateString() === now.toDateString());
    const overdue = this.automations.reminders().filter((r) => !r.done && new Date(r.at) < now);
    const online = this.devices.list().filter((d) => d.online).length;
    const bits = [this.greeting(now).split('.')[0] + '.'];
    bits.push(today.length ? `You have ${today.length} reminder${today.length > 1 ? 's' : ''} today${today[0] ? `, starting with ${today[0].text}` : ''}.` : 'Nothing is scheduled today.');
    if (overdue.length) bits.push(`${overdue.length} reminder${overdue.length > 1 ? 's are' : ' is'} overdue.`);
    bits.push(`${online} device${online === 1 ? ' is' : 's are'} online.`);
    return bits.join(' ');
  }
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const redact = (p = {}) => ({ ...p, ...(p.body ? { body: '[redacted]' } : {}) });
function describeStatus(name, s) {
  const parts = [`${name}`];
  if (s.battery != null) parts.push(`battery at ${s.battery} percent${s.charging ? ', charging' : ''}`);
  if (s.cpu != null) parts.push(`CPU ${s.cpu} percent`);
  if (s.memoryUsed != null) parts.push(`memory ${s.memoryUsed} percent used`);
  if (s.uptimeHours != null) parts.push(`up ${s.uptimeHours} hours`);
  return parts.length > 1 ? `${parts[0]}: ${parts.slice(1).join(', ')}.` : `${name} is online.`;
}
