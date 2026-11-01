#!/usr/bin/env node
// ORBIT Companion: the local device agent. It runs on your computer, holds its own credential,
// and only performs the capabilities ORBIT has granted AND this machine's local config allows.
//
//   node companion/agent.js pair http://orbit-host:7777 123456 "Alex's MacBook"
//   node companion/agent.js            # run (reconnects automatically)
//   node companion/agent.js unpair
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';

const run = promisify(execFile);
const CONF = process.env.ORBIT_COMPANION_CONFIG || path.join(os.homedir(), '.orbit-companion.json');
const PLATFORM = process.platform; // win32 | darwin | linux | android (Termux reports android)
const platformName = { win32: 'windows', darwin: 'darwin', linux: 'linux', android: 'android' }[PLATFORM] || PLATFORM;

const loadConf = () => (fs.existsSync(CONF) ? JSON.parse(fs.readFileSync(CONF, 'utf8')) : null);
const saveConf = (c) => fs.writeFileSync(CONF, JSON.stringify(c, null, 2), { mode: 0o600 });

// ---- local policy: the machine owner's own limits, enforced even if the server allows more ----
const DEFAULT_LOCAL = {
  approvedFolders: [path.join(os.homedir(), 'Documents'), path.join(os.homedir(), 'Desktop')],
  approvedCommands: {},            // e.g. { "backup": ["/usr/local/bin/backup.sh"] }
  workflows: {},                   // e.g. { "dev": [["code", "~/work"]] }
  deny: [],                        // capabilities this machine never performs
  appAliases: {},                  // e.g. { "vs code": "Visual Studio Code" }
};

const APP_ALIASES = {
  darwin: { chrome: 'Google Chrome', 'google chrome': 'Google Chrome', 'visual studio code': 'Visual Studio Code', 'vs code': 'Visual Studio Code', vscode: 'Visual Studio Code', code: 'Visual Studio Code', terminal: 'Terminal', spotify: 'Spotify', discord: 'Discord', steam: 'Steam', safari: 'Safari', slack: 'Slack', netflix: 'Safari' },
  win32: { chrome: 'chrome', 'google chrome': 'chrome', 'visual studio code': 'code', 'vs code': 'code', vscode: 'code', terminal: 'wt', spotify: 'spotify', discord: 'discord', steam: 'steam', edge: 'msedge', notepad: 'notepad', netflix: 'https://www.netflix.com' },
  linux: { chrome: 'google-chrome', 'google chrome': 'google-chrome', 'visual studio code': 'code', 'vs code': 'code', vscode: 'code', terminal: 'x-terminal-emulator', spotify: 'spotify', discord: 'discord', steam: 'steam', firefox: 'firefox', netflix: 'https://www.netflix.com' },
};
const SAFE_NAME = /^[\w .+&'()-]{1,60}$/;

function resolveApp(name, local) {
  const key = String(name).toLowerCase().trim();
  const app = local.appAliases[key] || APP_ALIASES[PLATFORM]?.[key] || name;
  if (!/^https:\/\//.test(app) && !SAFE_NAME.test(app)) throw new Error(`"${name}" isn't a valid app name.`);
  return app;
}

// ---- capability implementations (execFile with argument arrays: no shell interpolation) ----
const ps = (script) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000 });
const winKeys = (code, times) => ps(`$w=New-Object -ComObject WScript.Shell; 1..${times} | % { $w.SendKeys([char]${code}) }`);

const handlers = {
  async 'app.open'({ app }, local) {
    const a = resolveApp(app, local);
    if (/^https:\/\//.test(a)) return handlers['browser.open']({ url: a });
    if (PLATFORM === 'darwin') await run('open', ['-a', a]);
    else if (PLATFORM === 'win32') await ps(`Start-Process -FilePath ${JSON.stringify(a)}`);
    else { const c = execFileDetached(a, []); if (!c) throw new Error(`${a} isn't installed.`); }
    return { message: `Opened ${app}.` };
  },
  async 'browser.open'({ url }) {
    if (!/^https:\/\//.test(url)) throw new Error('Only https links can be opened.');
    if (PLATFORM === 'darwin') await run('open', [url]);
    else if (PLATFORM === 'win32') await ps(`Start-Process ${JSON.stringify(url)}`);
    else execFileDetached('xdg-open', [url]);
    return { message: 'Opened.' };
  },
  async 'browser.search'({ query }) {
    return handlers['browser.open']({ url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}` }).then(() => ({ message: `Searching for ${query}.` }));
  },
  async 'app.close'({ app }, local) {
    const a = resolveApp(app, local);
    if (PLATFORM === 'darwin') await run('osascript', ['-e', `tell application ${JSON.stringify(a)} to quit`]);
    else if (PLATFORM === 'win32') await run('taskkill', ['/IM', `${a}.exe`]);
    else await run('pkill', ['-x', a]);
    return { message: `Closed ${app}.` };
  },
  async 'volume.set'({ level, delta, mute }) {
    if (PLATFORM === 'darwin') {
      if (mute !== undefined) await run('osascript', ['-e', `set volume output muted ${mute}`]);
      else if (level != null) await run('osascript', ['-e', `set volume output volume ${level}`]);
      else await run('osascript', ['-e', `set volume output volume ((output volume of (get volume settings)) + ${delta})`]);
    } else if (PLATFORM === 'win32') {
      if (mute !== undefined) await winKeys(173, 1);
      else if (level != null) { await winKeys(174, 50); await winKeys(175, Math.round(level / 2)); }
      else await winKeys(delta > 0 ? 175 : 174, Math.round(Math.abs(delta) / 2));
    } else {
      if (mute !== undefined) await run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', mute ? '1' : '0']);
      else await run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', level != null ? `${level}%` : `${delta > 0 ? '+' : ''}${delta}%`]);
    }
    return { message: mute !== undefined ? (mute ? 'Muted.' : 'Unmuted.') : level != null ? `Volume ${level}%.` : `Volume ${delta > 0 ? 'up' : 'down'}.` };
  },
  async 'media.control'({ action }) {
    const map = { play: ['play', 179, 'play-pause'], pause: ['pause', 179, 'pause'], next: ['next track', 176, 'next'], previous: ['previous track', 177, 'previous'] };
    const [mac, vk, linux] = map[action] || map.play;
    if (PLATFORM === 'darwin') await run('osascript', ['-e', `tell application "Spotify" to ${mac}`]).catch(() => run('osascript', ['-e', `tell application "Music" to ${mac}`]));
    else if (PLATFORM === 'win32') await winKeys(vk, 1);
    else await run('playerctl', [linux]);
    return { message: { play: 'Playing.', pause: 'Paused.', next: 'Next track.', previous: 'Previous track.' }[action] };
  },
  async 'screen.capture'() {
    const file = path.join(os.tmpdir(), `orbit-shot-${Date.now()}.png`);
    if (PLATFORM === 'darwin') await run('screencapture', ['-x', file]);
    else if (PLATFORM === 'win32') await ps(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $i=New-Object System.Drawing.Bitmap $b.Width,$b.Height; [System.Drawing.Graphics]::FromImage($i).CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $i.Save(${JSON.stringify(file)})`);
    else await run('gnome-screenshot', ['-f', file]).catch(() => run('import', ['-window', 'root', file]));
    const data = fs.readFileSync(file).toString('base64');
    fs.unlinkSync(file); // never kept on disk
    return { message: 'Screenshot taken.', data: { image: data, mediaType: 'image/png' } };
  },
  async 'system.lock'() {
    if (PLATFORM === 'darwin') await run('pmset', ['displaysleepnow']);
    else if (PLATFORM === 'win32') await run('rundll32.exe', ['user32.dll,LockWorkStation']);
    else await run('loginctl', ['lock-session']);
    return { message: 'Locked.' };
  },
  async 'system.shutdown'({ mode }) {
    const restart = mode === 'restart';
    if (PLATFORM === 'win32') await run('shutdown', [restart ? '/r' : '/s', '/t', '30']);
    else if (PLATFORM === 'darwin') await run('osascript', ['-e', `tell application "System Events" to ${restart ? 'restart' : 'shut down'}`]);
    else await run('systemctl', [restart ? 'reboot' : 'poweroff']);
    return { message: restart ? 'Restarting.' : 'Shutting down.' };
  },
  async 'system.status'() { return { message: 'Status read.', data: await status() }; },
  async 'notify.show'({ title = 'ORBIT', text }) {
    if (PLATFORM === 'darwin') await run('osascript', ['-e', `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`]);
    else if (PLATFORM === 'win32') await ps(`[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; $n.Visible=$true; $n.ShowBalloonTip(5000,${JSON.stringify(title)},${JSON.stringify(text)},'Info')`);
    else await run('notify-send', [title, text]);
    return { message: 'Shown.' };
  },
  async 'files.list'({ folder }, local) {
    const dir = path.resolve(folder ? folder.replace(/^~/, os.homedir()) : local.approvedFolders[0]);
    if (!local.approvedFolders.some((f) => dir === path.resolve(f) || dir.startsWith(path.resolve(f) + path.sep))) throw new Error('That folder isn\'t approved on this device.');
    const items = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 200).map((d) => ({ name: d.name, dir: d.isDirectory() }));
    return { message: `${items.length} items.`, data: { folder: dir, items } };
  },
  async 'command.run'({ name }, local) {
    const cmd = local.approvedCommands[name];
    if (!cmd) throw new Error(`"${name}" isn't an approved command on this device.`);
    const { stdout } = await run(cmd[0], cmd.slice(1), { timeout: 60000 });
    return { message: `Ran ${name}.`, data: { output: stdout.slice(-2000) } };
  },
  async 'workflow.run'({ name }, local) {
    const wf = local.workflows[name];
    if (!wf) throw new Error(`No workflow called ${name} on this device.`);
    for (const [bin, ...args] of wf) execFileDetached(bin, args.map((a) => a.replace(/^~/, os.homedir())));
    return { message: `Started ${name}.` };
  },
  async 'message.send'() {
    throw new Error('Messaging needs a messaging integration on this device; none is configured.');
  },
};

function execFileDetached(bin, args) {
  try {
    const child = execFile(bin, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {}); child.unref(); return child;
  } catch { return null; }
}

function primaryMac() {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (!i.internal && i.family === 'IPv4' && i.mac !== '00:00:00:00:00:00') return i.mac;
  return null;
}
let lastCpu = os.cpus().map((c) => c.times);
async function status() {
  const now = os.cpus().map((c) => c.times);
  let idle = 0, total = 0;
  now.forEach((t, i) => { const p = lastCpu[i] || t; const d = Object.keys(t).reduce((s, k) => s + t[k] - p[k], 0); total += d; idle += t.idle - p.idle; });
  lastCpu = now;
  const s = {
    hostname: os.hostname(), platform: platformName, mac: primaryMac(),
    cpu: total ? Math.round(100 * (1 - idle / total)) : null,
    memoryUsed: Math.round(100 * (1 - os.freemem() / os.totalmem())),
    uptimeHours: Math.round(os.uptime() / 3600),
  };
  if (PLATFORM === 'darwin') {
    try { const { stdout } = await run('pmset', ['-g', 'batt']); const m = stdout.match(/(\d+)%;\s*(\w+)/); if (m) { s.battery = +m[1]; s.charging = m[2] !== 'discharging'; } } catch {}
  } else if (PLATFORM === 'linux' && fs.existsSync('/sys/class/power_supply/BAT0/capacity')) {
    s.battery = +fs.readFileSync('/sys/class/power_supply/BAT0/capacity', 'utf8'); s.charging = fs.readFileSync('/sys/class/power_supply/BAT0/status', 'utf8').trim() !== 'Discharging';
  }
  return s;
}

export async function execute(capability, params, local) {
  const policy = { ...DEFAULT_LOCAL, ...local };
  if (policy.deny.includes(capability)) return { ok: false, message: 'This device blocks that action locally.' };
  const fn = handlers[capability];
  if (!fn) return { ok: false, message: `This device can't ${capability} yet.` };
  try { const r = await fn(params || {}, policy); return { ok: true, ...r }; }
  catch (e) {
    if (e.code === 'ENOENT') return { ok: false, message: `This device is missing the system tool for that (${e.path}).` };
    return { ok: false, message: e.message.split('\n')[0].slice(0, 200) };
  }
}

// ---- connection --------------------------------------------------------------
function connect(conf) {
  let backoff = 1000;
  const open = () => {
    const ws = new WebSocket(conf.server.replace(/^http/, 'ws') + '/ws/device', { headers: { authorization: `Bearer ${conf.token}` } });
    let statusTimer;
    ws.on('open', async () => {
      backoff = 1000;
      console.log(`[orbit] connected to ${conf.server} as ${conf.name}`);
      const push = async () => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'status', status: await status() }));
      push(); statusTimer = setInterval(push, 60000);
    });
    ws.on('message', async (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type !== 'command') return;
      const t0 = Date.now();
      const r = await execute(msg.capability, msg.params, conf.local);
      console.log(`[orbit] ${msg.capability} -> ${r.ok ? 'ok' : 'failed'} (${Date.now() - t0} ms) ${r.ok ? '' : r.message}`);
      ws.send(JSON.stringify({ type: 'result', id: msg.id, ...r }));
    });
    ws.on('unexpected-response', (_, res) => { if (res.statusCode === 401) { console.error('[orbit] this device was revoked or its token is invalid. Pair again.'); process.exit(2); } });
    ws.on('close', (code) => {
      clearInterval(statusTimer);
      if (code === 4001) { console.error('[orbit] access revoked by ORBIT.'); process.exit(2); }
      setTimeout(open, backoff); backoff = Math.min(backoff * 2, 30000);
    });
    ws.on('error', () => {});
  };
  open();
}

async function main() {
  const [cmd, server, code, ...nameParts] = process.argv.slice(2);
  if (cmd === 'pair') {
    if (!server || !code) { console.error('usage: agent.js pair <server-url> <code> [device name]'); process.exit(1); }
    const name = nameParts.join(' ') || os.hostname();
    const res = await fetch(`${server.replace(/\/$/, '')}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name, platform: platformName }) });
    if (!res.ok) { console.error('[orbit] pairing failed:', (await res.json()).error); process.exit(1); }
    const { token, device } = await res.json();
    saveConf({ server: server.replace(/\/$/, ''), token, name: device.name, id: device.id, local: DEFAULT_LOCAL });
    console.log(`[orbit] paired as "${device.name}". Credential saved to ${CONF}. Run: node companion/agent.js`);
    return;
  }
  if (cmd === 'unpair') { if (fs.existsSync(CONF)) fs.unlinkSync(CONF); console.log('[orbit] credential removed.'); return; }
  const conf = loadConf();
  if (!conf) { console.error('Not paired. Run: node companion/agent.js pair <server-url> <code>'); process.exit(1); }
  connect(conf);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
