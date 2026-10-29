// Launch Aphelion under Playwright, print console errors, take a screenshot of the window.
import { _electron as electron } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const out = process.argv[2] || '/tmp/aph-shots';
const userData = mkdtempSync(path.join(tmpdir(), 'aph-'));
const app = await electron.launch({
  executablePath: path.resolve('node_modules/electron/dist/electron'),
  args: ['--no-sandbox', `--user-data-dir=${userData}`, '.'],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  timeout: 60000,
});
app.process().stdout.on('data', (d) => process.stdout.write(`[main] ${d}`));
app.process().stderr.on('data', (d) => process.stdout.write(`[main!] ${d}`));
const ui = await app.firstWindow();
ui.on('console', (m) => console.log(`[ui:${m.type()}] ${m.text()}`));
ui.on('pageerror', (e) => console.log(`[ui:error] ${e.message}`));
await ui.waitForTimeout(4000);
console.log('windows:', app.windows().map((w) => w.url()));
await app.evaluate(async ({ BaseWindow }) => BaseWindow.getAllWindows().length).then((n) => console.log('BaseWindows', n));
await app.close();
