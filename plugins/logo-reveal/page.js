// logo-reveal: image or wordmark, reveal by wipe / zoom / sweep, accent line, light sweep.
register('logo-reveal', (c, lib) => {
  const p = c.p, u = c.u;
  const wrap = lib.h('div', { left: '0', top: '0', width: c.W + 'px', height: c.H + 'px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }, undefined, c.root);
  const mark = lib.h('div', { position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }, undefined, wrap);
  let body;
  if (p.logo) {
    body = document.createElement('img');
    body.src = p.logo;
    Object.assign(body.style, { maxWidth: 0.5 * c.W + 'px', maxHeight: 0.35 * c.H + 'px', position: 'relative', display: 'block' });
    mark.appendChild(body);
  } else {
    body = lib.h('div', { position: 'relative', color: p.color, font: `800 ${140 * u}px/1.05 "${c.family}"`, letterSpacing: 6 * u + 'px', whiteSpace: 'nowrap', padding: `${10 * u}px ${24 * u}px` }, p.text || 'STUDIO', mark);
  }
  const line = lib.h('div', { position: 'relative', height: 6 * u + 'px', width: '0px', background: p.accent, borderRadius: 3 * u + 'px', marginTop: 22 * u + 'px' }, undefined, wrap);
  const tag = p.tagline ? lib.h('div', { position: 'relative', color: p.color, opacity: '0', font: `500 ${40 * u}px "${c.family}"`, marginTop: 20 * u + 'px' }, p.tagline, wrap) : null;
  const sweep = lib.h('div', { top: '0', bottom: '0', width: '22%', background: `linear-gradient(100deg, transparent, ${p.accent}88, transparent)`, mixBlendMode: 'screen' }, undefined, mark);
  c.watch(mark, 'logo', 'safe');
  return {
    update(t) {
      const { inP, outP } = lib.life(c, t);
      const a = 1 - outP;
      const reveal = lib.ramp(t, 0, Math.max(300, p.entranceMs * 2), 'expo.out');
      if (p.style === 'wipe') {
        mark.style.clipPath = `inset(0 ${(1 - reveal) * 100}% 0 0)`;
        mark.style.transform = 'none';
      } else if (p.style === 'zoom') {
        mark.style.clipPath = 'none';
        mark.style.transform = `scale(${0.6 + 0.4 * reveal})`;
        body.style.opacity = String(reveal);
      } else {
        mark.style.clipPath = `inset(0 0 ${(1 - reveal) * 100}% 0)`;
      }
      mark.style.opacity = String(a);
      line.style.width = reveal * 0.4 * c.W * 0.5 + 'px';
      line.style.opacity = String(a);
      if (tag) tag.style.opacity = String(lib.ramp(t, p.entranceMs, p.entranceMs, 'cubic.out') * a);
      const s = lib.ramp(t, p.entranceMs * 0.5, p.entranceMs * 3, 'sine.inOut');
      sweep.style.left = -30 + s * 140 + '%';
      sweep.style.opacity = String(s > 0 && s < 1 ? 1 : 0);
    },
  };
});
