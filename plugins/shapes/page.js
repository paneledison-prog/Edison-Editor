// shape-layer: rectangle, ellipse, or line. Pure function of t (ms).
register('shape-layer', (c, lib) => {
  const p = c.p;
  const sw = p.strokePx * c.u;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', c.W);
  svg.setAttribute('height', c.H);
  Object.assign(svg.style, { position: 'absolute', left: '0', top: '0', overflow: 'visible' });
  c.root.appendChild(svg);
  const g = document.createElementNS(NS, 'g');
  svg.appendChild(g);
  const set = (el, o) => Object.entries(o).forEach(([k, v]) => el.setAttribute(k, v));
  const x = p.x * c.W, y = p.y * c.H;
  let shape, cx, cy, len = 0;
  if (p.shape === 'line') {
    const x2 = p.w * c.W, y2 = p.h * c.H;
    shape = document.createElementNS(NS, 'line');
    set(shape, { x1: x, y1: y, x2, y2, stroke: p.fill, 'stroke-width': Math.max(sw, 1), 'stroke-linecap': 'round' });
    len = Math.hypot(x2 - x, y2 - y);
    cx = (x + x2) / 2; cy = (y + y2) / 2;
  } else {
    const w = p.w * c.W, h = p.h * c.H;
    shape = document.createElementNS(NS, p.shape === 'ellipse' ? 'ellipse' : 'rect');
    if (p.shape === 'ellipse') set(shape, { cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 });
    else set(shape, { x, y, width: w, height: h, rx: (Math.min(w, h) / 2) * p.radius });
    set(shape, { fill: p.fill, stroke: p.stroke, 'stroke-width': sw });
    cx = x + w / 2; cy = y + h / 2;
  }
  g.appendChild(shape);
  c.watch(shape, 'shape', 'frame');
  const f = lib.expr(p.scaleExpr);
  return {
    update(t) {
      const { inP, outP } = lib.life(c, t);
      const sec = t / 1000;
      const sc = f({ t: sec, p: Math.min(1, t / c.durMs), dur: c.durMs / 1000, f: sec * c.fps });
      let tx = '', op = 1 - outP;
      if (p.motion === 'grow') tx = `translate(${cx} ${cy}) scale(${inP}) translate(${-cx} ${-cy})`;
      else if (p.motion === 'pop') {
        const o = 1 + 0.18 * Math.sin(inP * Math.PI);
        tx = `translate(${cx} ${cy}) scale(${inP * o}) translate(${-cx} ${-cy})`;
      } else if (p.motion === 'slide') tx = `translate(${(1 - inP) * -c.W * 0.15} 0)`, op *= inP;
      else if (p.motion === 'draw' && p.shape === 'line') {
        shape.setAttribute('stroke-dasharray', len);
        shape.setAttribute('stroke-dashoffset', len * (1 - inP));
      } else if (p.motion === 'draw') {
        const per = shape.getTotalLength ? shape.getTotalLength() : 1000;
        shape.setAttribute('fill-opacity', inP);
        shape.setAttribute('stroke-dasharray', per);
        shape.setAttribute('stroke-dashoffset', per * (1 - inP));
      }
      const rot = (p.spin * sec) % 360;
      g.setAttribute('transform', `${tx} translate(${cx} ${cy}) rotate(${rot}) scale(${sc}) translate(${-cx} ${-cy})`);
      g.setAttribute('opacity', String(op));
    },
  };
});
