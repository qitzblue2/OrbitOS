import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOME = mkdtempSync(path.join(tmpdir(), 'aph-b-'));
const db = path.join(HOME, '.pki', 'nssdb'); mkdirSync(db, { recursive: true });
execFileSync('certutil', ['-N', '-d', `sql:${db}`, '--empty-password']);
const pems = readFileSync('/root/.ccr/ca-bundle.crt', 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
pems.forEach((pem, i) => { const f = path.join(HOME, `c${i}.pem`); writeFileSync(f, pem); execFileSync('certutil', ['-A', '-d', `sql:${db}`, '-n', `c${i}`, '-t', 'C,,', '-i', f]); });
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const app = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron'),
  args: ['--no-sandbox', `--user-data-dir=${HOME}/p`, ...(proxy ? [`--proxy-server=${proxy}`] : []), '.'],
  env: { ...process.env, HOME, APHELION_TEST: '1' } });
await app.firstWindow(); await sleep(3000);
const A = (fn, arg) => app.evaluate(fn, arg);
// timing of the main-process request hook itself
await A(() => {
  const a = global.__aphelion; const p = [...a.pipelines.values()][0];
  const orig = p.before.bind(p); p._t = 0; p._n = 0;
  p.before = (d) => { const t = process.hrtime.bigint(); const r = orig(d); p._t += Number(process.hrtime.bigint() - t); p._n++; return r; };
});
const load = (u) => A((_e, u) => new Promise((res) => {
  const t = global.__aphelion.current().active(); const t0 = Date.now();
  t.wc.once('did-finish-load', () => res(Date.now() - t0)); t.wc.loadURL(u);
}), u);
for (const shield of [true, false]) {
  for (const k of ['shield', 'ads']) await A((_e, a) => global.__aphelion.setSetting(a[0], a[1]), [k, shield]);
  const times = [];
  for (const u of ['https://www.theguardian.com/international', 'https://en.wikipedia.org/wiki/Orbit', 'https://www.bbc.com/news']) {
    await load('about:blank'); times.push(await load(u));
  }
  console.log(`protection ${shield ? 'on ' : 'off'}: load ms`, times.join(', '));
}
console.log('request hook:', await A(() => { const p = [...global.__aphelion.pipelines.values()][0]; return `${p._n} requests, avg ${(p._t / p._n / 1e3).toFixed(1)} µs`; }));
await Promise.race([app.close(), sleep(4000)]); process.exit(0);
