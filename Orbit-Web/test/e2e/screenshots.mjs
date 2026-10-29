// End-to-end tour of Aphelion with real screenshots of the whole window.
//   xvfb-run -a -s "-screen 0 1600x1000x24" dbus-run-session node test/e2e/screenshots.mjs OUTDIR
// Drives the real app through Playwright + the APHELION_TEST hook, visits real websites,
// and fails (exit 1) on page errors or failed checks.
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const OUT = path.resolve(process.argv[2] || 'test-shots');
mkdirSync(OUT, { recursive: true });
const HOME = mkdtempSync(path.join(tmpdir(), 'aph-home-'));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- test environment: Orbit-style ~/Home, proxy CA for this sandbox (if any) ---
for (const d of ['Home/Downloads', 'Home/Notes', 'Home/Documents']) mkdirSync(path.join(HOME, d), { recursive: true });
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || '';
const ca = process.env.APH_TEST_CA || '/root/.ccr/ca-bundle.crt';
try {
  const db = path.join(HOME, '.pki', 'nssdb');
  mkdirSync(db, { recursive: true });
  execFileSync('certutil', ['-N', '-d', `sql:${db}`, '--empty-password']);
  const pems = readFileSync(ca, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  pems.slice(0, 400).forEach((pem, i) => {
    const f = path.join(HOME, `ca${i}.pem`);
    writeFileSync(f, pem);
    execFileSync('certutil', ['-A', '-d', `sql:${db}`, '-n', `ca${i}`, '-t', 'C,,', '-i', f]);
  });
  console.log(`test CA: ${pems.length} certs`);
} catch (e) {
  console.log(`no test CA (${e.message.split('\n')[0]})`);
}

// --- a KeePass database to unlock in the tour ---
const kdbxweb = require('kdbxweb');
const { argon2d, argon2id } = require('hash-wasm');
kdbxweb.CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type) => {
  const fn = type === kdbxweb.CryptoEngine.Argon2TypeArgon2id ? argon2id : argon2d;
  const out = await fn({ password: new Uint8Array(password), salt: new Uint8Array(salt), parallelism, iterations, memorySize: memory,
                         hashLength: length, outputType: 'binary' });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
});
const db = kdbxweb.Kdbx.create(new kdbxweb.KdbxCredentials(kdbxweb.ProtectedValue.fromString('orbit-demo')), 'Passwords');
for (const [title, user, url] of [['GitHub', 'qitzblue2', 'https://github.com'], ['Proton Mail', 'me@example.org', 'https://proton.me'],
                                  ['Example', 'demo-user', 'https://example.com'], ['Steam', 'qitz_blue', 'https://steampowered.com']]) {
  const e = db.createEntry(db.getDefaultGroup());
  e.fields.set('Title', title);
  e.fields.set('UserName', user);
  e.fields.set('URL', url);
  e.fields.set('Password', kdbxweb.ProtectedValue.fromString(`pw-${title}-123`));
}
const vaultPath = path.join(HOME, 'Home/Documents/Passwords.kdbx');
writeFileSync(vaultPath, Buffer.from(await db.save()));

// --- a slow local download so the Downloads widget shows progress ---
const server = createServer((req, res) => {
  if (req.url !== '/orbit-os-1.0.0-full-amd64.iso') return res.end('<h1>local</h1>');
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(40e6),
                       'content-disposition': 'attachment; filename="orbit-os-1.0.0-full-amd64.iso"' });
  let sent = 0;
  const chunk = Buffer.alloc(256 * 1024);
  const tick = setInterval(() => {
    if (sent >= 40e6) {
      clearInterval(tick);
      return res.end();
    }
    res.write(chunk);
    sent += chunk.length;
  }, 120);
  req.on('close', () => clearInterval(tick));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const args = ['--no-sandbox', `--user-data-dir=${path.join(HOME, 'profile')}`];
if (proxy) args.push(`--proxy-server=${proxy}`, '--proxy-bypass-list=127.0.0.1;localhost');
const app = await electron.launch({
  executablePath: path.resolve('node_modules/electron/dist/electron'),
  args: [...args, '.'],
  env: { ...process.env, HOME, APHELION_TEST: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  timeout: 60000,
});
app.process().stderr.on('data', (d) => {
  const s = String(d);
  if (/Uncaught|Error:|TypeError|ReferenceError/.test(s) && !/dbus|portal|GPU|gl_|viz|angle|vaapi|egl/i.test(s)) {
    console.log(`[main] ${s.trim()}`);
    if (/Uncaught|TypeError|ReferenceError/.test(s)) failures.push(`main process: ${s.trim().slice(0, 200)}`);
  }
});
const ui = await app.firstWindow();
const pageErrors = [];
ui.on('pageerror', (e) => pageErrors.push(`ui: ${e.message}`));
app.on('window', (w) => w.on('pageerror', (e) => pageErrors.push(`${w.url()}: ${e.message}`)));

const A = (fn, arg) => app.evaluate(fn, arg);
await A(() => {
  const a = global.__aphelion;
  const w = a.current();
  w.win.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
});
await sleep(2500);

async function shot(name) {
  await sleep(700);
  const b = await A(() => global.__aphelion.current().win.getBounds());
  const file = path.join(OUT, `${name}.png`);
  execFileSync('import', ['-window', 'root', '-crop', `${b.width}x${b.height}+${b.x}+${b.y}`, '+repage', file]);
  console.log(`shot ${name}`);
}
const setSetting = (k, v) => A(({ k, v }) => global.__aphelion.setSetting(k, v), { k, v });
const openPop = async (name) => {
  await ui.evaluate((n) => document.querySelector(`.widget[title="${n}"]`)?.click(), name);
  await sleep(900);
};
const closePop = async () => {
  await ui.keyboard.press('Escape');
  await sleep(400);
};
const go = async (url, wait = 6000) => {
  await A((u) => global.__aphelion.current().navigate(u), url);
  await sleep(wait);
};
const state = () => A(() => global.__aphelion.current().state());

// 1. new tab page (Glass)
await shot('01-newtab-glass');

// 2. the ⋯ menu
await ui.click('#menu-btn');
await sleep(700);
await shot('02-menu');
await closePop();

// 3. a real website with trackers: shield + ad counts
await go('https://www.theguardian.com/international', 9000);
let st = await state();
check(st.nav.secure, 'HTTPS page shows as secure');
check(st.counts.trackers > 0, `tracker shield blocked ${st.counts.trackers} trackers on theguardian.com`);
await shot('03-site-shield-count');
await ui.click('#shield');
await sleep(800);
await shot('04-tracker-shield');
await closePop();
await openPop('Ad blocker');
await shot('05-ad-blocker');
await closePop();

// 4. HTTPS-only: plain http is upgraded
await go('http://example.com/', 5000);
st = await state();
check(st.nav.url.startsWith('https://example.com'), `http://example.com upgraded to ${st.nav.url}`);

// 5. KeePass: unlock the test database, entries match the site
await A((p) => global.__aphelion.setSetting('vaultPath', p), vaultPath);
await openPop('KeePass');
await ui.fill('.pop input[type=password]', 'orbit-demo');
await ui.keyboard.press('Enter');
await sleep(4000);
await shot('06-keepass-unlocked');
const kpText = await ui.evaluate(() => document.querySelector('.pop')?.innerText || '');
check(/Matches for example\.com/.test(kpText) && /demo-user/.test(kpText), 'KeePass shows the matching entry for example.com');
await closePop();

// 6. Authenticator with a real TOTP secret
await A(() => global.__aphelion.addTotp('otpauth://totp/GitHub:qitzblue2?secret=JBSWY3DPEHPK3PXP&issuer=GitHub'));
await A(() => global.__aphelion.addTotp('otpauth://totp/Proton:me%40example.org?secret=KRSXG5CTMVRXEZLUKN2XAZLSOI&issuer=Proton%20Mail'));
await openPop('Authenticator');
await shot('07-authenticator');
const codes = await A(() => global.__aphelion.totpCodes());
check(codes.length === 2 && codes.every((c) => /^\d{6}$/.test(c.code)), 'authenticator produces 6-digit codes');
await closePop();

// 7. quick notes saved to ~/Home/Notes
await openPop('Quick notes');
await ui.fill('.pop textarea', 'Read later: Orbit OS build guide\nAsk about the EliteBook fingerprint reader');
await sleep(1200);
await shot('08-quick-notes');
await closePop();
check(readFileSync(path.join(HOME, 'Home/Notes/Browser notes.md'), 'utf8').includes('EliteBook'), 'quick notes saved to ~/Home/Notes');

// 8. a download in progress
await go(`http://127.0.0.1:${port}/orbit-os-1.0.0-full-amd64.iso`, 3500);
await shot('09-downloads');
await closePop();

// 9. settings
await A(() => global.__aphelion.current().newTab('aphelion://settings/#appearance'));
await sleep(2500);
await shot('10-settings-appearance');
await A(() => global.__aphelion.current().navigate('aphelion://settings/#privacy'));
await sleep(500);
await A(() => global.__aphelion.current().active().wc.reload());
await sleep(2500);
await shot('11-settings-privacy');

// 10. styles
await setSetting('style', 'Light');
await setSetting('bg', 'Light');
await A(() => global.__aphelion.current().newTab());
await sleep(2500);
await shot('12-newtab-light');
await setSetting('style', 'Graphite');
await setSetting('bg', 'Graphite');
await sleep(1500);
await shot('13-newtab-graphite');
await setSetting('style', 'Glass');
await setSetting('bg', 'Lagoon');
await setSetting('reduce', false);
await sleep(1200);
await shot('14-newtab-lagoon');
await setSetting('bg', 'Glass');

// 11. reader view on a real article
await go('https://en.wikipedia.org/wiki/Apsis', 7000);
st = await state();
await A(() => global.__aphelion.readerView(global.__aphelion.current()));
await sleep(3000);
st = await state();
check(st.nav.url.startsWith('aphelion://reader'), 'reader view opened for a Wikipedia article');
await shot('15-reader');

// 12. history page
await A(() => global.__aphelion.current().navigate('aphelion://history/'));
await sleep(2000);
await shot('16-history');

check(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors.join(' | ')}` : ''}`);
await Promise.race([app.close(), sleep(5000)]);
try {
  app.process().kill('SIGKILL');
} catch { /* already gone */ }
server.close();
console.log(failures.length ? `\n${failures.length} FAILED:\n- ${failures.join('\n- ')}` : '\nE2E PASSED');
process.exit(failures.length ? 1 : 0);
