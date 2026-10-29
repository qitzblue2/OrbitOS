// Bundle the tab preload with its dependencies (sandboxed preloads can only require 'electron').
import { build } from 'esbuild';

await build({
  entryPoints: { 'tab-preload': 'src/preload/tab.js' },
  outdir: 'dist-bundle',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'chrome130',
  external: ['electron'],
  legalComments: 'eof',
  logLevel: 'info',
});
