// Download the filter lists shipped with Aphelion and precompile them (npm run lists).
// Bundling them means blocking works offline from first launch; Settings > Privacy can
// refresh them later (only when you click).
import { writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { LISTS } from './fetch-lists-data.mjs';

const { FiltersEngine } = createRequire(import.meta.url)('@ghostery/adblocker');
const dir = new URL('../assets/lists/', import.meta.url);
await mkdir(dir, { recursive: true });
const manifest = {};
for (const [key, [name, url]] of Object.entries(LISTS)) {
  const res = await fetch(url, { headers: { 'user-agent': 'Aphelion-build/1.0' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('[Adblock') && !text.startsWith('!')) throw new Error(`${url}: not a filter list`);
  await writeFile(new URL(`${key}.txt`, dir), text);
  const engine = FiltersEngine.parse(text, { loadCosmeticFilters: key !== 'trackers' });
  await writeFile(new URL(`${key}.bin`, dir), engine.serialize());
  manifest[key] = { name, url, bytes: text.length, rules: text.split('\n').filter((l) => l && !l.startsWith('!')).length,
                    sha256: createHash('sha256').update(text).digest('hex'), fetched: new Date().toISOString() };
  console.log(`${key.padEnd(10)} ${manifest[key].rules} rules  ${(text.length / 1e6).toFixed(1)} MB`);
}
await writeFile(new URL('manifest.json', dir), JSON.stringify(manifest, null, 1));
