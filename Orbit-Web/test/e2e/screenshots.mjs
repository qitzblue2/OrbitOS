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
await app.firstWindow();
let ui;
for (let i = 0; i < 60 && !ui; i++) {
  ui = app.windows().find((w) => w.url().startsWith('aphelion://ui'));
  if (!ui) await sleep(500);
}
if (!ui) throw new Error(`toolbar page not found: ${app.windows().map((w) => w.url()).join(', ')}`);
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
const setSetting = (k, v) => A((_e, { k, v }) => global.__aphelion.setSetting(k, v), { k, v });
const openPop = async (name) => {
  await ui.evaluate((n) => document.querySelector(`.widget[title="${n}"]`)?.click(), name);
  await sleep(900);
};
const closePop = async () => {
  await ui.keyboard.press('Escape');
  await sleep(400);
};
const go = async (url, wait = 6000) => {
  await A((_e, u) => global.__aphelion.current().navigate(u), url);
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

// passkeys: no background (conditional) requests, so no random Windows Security dialogs
const site = app.windows().find((w) => w.url().startsWith('https://example.com'));
const pk = await site.evaluate(async () => {
  const avail = await PublicKeyCredential.isConditionalMediationAvailable();
  let err = '';
  try {
    await navigator.credentials.get({ mediation: 'conditional', publicKey: { challenge: new Uint8Array(16) } });
  } catch (e) { err = e.name; }
  return { avail, err };
});
check(pk.avail === false && pk.err === 'NotSupportedError', `background passkey requests are refused quietly (${JSON.stringify(pk)})`);

// 5. KeePass: unlock the test database, entries match the site
await A((_e, p) => global.__aphelion.setSetting('vaultPath', p), vaultPath);
await openPop('KeePass');
await ui.fill('#pop input[type=password]', 'orbit-demo');
await ui.keyboard.press('Enter');
await sleep(4000);
await shot('06-keepass-unlocked');
const kpText = await ui.evaluate(() => document.querySelector('#pop')?.innerText || '');
check(/Matches for example\.com/i.test(kpText) && /demo-user/.test(kpText), 'KeePass shows the matching entry for example.com');
await closePop();

// 6. Authenticator: password first, then real TOTP secrets
await openPop('Authenticator');
await shot('07a-authenticator-setup');
check(await ui.evaluate(() => document.querySelectorAll('#pop input[type=password]').length === 2), '2FA asks to set a password first');
await ui.fill('#pop input[type=password] >> nth=0', 'orbit-2fa-pass');
await ui.fill('#pop input[type=password] >> nth=1', 'orbit-2fa-pass');
await ui.keyboard.press('Enter');
await sleep(1500);
await closePop();
await A(() => global.__aphelion.addTotp('otpauth://totp/GitHub:qitzblue2?secret=JBSWY3DPEHPK3PXP&issuer=GitHub'));
await A(() => global.__aphelion.addTotp('otpauth://totp/Proton:me%40example.org?secret=KRSXG5CTMVRXEZLUKN2XAZLSOI&issuer=Proton%20Mail'));
await openPop('Authenticator');
await shot('07-authenticator');
const codes = await A(() => global.__aphelion.totpCodes());
check(codes.length === 2 && codes.every((c) => /^\d{6}$/.test(c.code)), 'authenticator produces 6-digit codes');
// the add form must survive the once-a-second code refresh
await ui.click('#pop summary');
await sleep(2500);
check(await ui.evaluate(() => document.querySelector('#pop details')?.open === true), '"Add an account" stays open while codes refresh');
await shot('07b-authenticator-add');
await closePop();
// locked: no codes without the password, wrong password refused
await A(() => global.__aphelion.auth.lock());
const lockedErr = await A(() => { try { global.__aphelion.totpCodes(); return ''; } catch (e) { return e.message; } });
check(/locked/.test(lockedErr), 'locked authenticator gives no codes');
await openPop('Authenticator');
await ui.fill('#pop input[type=password]', 'wrong-pass');
await ui.keyboard.press('Enter');
await sleep(1500);
check(/wrong password/.test(await ui.evaluate(() => document.querySelector('#pop .err')?.textContent || '')), 'wrong 2FA password is refused');
await shot('07c-authenticator-locked');
await ui.fill('#pop input[type=password]', 'orbit-2fa-pass');
await ui.keyboard.press('Enter');
await sleep(1500);
check(await ui.evaluate(() => document.querySelectorAll('#pop .code').length === 2), 'right 2FA password unlocks the codes');
await closePop();

// 7. quick notes saved to ~/Home/Notes
await openPop('Quick notes');
await ui.fill('#pop textarea', 'Read later: Orbit OS build guide\nAsk about the EliteBook fingerprint reader');
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

// 12. tab strip: a real mouse click on another tab switches to it
await A(() => global.__aphelion.current().newTab('aphelion://newtab/'));
await sleep(1500);
const before = await A(() => global.__aphelion.current().activeId);
await ui.click('.tab >> nth=0');
await sleep(800);
const after = await A(() => global.__aphelion.current().activeId);
check(before !== after, 'clicking a tab in the strip switches tabs');

// 13. suggestions: local matches appear without waiting for the search engine
await ui.click('#addr');
await ui.keyboard.type('wik', { delay: 30 });
await sleep(300);
const t0 = Date.now();
await ui.keyboard.type('i');
// measured inside the page: time from the keystroke to options on screen
const firstMs = await ui.evaluate(() => new Promise((resolve) => {
  const start = performance.now();
  const tick = () => {
    if (document.querySelectorAll('#pop [role=option]').length > 0) resolve(Math.round(performance.now() - start));
    else if (performance.now() - start > 3000) resolve(-1);
    else requestAnimationFrame(tick);
  };
  tick();
}));
void t0;
console.log(`     first suggestions after ${firstMs} ms`);
check(firstMs >= 0 && firstMs < 400, 'address-bar suggestions show up at once');
await shot('16a-suggestions');
await ui.keyboard.press('Escape');

// 14. translation: asked once per tab, not on every page
await A(() => global.__aphelion.current().newTab('https://de.wikipedia.org/wiki/Aphel'));
await sleep(7000);
const bars1 = (await state()).bars.map((b) => b.id);
check(bars1.includes('translate'), 'German page offers translation');
await shot('16b-translate-offer');
await go('https://de.wikipedia.org/wiki/Perihel', 7000);
const bars2 = (await state()).bars.map((b) => b.id);
check(!bars2.includes('translate'), 'the offer is not repeated on the next page in the same tab');
await A(() => global.__aphelion.current().newTab('https://de.wikipedia.org/wiki/Umlaufbahn'));
await sleep(7000);
check((await state()).bars.some((b) => b.id === 'translate'), 'a new tab asks again');
await ui.evaluate(() => [...document.querySelectorAll('#bars button')].find((b) => b.textContent === 'Translate')?.click());
await sleep(9000);
const tr = (await state()).nav.url;
check(tr.includes('.translate.goog/'), `Translate opens the page through Google Translate (${tr.slice(0, 60)})`);
await shot('16c-translated');

// 15. customizable new tab: real site icons, shortcuts, clock, own picture
await A(() => global.__aphelion.current().newTab('aphelion://newtab/'));
await sleep(2500);
const nt = () => app.windows().filter((w) => w.url().startsWith('aphelion://newtab')).pop();
let ntp = nt();
const iconTiles = await ntp.evaluate(() => document.querySelectorAll('#tiles .ic img').length);
check(iconTiles >= 2, `new-tab shortcuts show site icons (${iconTiles})`);
const tabIcons = await ui.evaluate(() => [...document.querySelectorAll('.tab img.fav')].filter((i) => i.getAttribute('src')).length);
check(tabIcons >= 3, `tabs show icons (${tabIcons})`);
await ntp.evaluate(() => window.aphelion.call('newtabShortcut', 'add', { title: 'Orbit OS', url: 'github.com/qitzblue2/OrbitOS' }));
const bad = await ntp.evaluate(() => window.aphelion.call('newtabShortcut', 'add', { url: 'not an address' }).then(() => 'accepted', (e) => e.message));
check(/web address/.test(bad), 'a shortcut must be a web address');
await shot('17-newtab-icons');
await ntp.click('#customize');
await sleep(800);
await shot('18-newtab-customize');
const picture = readFileSync(path.join(OUT, '14-newtab-lagoon.png')).toString('base64');
await ntp.evaluate(async (b64) => {
  await window.aphelion.call('newtabSet', { shape: 'circle', columns: 5, rows: 2, size: 'l', showBrand: false, greeting: 'Welcome back, Sam' });
  await window.aphelion.call('newtabImage', `data:image/png;base64,${b64}`);
  await window.aphelion.call('newtabSet', { dim: 35, blur: 6 });
}, picture);
await sleep(1500);
const ntState = await ntp.evaluate(() => ({ pic: document.querySelector('#picture').classList.contains('on'),
                                            circle: document.querySelector('#tiles').classList.contains('circle'),
                                            clock: !document.querySelector('#clock').hidden,
                                            greet: document.querySelector('#clock .greet').textContent }));
check(ntState.pic && ntState.circle && ntState.clock && ntState.greet === 'Welcome back, Sam', `new-tab options apply live (${JSON.stringify(ntState)})`);
await shot('19-newtab-custom');
await ntp.click('#panel .close');
await sleep(500);
await shot('20-newtab-custom-clean');
await ntp.evaluate(() => window.aphelion.call('newtabImage', null));

// 16. history page
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
