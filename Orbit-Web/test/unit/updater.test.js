'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const updater = require('../../src/main/updater');

const EXE = Buffer.alloc(2_000_000, 7);
const SHA = crypto.createHash('sha256').update(EXE).digest('hex');
const FEED = { version: '1.2.0', file: 'Aphelion-Setup-1.2.0.exe', sha256: SHA, size: EXE.length };

function server(files) {
  return async (url) => {
    const name = new URL(url).pathname.split('/').pop();
    if (!(name in files)) return new Response('nope', { status: 404 });
    const body = files[name];
    return new Response(typeof body === 'string' ? body : new Blob([body]).stream(), { status: 200 });
  };
}

test('version comparison', () => {
  assert.ok(updater.isNewer('1.2.0', '1.1.1'));
  assert.ok(updater.isNewer('1.10.0', '1.9.9'));
  assert.ok(!updater.isNewer('1.1.1', '1.1.1'));
  assert.ok(!updater.isNewer('1.0.9', '1.1.0'));
});

test('feed validation refuses odd files and checksums', () => {
  assert.equal(updater.validateFeed(FEED).url,
    'https://github.com/qitzblue2/OrbitOS/releases/download/aphelion-v1.2.0/Aphelion-Setup-1.2.0.exe');
  for (const bad of [{ ...FEED, url: 'https://evil.example/Aphelion-Setup-1.2.0.exe' },
    { ...FEED, file: '../evil.exe' }, { ...FEED, file: 'Aphelion-Setup-1.2.0.bat' },
    { ...FEED, sha256: 'x' }, { ...FEED, version: '1.2.0; rm' }, { ...FEED, size: 5 }, null]) {
    assert.throws(() => updater.validateFeed(bad));
  }
});

test('check: available, current, Orbit and other systems', async () => {
  const fetch = server({ 'latest.json': JSON.stringify(FEED) });
  assert.equal((await updater.check({ fetch, current: '1.1.1', platform: 'win32' })).status, 'available');
  assert.equal((await updater.check({ fetch, current: '1.2.0', platform: 'win32' })).status, 'current');
  assert.equal((await updater.check({ fetch, current: '1.1.1', platform: 'linux', orbit: true })).status, 'managed');
  assert.equal((await updater.check({ fetch: server({}), current: '1.1.1', platform: 'win32' })).status, 'error');
});

test('download keeps only a file that matches the feed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aph-upd-'));
  const feed = updater.validateFeed(FEED);
  let last = 0;
  const file = await updater.download({ fetch: server({ [FEED.file]: EXE }), feed, dir, onProgress: (f) => { last = f; } });
  assert.equal(fs.readFileSync(file).equals(EXE), true);
  assert.equal(last, 1);
  const damaged = Buffer.from(EXE);
  damaged[5] = 1;
  await assert.rejects(updater.download({ fetch: server({ [FEED.file]: damaged }), feed, dir: `${dir}/b` }), /damaged/);
  assert.equal(fs.existsSync(`${dir}/b/${FEED.file}`), false);
  await assert.rejects(updater.download({ fetch: server({ [FEED.file]: Buffer.concat([EXE, EXE]) }), feed, dir: `${dir}/c` }),
    /bigger/);
  assert.deepEqual(fs.readdirSync(`${dir}/c`), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('install runs the installer silently and detached', () => {
  const calls = [];
  updater.install('C:\\tmp\\Aphelion-Setup-1.2.0.exe', (f, args, opts) => {
    calls.push([f, args, opts.detached]);
    return { unref() {} };
  });
  assert.deepEqual(calls[0][1], ['/S', '--updated', '--force-run']);
  assert.equal(calls[0][2], true);
});
