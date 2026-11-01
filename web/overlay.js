import { Core, stateLabel } from './core.js';
const core = new Core(document.getElementById('orb'), { mini: true });
const phase = document.getElementById('phase'), line = document.getElementById('line');
window.orbitOverlay?.on((d) => {
  if (d.phase) { core.setState(d.phase); phase.textContent = stateLabel(d.phase); }
  if (d.heard !== undefined && d.heard) line.textContent = `“${d.heard}”`;
  if (d.reply) line.textContent = d.reply;
  if (d.level !== undefined) core.setLevel(d.level);
});
document.getElementById('open').addEventListener('click', () => window.orbitOverlay?.open());
document.getElementById('stop').addEventListener('click', () => window.orbitOverlay?.stop());
