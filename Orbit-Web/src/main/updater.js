'use strict';
// One-click updates for Aphelion on Windows.
//
// The Orbit update server (built by OrbitOS/.github/workflows/orbit-updates.yml) publishes
// aphelion/windows/latest.json on GitHub Pages; the installer itself is a GitHub release asset:
//   { "version": "1.2.0", "file": "Aphelion-Setup-1.2.0.exe", "sha256": "…", "size": 123,
//     "url": "https://github.com/qitzblue2/OrbitOS/releases/download/aphelion-v1.2.0/Aphelion-Setup-1.2.0.exe" }
// Update: download the installer to a temp folder, check its size and SHA-256 against the
// feed, run it silently (it closes Aphelion, installs, and starts it again), and quit.
// On Orbit OS, Aphelion is a .deb and updates with the rest of the system (Orbit Updater).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');

const FEED = 'https://qitzblue2.github.io/OrbitOS/aphelion/windows/latest.json';
const RELEASES = 'https://github.com/qitzblue2/OrbitOS/releases/download/';

function isNewer(latest, current) {
  const a = String(latest).split('.').map(Number);
  const b = String(current).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

function validateFeed(j) {
  if (!j || typeof j !== 'object') throw new Error('the update server sent something unexpected');
  if (!/^\d{1,4}(\.\d{1,6}){1,3}$/.test(j.version || '')) throw new Error('bad version in the update feed');
  if (!/^Aphelion-Setup-[\d.]+\.exe$/.test(j.file || '')) throw new Error('bad file name in the update feed');
  if (!/^[0-9a-f]{64}$/.test(j.sha256 || '')) throw new Error('bad checksum in the update feed');
  if (!Number.isInteger(j.size) || j.size < 1e6 || j.size > 1e9) throw new Error('bad size in the update feed');
  const url = `${RELEASES}aphelion-v${j.version}/${j.file}`;   // only ever this repository's own releases
  if (j.url !== undefined && j.url !== url) throw new Error('the update feed points somewhere unexpected');
  return { version: j.version, file: j.file, sha256: j.sha256, size: j.size, url };
}

/** -> { status: 'available'|'current'|'managed'|'error', text, feed? } */
async function check({ fetch, current, platform, orbit }) {
  if (orbit) return { status: 'managed', text: 'Aphelion updates with Orbit OS: open Orbit Updater.' };
  if (platform !== 'win32') return { status: 'managed', text: 'Updates come from your system’s package manager.' };
  try {
    const res = await fetch(`${FEED}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`the update server said ${res.status}`);
    const feed = validateFeed(await res.json());
    return isNewer(feed.version, current)
      ? { status: 'available', text: `Version ${feed.version} is available`, feed }
      : { status: 'current', text: `Up to date (${current})` };
  } catch (e) {
    return { status: 'error', text: `Couldn’t check: ${e.message}` };
  }
}

/** Download and verify. onProgress(fraction). -> path of the checked installer */
async function download({ fetch, feed, dir, onProgress = () => {} }) {
  const res = await fetch(feed.url, { cache: 'no-store' });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, feed.file);
  const part = `${target}.part`;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(part);
  let werr = null;
  out.on('error', (e) => { werr = e; });   // reported below; never an uncaught error in the main process
  await once(out, 'open');
  let got = 0;
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      if (got > feed.size) throw new Error('the download is bigger than announced');
      hash.update(chunk);
      if (werr) throw werr;
      if (!out.write(chunk)) await once(out, 'drain');
      onProgress(got / feed.size);
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (e) {
    const closed = once(out, 'close');
    out.destroy();
    await closed;
    fs.rmSync(part, { force: true });
    throw e;
  }
  if (got !== feed.size || hash.digest('hex') !== feed.sha256) {
    fs.rmSync(part, { force: true });
    throw new Error('the download was damaged; nothing was installed');
  }
  fs.renameSync(part, target);
  return target;
}

/** Start the silent installer detached; the caller quits Aphelion right after. */
function install(file, spawn) {
  // electron-builder NSIS: /S silent, --updated (keep settings, no welcome), --force-run (start Aphelion after)
  const child = spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

module.exports = { FEED, isNewer, validateFeed, check, download, install };
