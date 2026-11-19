// Small helpers behind several voice features: weather (Open-Meteo, free, no key), the health of the
// machine ORBIT runs on (e.g. the Raspberry Pi), and quiet hours.
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';

// ---- weather ---------------------------------------------------------------
const WMO = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'cloudy', 45: 'foggy', 48: 'foggy',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'rain showers', 81: 'rain showers', 82: 'heavy showers',
  85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'thunderstorms with hail',
};
export const describeWeather = (code) => WMO[code] || 'mixed weather';

export async function geocode(name, fetchImpl = fetch) {
  const r = await fetchImpl(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(6000) });
  const j = await r.json();
  const hit = j.results?.[0];
  if (!hit) return null;
  return { name: [hit.name, hit.country].filter(Boolean).join(', '), lat: hit.latitude, lon: hit.longitude };
}

let cache = { key: '', at: 0, data: null };
export async function weather(loc, fetchImpl = fetch) {
  if (!loc?.lat) return null;
  const key = `${loc.lat},${loc.lon}`;
  if (cache.key === key && Date.now() - cache.at < 15 * 60000) return cache.data;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=7`;
  const j = await (await fetchImpl(url, { signal: AbortSignal.timeout(6000) })).json();
  const data = {
    place: loc.name,
    now: { temp: Math.round(j.current.temperature_2m), text: describeWeather(j.current.weather_code), wind: Math.round(j.current.wind_speed_10m) },
    days: j.daily.time.map((d, i) => ({ date: d, text: describeWeather(j.daily.weather_code[i]), max: Math.round(j.daily.temperature_2m_max[i]), min: Math.round(j.daily.temperature_2m_min[i]), rain: j.daily.precipitation_probability_max?.[i] ?? null })),
  };
  cache = { key, at: Date.now(), data };
  return data;
}
export function weatherSentence(w) {
  const t = w.days[0];
  return `It's ${w.now.temp} degrees and ${w.now.text} in ${w.place.split(',')[0]}. Today ${t.text}, between ${t.min} and ${t.max} degrees${t.rain != null && t.rain >= 30 ? `, ${t.rain} percent chance of rain` : ''}.`;
}
export function weatherCard(w) {
  const day = (d) => new Date(`${d}T12:00`).toLocaleDateString('en', { weekday: 'long' });
  return [`# Weather in ${w.place}`, `Now: ${w.now.temp}° and ${w.now.text}`, '', ...w.days.map((d) => `- ${day(d.date)}: ${d.text}, ${d.min}° to ${d.max}°${d.rain != null && d.rain >= 30 ? `, ${d.rain}% rain` : ''}`)].join('\n');
}

// ---- health of this machine (the Pi when ORBIT runs on one) ------------------
const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return null; } };
const sh = (cmd, args) => new Promise((res) => execFile(cmd, args, { timeout: 2000 }, (e, out) => res(e ? null : String(out))));
export async function hostHealth() {
  const h = { name: os.hostname(), uptimeHours: Math.round(os.uptime() / 3600), load: Math.round((os.loadavg()[0] / os.cpus().length) * 100) };
  h.memoryUsed = Math.round((1 - os.freemem() / os.totalmem()) * 100);
  const t = read('/sys/class/thermal/thermal_zone0/temp'); if (t) h.temperature = Math.round(Number(t) / 1000);
  for (const dir of fs.existsSync('/sys/class/hwmon') ? fs.readdirSync('/sys/class/hwmon') : []) {
    const rpm = read(`/sys/class/hwmon/${dir}/fan1_input`); if (rpm != null) { h.fanRpm = Number(rpm); break; }
  }
  const thr = await sh('vcgencmd', ['get_throttled']);
  if (thr) { const v = parseInt((thr.split('=')[1] || '0').trim(), 16); h.throttled = !!(v & 0x4); h.overheating = !!(v & 0x8); h.underVoltage = !!(v & 0x1); h.pastHeat = !!(v & 0x80000); h.pastPower = !!(v & 0x10000); }
  const df = await sh('df', ['-P', '/']); if (df) { const p = df.trim().split('\n')[1]?.split(/\s+/)[4]; if (p) h.diskUsed = parseInt(p, 10); }
  return h;
}
export function healthSentence(h) {
  const bits = [];
  if (h.temperature != null) bits.push(`${h.temperature} degrees${h.temperature >= 80 ? ', which is too hot' : h.temperature >= 70 ? ', running warm' : ', nice and cool'}`);
  bits.push(`processor ${h.load} percent busy`, `memory ${h.memoryUsed} percent used`);
  if (h.fanRpm != null) bits.push(h.fanRpm > 0 ? `fan at ${h.fanRpm} RPM` : 'fan stopped');
  let s = `${h.name}: ${bits.join(', ')}.`;
  if (h.overheating || h.throttled) s += ' It is slowing itself down to cool off right now.';
  else if (h.pastHeat) s += ' It got too hot at some point since it started.';
  if (h.underVoltage) s += ' The power supply is too weak; use the official 3 amp supply.';
  else if (h.pastPower) s += ' The power dipped at some point; check the power supply.';
  return s;
}
export function healthCard(h) {
  const line = (k, v) => (v == null ? null : `- ${k}: ${v}`);
  return [`# ${h.name} health`, line('Temperature', h.temperature != null ? `${h.temperature} °C${h.temperature >= 80 ? ' (too hot)' : h.temperature >= 70 ? ' (warm)' : ''}` : null),
    line('Fan', h.fanRpm != null ? `${h.fanRpm} RPM` : null), line('Processor', `${h.load}% busy`), line('Memory', `${h.memoryUsed}% used`),
    line('Storage', h.diskUsed != null ? `${h.diskUsed}% used` : null), line('Up for', `${h.uptimeHours} hours`),
    line('Throttling', h.throttled || h.overheating ? 'yes, cooling off' : h.pastHeat ? 'earlier, not now' : null),
    line('Power', h.underVoltage ? 'too weak' : h.pastPower ? 'dipped earlier' : null)].filter(Boolean).join('\n');
}

// ---- quiet hours -------------------------------------------------------------
// settings.quietHours = { enabled, start: '22:30', end: '07:00' }
export function isQuiet(q, now = new Date()) {
  if (!q?.enabled) return false;
  const m = (s) => { const [h, mm] = String(s || '0:0').split(':').map(Number); return h * 60 + (mm || 0); };
  const t = now.getHours() * 60 + now.getMinutes(), a = m(q.start || '22:30'), b = m(q.end || '07:00');
  return a <= b ? t >= a && t < b : t >= a || t < b;
}
