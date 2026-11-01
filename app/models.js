// Finds the speech models (bundled with the installer, or in the user's data folder) and
// downloads them on first run when they are missing. ~150 MB, once.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { MODELS } = require('./speech.js');

const BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
const SOURCES = {
  [MODELS.kws]: `${BASE}/kws-models/${MODELS.kws}.tar.bz2`,
  [MODELS.asr]: `${BASE}/asr-models/${MODELS.asr}.tar.bz2`,
  [MODELS.tts]: `${BASE}/tts-models/${MODELS.tts}.tar.bz2`,
};
const has = (dir) => Object.keys(SOURCES).every((m) => fs.existsSync(path.join(dir, m)));

function locate(candidates) { return candidates.find((d) => d && has(d)) || null; }

async function download(dir, onProgress = () => {}) {
  fs.mkdirSync(dir, { recursive: true });
  const names = Object.keys(SOURCES).filter((m) => !fs.existsSync(path.join(dir, m)));
  for (const [i, name] of names.entries()) {
    const res = await fetch(SOURCES[name]);
    if (!res.ok) throw new Error(`Download failed for ${name}: ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const tmp = path.join(os.tmpdir(), `${name}.tar.bz2`);
    const out = fs.createWriteStream(tmp);
    let got = 0;
    for await (const chunk of res.body) { got += chunk.length; out.write(chunk); onProgress({ name, index: i, count: names.length, fraction: total ? got / total : 0 }); }
    await new Promise((r) => out.end(r));
    // bsdtar/GNU tar handle .tar.bz2 on Windows 10+, macOS and Linux.
    await new Promise((resolve, reject) => execFile('tar', ['-xjf', tmp, '-C', dir], (e) => (e ? reject(e) : resolve())));
    fs.unlinkSync(tmp);
  }
  return dir;
}

module.exports = { locate, download, has };

// `npm run models` downloads into ./models for development and for bundling into installers.
if (require.main === module) {
  const dir = path.resolve(__dirname, '..', 'models');
  download(dir, ({ name, fraction }) => process.stdout.write(`\r${name} ${(fraction * 100).toFixed(0)}%   `)).then(() => console.log(`\nModels ready in ${dir}`));
}
