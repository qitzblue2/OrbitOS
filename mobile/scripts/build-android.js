// Builds the ORBIT Android app (debug-signed .apk you can install directly).
//   ORBIT_URL=https://orbitos.xdevstudios.net npm run android
// Needs Java 17 and the Android SDK (both present on GitHub's ubuntu runners).
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const dir = path.resolve(__dirname, '..');
const url = (process.env.ORBIT_URL || 'https://orbitos.xdevstudios.net').replace(/\/$/, '');
if (!/^https:\/\//.test(url)) throw new Error('ORBIT_URL must be an https:// address (phones need https for the microphone).');
const host = new URL(url).host;
const run = (cmd, cwd = dir) => { console.log(`$ ${cmd}`); execSync(cmd, { cwd, stdio: 'inherit' }); };

fs.writeFileSync(path.join(dir, 'capacitor.config.json'), JSON.stringify({
  appId: 'net.xdevstudios.orbit',
  appName: 'ORBIT',
  webDir: 'www',
  server: { url, cleartext: false, allowNavigation: [host], errorPath: 'index.html' },
  android: { backgroundColor: '#03060d' },
}, null, 2));

if (!fs.existsSync(path.join(dir, 'android'))) run('npx cap add android');
run('npx cap sync android');

// Microphone access for ORBIT's voice (the WebView asks Android for it when ORBIT turns the mic on).
const manifest = path.join(dir, 'android/app/src/main/AndroidManifest.xml');
let xml = fs.readFileSync(manifest, 'utf8');
for (const perm of ['android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS']) {
  if (!xml.includes(perm)) xml = xml.replace('<application', `<uses-permission android:name="${perm}" />\n    <application`);
}
fs.writeFileSync(manifest, xml);

// App icon: ORBIT's icon at every Android density.
const icon = path.resolve(dir, '..', 'web/icons/icon-512.png');
const res = path.join(dir, 'android/app/src/main/res');
for (const d of fs.readdirSync(res).filter((x) => x.startsWith('mipmap-'))) {
  for (const f of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
    const target = path.join(res, d, f);
    if (fs.existsSync(target)) fs.copyFileSync(icon, target);
  }
}

run(process.platform === 'win32' ? 'gradlew.bat assembleDebug' : './gradlew assembleDebug --no-daemon', path.join(dir, 'android'));
const apk = path.join(dir, 'android/app/build/outputs/apk/debug/app-debug.apk');
const out = path.join(dir, 'ORBIT-android.apk');
fs.copyFileSync(apk, out);
console.log(`\nBuilt ${out} for ${url}`);
