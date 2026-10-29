'use strict';
// Where things live on each OS, and Orbit OS integration.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const HOME = os.homedir();
const ORBIT_HOME = path.join(HOME, 'Home');
const isOrbit = () => process.platform === 'linux' && fs.existsSync('/usr/share/orbit-os/tokens.json');

function orbitHome() {
  return fs.existsSync(ORBIT_HOME) ? ORBIT_HOME : null;
}

function downloadsDir(app) {
  const oh = orbitHome();
  if (oh && fs.existsSync(path.join(oh, 'Downloads'))) return path.join(oh, 'Downloads');
  return app.getPath('downloads');
}

function notesFile(app) {
  const oh = orbitHome();
  const dir = oh ? path.join(oh, 'Notes') : path.join(app.getPath('documents'), 'Aphelion');
  return { dir, file: path.join(dir, 'Browser notes.md'), label: oh ? '~/Home/Notes' : dir.replace(HOME, '~') };
}

function defaultVault() {
  const candidates = [path.join(ORBIT_HOME, 'Documents', 'Passwords.kdbx'), path.join(HOME, 'Documents', 'Passwords.kdbx'),
                      path.join(HOME, 'Passwords.kdbx')];
  return candidates.find((p) => fs.existsSync(p)) || '';
}

// Orbit OS style (Glass/Graphite/Light) from GSettings, so "Match Orbit OS" follows the desktop.
function orbitStyle() {
  return new Promise((resolve) => {
    if (process.platform !== 'linux') return resolve(null);
    execFile('gsettings', ['get', 'org.orbit-os.desktop', 'style'], { timeout: 1500 }, (err, out) => {
      if (err) return resolve(null);
      const v = out.trim().replace(/'/g, '');
      resolve({ glass: 'Glass', graphite: 'Graphite', light: 'Light' }[v] || null);
    });
  });
}

function tilde(p) {
  return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}

module.exports = { isOrbit, orbitHome, downloadsDir, notesFile, defaultVault, orbitStyle, tilde };
