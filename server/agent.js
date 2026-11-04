// The ORBIT agent: the AI works through a task with tools on the user's computer
// (terminal, files, apps, browser), one step at a time, until it is done.
// Commands and file edits ask the user first unless they've allowed them for the session or turned on Full control.
import crypto from 'node:crypto';
import { CAPABILITIES } from './devices.js';

export const TOOLS = [
  { name: 'run_command', capability: 'shell.run', approve: true,
    description: 'Run a terminal command on the user\'s computer (PowerShell on Windows, the login shell on macOS/Linux) and get its output and exit code. Use for installing packages, running scripts, git, building projects, starting dev servers (start long-running servers in the background).',
    parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string', description: 'Folder to run in. Relative paths are inside the ORBIT Workspace.' } }, required: ['command'] } },
  { name: 'write_file', capability: 'files.write', approve: true,
    description: 'Create or overwrite a text file with the full content. Relative paths are inside the ORBIT Workspace; folders are created automatically.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'read_file', capability: 'files.read',
    description: 'Read a text file (or list a folder).', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'list_directory', capability: 'files.read', device: 'files.listdir',
    description: 'List the files in a folder. Defaults to the ORBIT Workspace.', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'open', capability: 'app.open',
    description: 'Open something on the user\'s screen: an app by name (e.g. "Spotify"), a website URL (https://… or http://localhost:…), or a file/folder path (e.g. a generated index.html).',
    parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } },
  { name: 'set_volume', capability: 'volume.set', description: 'Set the system volume (0-100).', parameters: { type: 'object', properties: { level: { type: 'number' } }, required: ['level'] } },
  { name: 'media', capability: 'media.control', description: 'Control media playback.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['play', 'pause', 'next', 'previous'] } }, required: ['action'] } },
  { name: 'device_status', capability: 'system.status', description: 'Read CPU, memory, battery and uptime.', parameters: { type: 'object', properties: {} } },
  { name: 'remember', description: 'Save a lasting fact about the user to ORBIT\'s memory.', parameters: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] } },
];

const summary = (name, a) => ({
  run_command: `Run: ${a.command}${a.cwd ? `  (in ${a.cwd})` : ''}`,
  write_file: `Write ${a.path} (${String(a.content || '').split('\n').length} lines)`,
  read_file: `Read ${a.path}`, list_directory: `List ${a.path || 'ORBIT Workspace'}`, open: `Open ${a.target}`,
  set_volume: `Volume ${a.level}%`, media: `Media: ${a.action}`, device_status: 'Read device status', remember: `Remember: ${a.fact}`,
}[name] || name);

export class Agent {
  constructor({ engine, brain, memory, devices, audit, settings }) {
    Object.assign(this, { engine, brain, memory, devices, audit, settings });
    this.sessions = new Map();   // sessionId -> neutral message history
    this.approvals = new Map();  // approval id -> resolver
    this.allowed = new Map();    // sessionId -> Set of tool names allowed for the session
  }

  reset(sessionId) { this.sessions.delete(sessionId); this.allowed.delete(sessionId); }
  resolveApproval(id, { ok, session }, sessionId) {
    const r = this.approvals.get(id); if (!r) return;
    this.approvals.delete(id);
    if (ok && session) { if (!this.allowed.has(sessionId)) this.allowed.set(sessionId, new Set()); this.allowed.get(sessionId).add(r.tool); }
    r.resolve(!!ok);
  }

  system({ mode, platform }) {
    const s = this.settings.data;
    return [
      `You are ORBIT, ${s.userName ? `${s.userName}'s` : "the user's"} personal AI with direct access to their computer through tools. Calm, capable, concise.`,
      mode === 'code' ? 'This is a coding session. Act like a senior engineer: plan briefly, then build. Write complete, working files (never placeholders), run and test what you build, read errors and fix them. When finished, summarise what you made, where it is, and how to run it, with short code excerpts only where useful.' : '',
      `Computer: ${platform || 'unknown OS'}. New projects go in the ORBIT Workspace folder (relative paths land there) unless the user names another place.`,
      'Do the work with tools instead of telling the user to do it. Prefer several small verified steps. After creating a web page, open it for the user.',
      s.fullControl ? 'The user has given you full control of this computer: you may use any folder.' : 'You may use the ORBIT Workspace, Documents and Desktop folders.',
      'Tool results are real; never claim something worked unless a tool result shows it did. If a tool is refused or not permitted, tell the user plainly what to enable.',
      s.customInstructions ? `The user's own instructions (follow them):\n${s.customInstructions}` : '',
    ].filter(Boolean).join('\n\n');
  }

  async exec(tool, args, { device, sessionId, emit }) {
    if (tool.name === 'remember') { this.memory.add({ text: String(args.fact || ''), kind: 'fact', source: 'agent', allowSensitive: false }); emit('memory', {}); return 'Saved to memory.'; }
    if (!device) return 'No computer is connected to ORBIT, so this could not be done.';
    if (!device.permissions.includes(tool.capability)) return `Not permitted: "${CAPABILITIES[tool.capability].label}" is switched off for ${device.name}. The user can enable it in Security.`;
    const needsOk = tool.approve && !this.settings.data.fullControl && !this.allowed.get(sessionId)?.has(tool.name);
    if (needsOk) {
      const id = crypto.randomUUID();
      const ok = await new Promise((resolve) => {
        this.approvals.set(id, { resolve, tool: tool.name });
        emit('approve', { id, tool: tool.name, summary: summary(tool.name, args), detail: tool.name === 'write_file' ? String(args.content || '').slice(0, 4000) : args.command || '' });
        setTimeout(() => { if (this.approvals.delete(id)) resolve(false); }, 10 * 60 * 1000);
      });
      if (!ok) return 'The user declined this action. Ask what they would like instead, or continue without it.';
    }
    // Map the tool to the device capability and parameters.
    let cap = tool.device || tool.capability, params = { ...args, anyPath: !!this.settings.data.fullControl };
    if (tool.name === 'open') {
      const t = String(args.target || '');
      if (/^https?:\/\//i.test(t)) { cap = 'browser.open'; params = { url: t }; }
      else if (/[\\/]|\.\w{1,5}$/.test(t)) { cap = 'files.open'; params = { path: t, anyPath: params.anyPath }; }
      else { cap = 'app.open'; params = { app: t }; }
    }
    const r = await this.engine.sendToDevice(device, cap, params, 10 * 60 * 1000);
    this.audit.write({ kind: 'agent', device: device.name, tool: tool.name, summary: summary(tool.name, args), ok: r.ok });
    if (!r.ok) return `Failed: ${r.message}`;
    const d = r.data || {};
    if (tool.name === 'run_command') return `Exit code ${d.exitCode}.\n${d.output || '(no output)'}`;
    if (tool.name === 'read_file') return d.content ?? (d.items ? d.items.join('\n') : r.message);
    if (tool.name === 'list_directory') return `${d.path}\n${(d.items || []).join('\n') || '(empty)'}`;
    if (tool.name === 'device_status') return JSON.stringify(d);
    return r.message || 'Done.';
  }

  async run({ text, sessionId, emit, mode = 'chat', signal }) {
    const device = this.devices.resolve(null);
    const dev = device && this.devices.get(device.id);
    const history = this.sessions.get(sessionId) || [];
    history.push({ role: 'user', content: text });
    const sys = this.system({ mode, platform: dev?.platform });
    let final = '';
    for (let step = 0; step < 30; step++) {
      if (signal?.aborted) break;
      emit('state', { state: 'processing' });
      const r = await this.brain.step({ system: sys, messages: history.slice(-60), tools: TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters })), tier: 'reasoning', signal });
      history.push({ role: 'assistant', content: r.text, toolCalls: r.toolCalls });
      if (r.text && r.toolCalls.length) emit('agent-note', { text: r.text });
      if (!r.toolCalls.length) { final = r.text || 'Done.'; break; }
      emit('state', { state: 'executing' });
      for (const call of r.toolCalls) {
        const tool = TOOLS.find((t) => t.name === call.name);
        const callId = crypto.randomUUID();
        emit('tool', { callId, name: call.name, summary: tool ? summary(call.name, call.args) : call.name, status: 'running' });
        let out;
        try { out = tool ? await this.exec(tool, call.args || {}, { device: dev, sessionId, emit }) : `Unknown tool ${call.name}.`; }
        catch (e) { out = `Failed: ${e.message}`; }
        const failed = /^(Failed|Not permitted|No computer|The user declined)/.test(out);
        emit('tool', { callId, name: call.name, status: failed ? 'failed' : 'ok', output: out.slice(0, 4000) });
        history.push({ role: 'tool', id: call.id, name: call.name, content: out.length > 12000 ? `${out.slice(0, 12000)}\n…(truncated)` : out });
      }
      if (step === 29) final = 'I stopped after 30 steps. Say "continue" to keep going.';
    }
    this.sessions.set(sessionId, history.slice(-80));
    return final;
  }
}
