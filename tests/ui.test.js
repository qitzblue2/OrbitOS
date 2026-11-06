// Opens every dashboard screen in a real browser and fails on any page error, and adds an
// AI key through the form, like a person would. Skipped when Playwright isn't installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

let chromium = null;
for (const from of [import.meta.url, '/opt/node-tools/x.js']) { try { ({ chromium } = createRequire(from)('playwright')); break; } catch {} }

test('every screen renders without errors, and adding an AI key works', { skip: !chromium && 'Playwright not installed' }, async () => {
  process.env.ORBIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-ui-'));
  process.env.ORBIT_ENV_FILE = path.join(process.env.ORBIT_DATA_DIR, '.env');
  process.env.ANTHROPIC_API_KEY = '';
  const { config } = await import('../server/config.js');
  const { createOrbit } = await import('../server/index.js');
  const orbit = createOrbit(config);
  const { port } = await orbit.listen(0, '127.0.0.1');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|net::ERR/.test(m.text())) errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${port}/#dashboard?token=${config.adminToken}`);
    await page.waitForSelector('#nav button');
    for (const view of ['dashboard', 'conversations', 'devices', 'automations', 'memory', 'integrations', 'voice', 'ai', 'security']) {
      await page.evaluate((v) => { location.hash = v; }, view);
      await page.click(`#nav button[title]:nth-child(1)`, { trial: true }).catch(() => {});
      await page.evaluate((v) => [...document.querySelectorAll('#nav button')].find((b) => b.title && b.textContent.trim().length && b.getAttribute('title') === ({ dashboard: 'Dashboard', conversations: 'Conversations', devices: 'Devices', automations: 'Automations', memory: 'Memory', integrations: 'Integrations', voice: 'Voice', ai: 'AI configuration', security: 'Security' })[v])?.click(), view);
      await page.waitForTimeout(400);
      assert.ok((await page.textContent('#view')).trim().length > 0, `${view} is empty`);
    }
    // Add a key through the AI configuration form
    await page.evaluate(() => [...document.querySelectorAll('#nav button')].find((b) => b.title === 'AI configuration').click());
    await page.waitForSelector('#k-prov');
    await page.selectOption('#k-prov', 'groq');
    await page.fill('#k-key', 'gsk_' + 'u'.repeat(30));
    await page.click('button:has-text("Add key")');
    await page.waitForFunction(() => /Groq/.test(document.querySelector('#view').textContent) && /••••uuuu/.test(document.querySelector('#view').textContent), null, { timeout: 5000 });
    await page.fill('#ai-instr', 'Be brief.');
    await page.click('.panel:has(h2:text("Personality")) button:has-text("Save")');
    await page.waitForTimeout(300);
    assert.equal(orbit.engine.settings.data.customInstructions, 'Be brief.');
    assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  } finally { await browser.close(); await orbit.close(); }
});
