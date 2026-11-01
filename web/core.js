// The ORBIT core: a canvas visualisation of the assistant's state and live audio level.
const STATES = {
  idle:       { hue: [56, 232, 255], speed: 0.25, energy: 0.15, label: 'Standing by' },
  listening:  { hue: [56, 232, 255], speed: 0.6,  energy: 0.6,  label: 'Listening' },
  processing: { hue: [90, 150, 255], speed: 1.6,  energy: 0.5,  label: 'Processing' },
  speaking:   { hue: [80, 220, 255], speed: 0.9,  energy: 0.8,  label: 'Speaking' },
  executing:  { hue: [62, 230, 160], speed: 1.2,  energy: 0.6,  label: 'Executing' },
  error:      { hue: [255, 95, 109], speed: 0.15, energy: 0.3,  label: 'Error' },
  muted:      { hue: [110, 130, 160], speed: 0.1, energy: 0.05, label: 'Mic off' },
};
export const stateLabel = (s) => (STATES[s] || STATES.idle).label;

export class Core {
  constructor(canvas, { mini = false } = {}) {
    this.c = canvas; this.g = canvas.getContext('2d'); this.mini = mini;
    this.state = 'idle'; this.level = 0; this.t = 0; this.mix = { ...STATES.idle, hue: [...STATES.idle.hue] };
    this.particles = Array.from({ length: mini ? 0 : 70 }, () => ({ a: Math.random() * Math.PI * 2, r: 0.55 + Math.random() * 0.4, s: 0.2 + Math.random() * 0.8, z: Math.random() }));
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ro = new ResizeObserver(() => this.resize()); ro.observe(canvas); this.resize();
    this.loop = this.loop.bind(this); requestAnimationFrame(this.loop);
  }
  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2), r = this.c.getBoundingClientRect();
    this.w = this.c.width = Math.max(1, r.width * dpr); this.h = this.c.height = Math.max(1, r.height * dpr);
  }
  setState(s) { this.state = STATES[s] ? s : 'idle'; }
  setLevel(v) { this.level = Math.max(0, Math.min(1, v)); }
  loop(now) {
    const target = STATES[this.state];
    const k = 0.06; // ease between states
    this.mix.speed += (target.speed - this.mix.speed) * k;
    this.mix.energy += (target.energy - this.mix.energy) * k;
    this.mix.hue = this.mix.hue.map((v, i) => v + (target.hue[i] - v) * k);
    this.t += (this.reduced ? 0.2 : 1) * 0.016 * this.mix.speed;
    this.draw();
    requestAnimationFrame(this.loop);
  }
  draw() {
    const { g, w, h, t } = this, cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.46;
    const [r, gr, b] = this.mix.hue.map(Math.round), col = (a) => `rgba(${r},${gr},${b},${a})`;
    const lv = this.level, e = this.mix.energy;
    g.clearRect(0, 0, w, h);

    // halo
    const halo = g.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
    halo.addColorStop(0, col(0.22 + lv * 0.25)); halo.addColorStop(0.45, col(0.06)); halo.addColorStop(1, col(0));
    g.fillStyle = halo; g.beginPath(); g.arc(cx, cy, R, 0, 7); g.fill();

    // particles drifting in orbit
    for (const p of this.particles) {
      const a = p.a + t * p.s * 0.6, rr = R * p.r;
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.42;
      g.fillStyle = col(0.15 + p.z * 0.5 * (0.5 + e)); g.fillRect(x, y, 1.6 * devicePixelRatio, 1.6 * devicePixelRatio);
    }

    // tilted orbit rings with satellites
    const rings = this.mini ? [[0.78, -0.38, 1]] : [[0.92, -0.38, 1], [0.74, 0.5, -1.4], [0.6, -0.9, 0.8]];
    g.lineWidth = Math.max(1, R * 0.006);
    rings.forEach(([rad, tilt, dir], i) => {
      g.save(); g.translate(cx, cy); g.rotate(tilt);
      g.strokeStyle = col(0.18 + e * 0.25); g.beginPath(); g.ellipse(0, 0, R * rad, R * rad * 0.34, 0, 0, 7); g.stroke();
      const a = t * dir * (1 + i * 0.3) + i * 2;
      const sx = Math.cos(a) * R * rad, sy = Math.sin(a) * R * rad * 0.34;
      g.fillStyle = col(0.95); g.shadowColor = col(1); g.shadowBlur = R * 0.06;
      g.beginPath(); g.arc(sx, sy, R * (this.mini ? 0.06 : 0.018), 0, 7); g.fill();
      g.restore();
    });

    if (!this.mini) {
      // state-specific instrument layer
      g.save(); g.translate(cx, cy);
      if (this.state === 'listening' || this.state === 'speaking') {
        const n = 72;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const wave = this.state === 'speaking' ? (Math.sin(t * 9 + i * 0.5) * 0.5 + 0.5) * 0.6 : 0;
          const amp = R * (0.04 + (lv * (0.7 + 0.3 * Math.sin(i * 1.7 + t * 6)) + wave) * 0.16);
          const r0 = R * 0.42;
          g.strokeStyle = col(0.35 + lv * 0.5);
          g.beginPath(); g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); g.lineTo(Math.cos(a) * (r0 + amp), Math.sin(a) * (r0 + amp)); g.stroke();
        }
      } else if (this.state === 'processing') {
        for (let i = 0; i < 3; i++) {
          g.strokeStyle = col(0.7 - i * 0.18); g.lineWidth = R * 0.012;
          g.beginPath(); g.arc(0, 0, R * (0.46 + i * 0.06), t * (3 - i) * (i % 2 ? -1 : 1), t * (3 - i) * (i % 2 ? -1 : 1) + 1.4); g.stroke();
        }
      } else if (this.state === 'executing') {
        const a = t * 4;
        const sweep = g.createConicGradient ? g.createConicGradient(a, 0, 0) : null;
        if (sweep) { sweep.addColorStop(0, col(0.35)); sweep.addColorStop(0.15, col(0)); sweep.addColorStop(1, col(0)); g.fillStyle = sweep; g.beginPath(); g.arc(0, 0, R * 0.58, 0, 7); g.fill(); }
      }
      // tick ring
      g.strokeStyle = col(0.22); g.lineWidth = 1;
      for (let i = 0; i < 120; i++) { const a = (i / 120) * Math.PI * 2 + t * 0.05; const l = i % 10 ? 0.012 : 0.03; g.beginPath(); g.moveTo(Math.cos(a) * R * 0.86, Math.sin(a) * R * 0.86); g.lineTo(Math.cos(a) * R * (0.86 + l), Math.sin(a) * R * (0.86 + l)); g.stroke(); }
      g.restore();
    }

    // the core sphere
    const pulse = 1 + Math.sin(t * (this.state === 'processing' ? 8 : 2)) * 0.03 * (0.4 + e) + lv * 0.12;
    const cr = R * (this.mini ? 0.36 : 0.26) * pulse;
    const sph = g.createRadialGradient(cx - cr * 0.35, cy - cr * 0.4, cr * 0.05, cx, cy, cr);
    sph.addColorStop(0, 'rgba(255,255,255,0.95)'); sph.addColorStop(0.25, col(0.95)); sph.addColorStop(0.7, `rgba(${Math.round(r * 0.3)},${Math.round(gr * 0.35)},${Math.round(b * 0.7)},0.95)`); sph.addColorStop(1, 'rgba(2,6,16,0.9)');
    g.shadowColor = col(0.8); g.shadowBlur = cr * (0.6 + lv);
    g.fillStyle = sph; g.beginPath(); g.arc(cx, cy, cr, 0, 7); g.fill(); g.shadowBlur = 0;
  }
}
