// Smart-home hub. Adapters: Home Assistant (covers most ecosystems), Philips Hue, and a clearly-labelled simulator.
export class HomeAssistant {
  constructor({ url, token }) { this.url = url.replace(/\/$/, ''); this.token = token; this.name = 'Home Assistant'; }
  async call(path, body) {
    const res = await fetch(`${this.url}/api/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Home Assistant ${res.status}`);
    return res.json();
  }
  async states() { return this.call('states'); }
  async lights({ on, brightness, area }) {
    const all = (await this.states()).filter((s) => s.entity_id.startsWith('light.'));
    const hit = area ? all.filter((s) => `${s.entity_id} ${s.attributes.friendly_name || ''}`.toLowerCase().includes(area.toLowerCase())) : all;
    if (!hit.length) return { ok: false, message: area ? `I couldn't find lights in the ${area}.` : 'No lights found.' };
    const data = { entity_id: hit.map((s) => s.entity_id) };
    if (on && brightness != null) data.brightness_pct = brightness;
    await this.call(`services/light/turn_${on ? 'on' : 'off'}`, data);
    return { ok: true, count: hit.length };
  }
  async temperature({ area }) {
    const s = (await this.states()).filter((x) => x.attributes.device_class === 'temperature' || x.entity_id.startsWith('climate.'));
    const hit = (area && s.find((x) => `${x.entity_id} ${x.attributes.friendly_name || ''}`.toLowerCase().includes(area.toLowerCase()))) || s[0];
    if (!hit) return { ok: false, message: 'No temperature sensor found.' };
    const v = hit.entity_id.startsWith('climate.') ? hit.attributes.current_temperature : hit.state;
    return { ok: true, value: Number(v), unit: hit.attributes.unit_of_measurement || '°C', name: hit.attributes.friendly_name };
  }
  async thermostat({ value }) {
    const c = (await this.states()).find((x) => x.entity_id.startsWith('climate.'));
    if (!c) return { ok: false, message: 'No thermostat found.' };
    await this.call('services/climate/set_temperature', { entity_id: c.entity_id, temperature: value });
    return { ok: true };
  }
  async scene(name) {
    const sc = (await this.states()).find((x) => x.entity_id.startsWith('scene.') && x.entity_id.includes(name.replace(/\s+/g, '_')));
    if (!sc) return { ok: false, message: `No scene called ${name}.` };
    await this.call('services/scene/turn_on', { entity_id: sc.entity_id });
    return { ok: true };
  }
}

export class Hue {
  constructor({ ip, username }) { this.base = `http://${ip}/api/${username}`; this.name = 'Philips Hue'; }
  async req(path, method = 'GET', body) {
    const res = await fetch(`${this.base}/${path}`, { method, body: body && JSON.stringify(body), signal: AbortSignal.timeout(4000) });
    return res.json();
  }
  async lights({ on, brightness, area }) {
    const groups = await this.req('groups');
    const entry = Object.entries(groups).find(([, g]) => area && g.name.toLowerCase().includes(area.toLowerCase()));
    const id = entry ? entry[0] : '0'; // group 0 = all lights
    const state = { on };
    if (on && brightness != null) state.bri = Math.round((brightness / 100) * 254);
    const r = await this.req(`groups/${id}/action`, 'PUT', state);
    const ok = Array.isArray(r) && r.every((x) => x.success);
    return ok ? { ok: true } : { ok: false, message: 'The Hue bridge rejected that.' };
  }
  async temperature() { return { ok: false, message: 'Hue has no temperature sensor configured.' }; }
  async thermostat() { return { ok: false, message: 'No thermostat is connected.' }; }
  async scene() { return { ok: false, message: 'Scenes need Home Assistant.' }; }
}

// Lets you develop and demo without hardware. Every reply is marked simulated.
export class SimulatedHome {
  constructor() { this.name = 'Simulator'; this.simulated = true; this.state = { lights: { living: 0, bedroom: 0, office: 0 }, temp: 21.5, target: 21 }; }
  async lights({ on, brightness, area }) {
    const keys = area ? Object.keys(this.state.lights).filter((k) => area.includes(k) || k.includes(area)) : Object.keys(this.state.lights);
    if (!keys.length) return { ok: false, message: `There are no lights in the ${area}.` };
    for (const k of keys) this.state.lights[k] = on ? (brightness ?? 100) : 0;
    return { ok: true, count: keys.length };
  }
  async temperature() { return { ok: true, value: this.state.temp, unit: '°C', name: 'Living room' }; }
  async thermostat({ value }) { this.state.target = value; return { ok: true }; }
  async scene() { return { ok: true }; }
}

export function createHome(cfg) {
  if (cfg.homeAssistant.url && cfg.homeAssistant.token) return new HomeAssistant(cfg.homeAssistant);
  if (cfg.hue.ip && cfg.hue.username) return new Hue(cfg.hue);
  return new SimulatedHome();
}
