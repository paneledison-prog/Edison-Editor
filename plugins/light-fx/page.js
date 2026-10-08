// particles, saber, lens-flare: additive 2D canvas drawing. No Math.random: lib.rand(seed, i) is seeded.
const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
};

register('particles', (c, lib) => {
  const p = c.p, { el, g } = lib.canvas(c);
  const N = Math.round(p.count), life = p.lifeMs;
  const dir = (p.direction * Math.PI) / 180, spread = (p.spread * Math.PI) / 180;
  return {
    update(t) {
      const { a } = lib.life(c, t);
      g.clearRect(0, 0, c.W, c.H);
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < N; i++) {
        // stream: births spread over the clip; burst: every particle is born at 0
        const birth = p.mode === 'burst' ? 0 : (i / N) * Math.max(1, c.durMs - life);
        const age = t - birth;
        if (age < 0 || age > life) continue;
        const k = age / life, s = age / 1000;
        const ang = dir + (lib.rand(p.seed, i * 3) - 0.5) * spread;
        const v = p.speed * c.u * (0.4 + 0.6 * lib.rand(p.seed, i * 3 + 1));
        const px = p.x * c.W + Math.cos(ang) * v * s;
        const py = p.y * c.H + Math.sin(ang) * v * s + 0.5 * p.gravity * c.u * s * s;
        const r = p.size * c.u * (0.5 + lib.rand(p.seed, i * 3 + 2)) * (1 - k * 0.6);
        const al = (1 - k) * a;
        const gr = g.createRadialGradient(px, py, 0, px, py, r * 3);
        gr.addColorStop(0, hexA(p.color, al));
        gr.addColorStop(0.35, hexA(p.color, al * 0.5));
        gr.addColorStop(1, hexA(p.color, 0));
        g.fillStyle = gr;
        g.fillRect(px - r * 3, py - r * 3, r * 6, r * 6);
      }
    },
  };
});

register('saber', (c, lib) => {
  const p = c.p, { g } = lib.canvas(c);
  const x1 = p.x1 * c.W, y1 = p.y1 * c.H, x2 = p.x2 * c.W, y2 = p.y2 * c.H;
  return {
    update(t) {
      const { inP, outP } = lib.life(c, t);
      g.clearRect(0, 0, c.W, c.H);
      const fl = 1 - p.flicker * (0.5 + 0.5 * lib.noise(t / 40, 7));
      const draw = Math.max(0, Math.min(1, inP)) * (1 - outP);
      const ex = x1 + (x2 - x1) * inP, ey = y1 + (y2 - y1) * inP;
      g.globalCompositeOperation = 'lighter';
      g.lineCap = 'round';
      const layers = [[p.glow * c.u, 0.12], [p.glow * 0.5 * c.u, 0.22], [p.glow * 0.2 * c.u, 0.4]];
      for (const [w, al] of layers) {
        g.strokeStyle = hexA(p.color, al * fl * (1 - outP));
        g.lineWidth = p.widthPx * c.u + w;
        g.beginPath(); g.moveTo(x1, y1); g.lineTo(ex, ey); g.stroke();
      }
      g.strokeStyle = hexA(p.color, fl * (1 - outP));
      g.lineWidth = p.widthPx * c.u * 1.4;
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(ex, ey); g.stroke();
      g.strokeStyle = hexA(p.core, fl * (1 - outP));
      g.lineWidth = p.widthPx * c.u * 0.55;
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(ex, ey); g.stroke();
      if (draw > 0) {
        const gr = g.createRadialGradient(ex, ey, 0, ex, ey, p.glow * c.u);
        gr.addColorStop(0, hexA(p.core, 0.9 * fl * (1 - outP)));
        gr.addColorStop(1, hexA(p.color, 0));
        g.fillStyle = gr;
        g.fillRect(ex - p.glow * c.u, ey - p.glow * c.u, p.glow * c.u * 2, p.glow * c.u * 2);
      }
    },
  };
});

register('lens-flare', (c, lib) => {
  const p = c.p, { g } = lib.canvas(c);
  const cx = c.W / 2, cy = c.H / 2;
  const ghosts = [[0.35, 0.05], [0.6, 0.09], [0.9, 0.03], [1.25, 0.12], [1.6, 0.06]];
  return {
    update(t) {
      const { a } = lib.life(c, t);
      const k = c.durMs ? t / c.durMs : 0;
      const lx = (p.x + p.sweep * (k - 0.5)) * c.W, ly = p.y * c.H;
      g.clearRect(0, 0, c.W, c.H);
      g.globalCompositeOperation = 'lighter';
      const I = p.intensity * a;
      const R = Math.min(c.W, c.H);
      const core = g.createRadialGradient(lx, ly, 0, lx, ly, R * 0.22);
      core.addColorStop(0, hexA('#ffffff', I));
      core.addColorStop(0.15, hexA(p.color, I * 0.7));
      core.addColorStop(1, hexA(p.color, 0));
      g.fillStyle = core;
      g.fillRect(lx - R * 0.22, ly - R * 0.22, R * 0.44, R * 0.44);
      if (p.streak) {
        const st = g.createLinearGradient(lx - c.W * 0.5, ly, lx + c.W * 0.5, ly);
        st.addColorStop(0, hexA(p.color, 0));
        st.addColorStop(0.5, hexA(p.color, I * 0.55));
        st.addColorStop(1, hexA(p.color, 0));
        g.fillStyle = st;
        g.fillRect(lx - c.W * 0.5, ly - 3 * c.u, c.W, 6 * c.u);
      }
      for (const [d, s] of ghosts) {
        const gx = lx + (cx - lx) * d * 2, gy = ly + (cy - ly) * d * 2, r = R * s;
        const gr = g.createRadialGradient(gx, gy, 0, gx, gy, r);
        gr.addColorStop(0, hexA(p.color, I * 0.0));
        gr.addColorStop(0.7, hexA(p.color, I * 0.18));
        gr.addColorStop(1, hexA(p.color, 0));
        g.fillStyle = gr;
        g.fillRect(gx - r, gy - r, r * 2, r * 2);
      }
    },
  };
});
