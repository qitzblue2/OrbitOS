'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const platform = require('../../src/main/platform');

test('Orbit Focus: sites are kept away only while a session runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aph-focus-'));
  const f = path.join(dir, 'focus.json');
  assert.deepEqual(platform.focusSites(1000, f), []);   // no file: no focus
  fs.writeFileSync(f, JSON.stringify({ until: 2000, sites: ['youtube.com', 'bad host!', 'reddit.com'] }));
  assert.deepEqual(platform.focusSites(1000, f), ['youtube.com', 'reddit.com']);
  assert.deepEqual(platform.focusSites(3000, f), []);    // ran out
  assert.ok(platform.focusBlocks('m.youtube.com', ['youtube.com']));
  assert.ok(!platform.focusBlocks('notyoutube.com', ['youtube.com']));
  fs.rmSync(dir, { recursive: true, force: true });
});
