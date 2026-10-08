/**
 * Browser side of the motion renderer. Everything is a pure function of the frame number: no CSS transitions or
 * animations, no timers, no clock, no randomness. The renderer calls `studio.render(frame)` and then screenshots.
 */
import { safeZoneFor } from '@studio/core/captions';
import { easeFn, ramp } from './ease';

interface FontIn {
  family: string;
  weight: string;
  data: string; // base64
}
interface InitArgs {
  comp: string;
  props: Record<string, any>;
  width: number;
  height: number;
  fps: number;
  durMs: number;
  fonts: FontIn[];
  family: string;
  /** Paint a checkerboard behind the frame, for looking at alpha: the two square colors (from the palette) */
  checker?: [string, string];
}
interface Ctx {
  root: HTMLElement;
  W: number;
  H: number;
  /** pixels per design unit: 1 at 1080 px on the short side */
  u: number;
  fps: number;
  durMs: number;
  p: Record<string, any>;
  safe: { l: number; r: number; t: number; b: number };
  family: string;
  watch: (el: HTMLElement | SVGElement, label: string, within?: 'frame' | 'safe') => void;
  warn: (message: string) => void;
}
interface Instance {
  update: (t: number) => void;
}

const h = (
  tag: string,
  css: Partial<CSSStyleDeclaration> | Record<string, string>,
  text?: string,
  parent?: Element,
) => {
  const e = document.createElement(tag);
  Object.assign(e.style, { position: 'absolute', margin: '0', boxSizing: 'border-box', ...css });
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
};
const px = (n: number) => `${n}px`;
const paint = (c: string) => c;

function fit(el: HTMLElement, maxW: number, minScale = 0.6): void {
  const w = el.scrollWidth;
  if (w > maxW) {
    const base = parseFloat(el.style.fontSize);
    el.style.fontSize = px(Math.max(base * minScale, (base * maxW) / w));
  }
}

/** Opacity from entrance and exit windows. */
function life(c: Ctx, t: number) {
  const inP = ramp(t, 0, c.p['entranceMs'], c.p['ease']);
  const outP = ramp(t, c.durMs - c.p['exitMs'], c.p['exitMs'], c.p['exitEase']);
  return { inP, outP, a: inP * (1 - outP) };
}

const T: Record<string, (c: Ctx) => Instance> = {
  'lower-third'(c) {
    const { u, W, H, p } = c;
    const left = p['align'] === 'left';
    const wrap = h('div', { left: '0', top: '0', width: px(W), height: px(H) }, undefined, c.root);
    const bottom = H - (c.safe.b + 0.03 * H);
    const panel = h(
      'div',
      {
        background: paint(p['background']),
        padding: `${22 * u}px ${34 * u}px ${22 * u}px ${34 * u}px`,
        borderRadius: px(6 * u),
        overflow: 'hidden',
      },
      undefined,
      wrap,
    );
    panel.style.position = 'absolute';
    const bar = h(
      'div',
      { width: px(9 * u), background: p['accent'], borderRadius: px(3 * u) },
      undefined,
      wrap,
    );
    const title = h(
      'div',
      {
        position: 'relative',
        color: p['color'],
        font: `700 ${46 * u}px/1.1 "${c.family}"`,
        whiteSpace: 'nowrap',
      },
      p['title'],
      panel,
    );
    const sub = p['subtitle']
      ? h(
          'div',
          {
            position: 'relative',
            color: p['subtitleColor'],
            font: `400 ${29 * u}px/1.2 "${c.family}"`,
            whiteSpace: 'nowrap',
            marginTop: px(8 * u),
          },
          p['subtitle'],
          panel,
        )
      : null;
    const maxW = (W - c.safe.l - c.safe.r) * (W > H ? 0.6 : 0.9) - 70 * u;
    fit(title, maxW);
    if (sub) fit(sub, maxW);
    const pw = Math.max(title.scrollWidth, sub?.scrollWidth ?? 0) + 68 * u;
    const ph = title.offsetHeight + (sub ? sub.offsetHeight + 8 * u : 0) + 44 * u;
    const barW = 9 * u;
    const gap = 14 * u;
    const x0 = left ? c.safe.l : W - c.safe.r - (pw + barW + gap);
    Object.assign(panel.style, { width: px(pw), height: px(ph) });
    Object.assign(bar.style, { height: px(ph) });
    c.watch(panel, 'lower-third panel', 'safe');
    return {
      update(t) {
        const { inP, outP, a } = life(c, t);
        const slide = (1 - inP) * -50 * u + outP * -24 * u;
        const bx = x0 + (left ? 0 : pw + gap);
        const px0 = x0 + (left ? barW + gap : 0);
        Object.assign(bar.style, {
          left: px(bx),
          top: px(bottom - ph),
          opacity: String(a),
          transform: `scaleY(${ramp(t, 0, p['entranceMs'] * 0.7, p['ease']) * (1 - outP)})`,
          transformOrigin: 'bottom',
        });
        Object.assign(panel.style, {
          left: px(px0 + slide),
          top: px(bottom - ph),
          opacity: String(a),
          clipPath: `inset(0 ${(1 - ramp(t, p['entranceMs'] * 0.15, p['entranceMs'], p['ease'])) * 100}% 0 0)`,
        });
        if (sub)
          sub.style.transform = `translateX(${(1 - ramp(t, 80, p['entranceMs'], p['ease'])) * -24 * u}px)`;
      },
    };
  },

  title(c) {
    const { u, W, H, p } = c;
    const center = p['align'] === 'center';
    const box = h(
      'div',
      {
        left: px(c.safe.l),
        width: px(W - c.safe.l - c.safe.r),
        top: '0',
        height: px(H),
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: center ? 'center' : 'flex-start',
        textAlign: center ? 'center' : 'left',
      },
      undefined,
      c.root,
    );
    box.style.position = 'absolute';
    const row = h(
      'div',
      {
        position: 'relative',
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: center ? 'center' : 'flex-start',
        gap: `0 ${0.28 * 92 * u}px`,
        font: `700 ${92 * u}px/1.1 "${c.family}"`,
        color: p['color'],
      },
      undefined,
      box,
    );
    const words = String(p['title'])
      .split(/\s+/)
      .map((w) => h('span', { position: 'relative', display: 'inline-block' }, w, row));
    const rule = h(
      'div',
      {
        position: 'relative',
        height: px(6 * u),
        width: px(160 * u),
        background: p['accent'],
        marginTop: px(26 * u),
        borderRadius: px(3 * u),
        transformOrigin: center ? 'center' : 'left',
      },
      undefined,
      box,
    );
    const sub = p['subtitle']
      ? h(
          'div',
          {
            position: 'relative',
            marginTop: px(24 * u),
            font: `400 ${40 * u}px/1.25 "${c.family}"`,
            color: p['subtitleColor'],
          },
          p['subtitle'],
          box,
        )
      : null;
    c.watch(row, 'title', 'safe');
    if (sub) c.watch(sub, 'subtitle', 'safe');
    return {
      update(t) {
        const outP = ramp(t, c.durMs - p['exitMs'], p['exitMs'], p['exitEase']);
        words.forEach((w, i) => {
          const k = ramp(t, i * p['staggerMs'], p['entranceMs'], p['ease']);
          w.style.opacity = String(k * (1 - outP));
          w.style.transform = `translateY(${(1 - k) * 36 * u + outP * 14 * u}px)`;
        });
        const rk = ramp(t, words.length * p['staggerMs'] * 0.5, p['entranceMs'], p['ease']);
        rule.style.transform = `scaleX(${rk})`;
        rule.style.opacity = String(1 - outP);
        if (sub) {
          const k = ramp(t, 120 + words.length * p['staggerMs'], p['entranceMs'], p['ease']);
          sub.style.opacity = String(k * (1 - outP));
          sub.style.transform = `translateY(${(1 - k) * 20 * u}px)`;
        }
      },
    };
  },

  callout(c) {
    const { u, W, H, p } = c;
    const b = { x: p['box'].x * W, y: p['box'].y * H, w: p['box'].w * W, h: p['box'].h * H };
    const sw = p['strokePx'] * u;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible';
    c.root.appendChild(svg);
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', String(b.x));
    rect.setAttribute('y', String(b.y));
    rect.setAttribute('width', String(b.w));
    rect.setAttribute('height', String(b.h));
    rect.setAttribute('rx', String(10 * u));
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke', p['color']);
    rect.setAttribute('stroke-width', String(sw));
    const perim = 2 * (b.w + b.h);
    rect.setAttribute('stroke-dasharray', String(perim));
    svg.appendChild(rect);
    const vk = p['layout'] === 'vertical' ? 1.35 : 1;
    const pill = h(
      'div',
      {
        background: p['color'],
        color: p['labelColor'],
        font: `700 ${34 * u * vk}px/1 "${c.family}"`,
        padding: `${14 * u}px ${24 * u}px`,
        borderRadius: px(10 * u),
        whiteSpace: 'nowrap',
      },
      p['label'],
      c.root,
    );
    const pw = pill.offsetWidth;
    const ph = pill.offsetHeight;
    const below = p['labelPos'] === 'below';
    const gapPx = 70 * u;
    let px0 = b.x + b.w / 2 - pw / 2;
    px0 = Math.min(Math.max(px0, c.safe.l), W - c.safe.r - pw);
    const py0 = below
      ? Math.min(b.y + b.h + gapPx, H - c.safe.b - ph)
      : Math.max(b.y - gapPx - ph, c.safe.t);
    Object.assign(pill.style, { left: px(px0), top: px(py0) });
    // Arrow: from the label edge to the box edge, straight.
    const ax = b.x + b.w / 2;
    const ay0 = below ? py0 : py0 + ph;
    const ay1 = below ? b.y + b.h : b.y;
    const line = document.createElementNS(ns, 'line');
    const dir = ay1 > ay0 ? 1 : -1;
    const head = 18 * u;
    line.setAttribute('x1', String(ax));
    line.setAttribute('y1', String(ay0));
    line.setAttribute('x2', String(ax));
    line.setAttribute('y2', String(ay1 - dir * head * 0.5));
    line.setAttribute('stroke', p['color']);
    line.setAttribute('stroke-width', String(sw));
    line.setAttribute('stroke-linecap', 'round');
    svg.appendChild(line);
    const tip = document.createElementNS(ns, 'polygon');
    tip.setAttribute(
      'points',
      `${ax},${ay1} ${ax - head * 0.7},${ay1 - dir * head} ${ax + head * 0.7},${ay1 - dir * head}`,
    );
    tip.setAttribute('fill', p['color']);
    svg.appendChild(tip);
    const len = Math.abs(ay1 - ay0);
    line.setAttribute('stroke-dasharray', String(len));
    c.watch(pill, 'callout label', 'safe');
    return {
      update(t) {
        const outP = ramp(t, c.durMs - p['exitMs'], p['exitMs'], p['exitEase']);
        const k1 = ramp(t, 0, p['entranceMs'], p['ease']);
        const k2 = ramp(t, p['entranceMs'] * 0.6, p['entranceMs'], p['ease']);
        const k3 = ramp(t, p['entranceMs'] * 1.2, p['entranceMs'] * 0.8, p['ease']);
        svg.style.opacity = String(1 - outP);
        rect.setAttribute('stroke-dashoffset', String(perim * (1 - k1)));
        line.setAttribute('stroke-dashoffset', String(len * (1 - k2)));
        tip.setAttribute('opacity', String(k2 > 0.98 ? 1 : 0));
        pill.style.opacity = String(k3 * (1 - outP));
        pill.style.transform = `scale(${0.85 + 0.15 * k3})`;
      },
    };
  },

  'kinetic-text'(c) {
    const { u, W, H, p } = c;
    const size = (p['sizePct'] / 100) * Math.min(W, H);
    const box = h(
      'div',
      {
        left: px(c.safe.l),
        top: '0',
        width: px(W - c.safe.l - c.safe.r),
        height: px(H),
        display: 'flex',
        flexWrap: 'wrap',
        alignContent: 'center',
        justifyContent: 'center',
        gap: `${0.12 * size}px ${0.3 * size}px`,
        font: `800 ${size}px/1.05 "${c.family}"`,
        color: p['color'],
        textAlign: 'center',
      },
      undefined,
      c.root,
    );
    box.style.position = 'absolute';
    const words = String(p['text'])
      .split(/\s+/)
      .map((w, i, a) =>
        h(
          'span',
          {
            position: 'relative',
            display: 'inline-block',
            color: i === a.length - 1 ? p['highlight'] : p['color'],
          },
          w,
          box,
        ),
      );
    words.forEach((w) => c.watch(w, 'kinetic text', 'safe'));
    const pop = easeFn('back.out');
    return {
      update(t) {
        const outP = ramp(t, c.durMs - p['exitMs'], p['exitMs'], p['exitEase']);
        words.forEach((w, i) => {
          const k = Math.min(1, Math.max(0, (t - i * p['staggerMs']) / p['entranceMs']));
          const s = 0.4 + 0.6 * pop(k);
          w.style.opacity = String(Math.min(1, k * 3) * (1 - outP));
          w.style.transform = `scale(${s}) translateY(${(1 - easeFn(p['ease'])(k)) * 40 * u}px)`;
        });
      },
    };
  },

  intro(c) {
    return card(c, 'title', 'subtitle', false);
  },
  outro(c) {
    return card(c, 'title', 'cta', true);
  },

  'cursor-highlight'(c) {
    const { W, H, p } = c;
    const d = (p['sizePct'] / 100) * Math.min(W, H);
    const clicks: { t: number; x: number; y: number }[] = p['clicks'];
    const rings = clicks.map((k) =>
      h(
        'div',
        {
          display: 'none',
          left: px(k.x * W - d / 2),
          top: px(k.y * H - d / 2),
          width: px(d),
          height: px(d),
          borderRadius: '50%',
          border: `${Math.max(3, d / 12)}px solid ${p['color']}`,
        },
        undefined,
        c.root,
      ),
    );
    return {
      update(t) {
        clicks.forEach((k, i) => {
          const u = (t - k.t) / p['ringMs'];
          const el = rings[i]!;
          if (u < 0 || u >= 1) {
            el.style.display = 'none';
            return;
          }
          const g = easeFn(p['ease'])(u);
          el.style.display = 'block';
          el.style.transform = `scale(${0.35 + 0.65 * g})`;
          el.style.opacity = String(1 - u * u);
        });
      },
    };
  },

  'speed-badge'(c) {
    const { u, W, p } = c;
    const pill = h(
      'div',
      {
        background: p['background'],
        color: p['color'],
        font: `800 ${40 * u}px/1 "${c.family}"`,
        padding: `${12 * u}px ${24 * u}px`,
        borderRadius: px(999),
        whiteSpace: 'nowrap',
      },
      p['label'],
      c.root,
    );
    c.watch(pill, 'speed badge', 'safe');
    const x = W - c.safe.r - pill.offsetWidth;
    Object.assign(pill.style, { left: px(x), top: px(c.safe.t + 12 * u) });
    return {
      update(t) {
        const { a } = life(c, t);
        pill.style.opacity = String(a);
        pill.style.transform = `scale(${0.8 + 0.2 * a})`;
      },
    };
  },

  'thumbnail-headline'(c) {
    const { p } = c;
    const box = h(
      'div',
      {
        left: '0',
        top: '0',
        width: px(p['boxW']),
        color: p['color'],
        textAlign: p['align'],
        whiteSpace: 'normal',
        overflowWrap: 'break-word',
      },
      p['text'],
      c.root,
    );
    let size = p['startPx'];
    const lh = 1.25;
    const set = () => Object.assign(box.style, { font: `800 ${size}px/${lh} "${c.family}"` });
    const lines = () => Math.max(1, Math.round(box.scrollHeight / (size * lh)));
    set();
    // Largest size that fits the width, the height, and the line limit.
    while (
      (box.scrollHeight > p['boxH'] || box.scrollWidth > p['boxW'] || lines() > p['maxLines']) &&
      size > 12
    ) {
      size = Math.floor(size * 0.92);
      set();
    }
    // Tight width of the text itself (the widest line), so the caller can size its scrim to the text.
    const range = document.createRange();
    range.selectNodeContents(box);
    const rects = Array.from(range.getClientRects());
    const w = Math.ceil(
      Math.max(...rects.map((r) => r.right)) - Math.min(...rects.map((r) => r.left)),
    );
    (window as any).__extra = {
      size,
      lines: lines(),
      w: p['align'] === 'right' ? p['boxW'] : w,
      h: Math.ceil(box.scrollHeight),
    };
    return { update() {} };
  },

  captions(c) {
    const { W, H, p } = c;
    const cues: any[] = p['cues'];
    const vertical = H > W;
    const pct = p['sizePct'] || (vertical ? 4.5 : 4);
    const size = (pct / 100) * H;
    const style = p['style'];
    const z = safeZoneFor(W, H);
    const maxW = Math.min(0.8 * W, W * (1 - 2 * z.side));
    const stage = h('div', { left: '0', top: '0', width: px(W), height: px(H) }, undefined, c.root);
    const lineEls: HTMLElement[][] = [];
    const nodes = cues.map((cue) => {
      const box = h(
        'div',
        {
          display: 'none',
          textAlign: 'center',
          left: '0',
          top: '0',
          width: 'max-content',
        },
        undefined,
        stage,
      );
      const words: HTMLElement[] = [];
      const lines: HTMLElement[] = [];
      cue.lines.forEach((_: string, li: number) => {
        const ln = h(
          'div',
          {
            position: 'relative',
            whiteSpace: 'nowrap',
            font: `${style === 'clean' ? 700 : 800} ${size}px/1.22 "${c.family}"`,
            color: p['color'],
          },
          undefined,
          box,
        );
        lines.push(ln);
        const ws = cue.words.filter((w: any) => w.line === li);
        ws.forEach((w: any, wi: number) => {
          const s = h('span', { position: 'relative' }, wi ? ' ' + w.w : w.w, ln);
          if (style === 'social') s.style.textTransform = 'none';
          words.push(Object.assign(s, { _w: w }) as HTMLElement);
        });
      });
      if (style !== 'social') {
        box.style.background = p['box'];
        box.style.padding = `${0.22 * size}px ${0.5 * size}px`;
        box.style.borderRadius = px(0.28 * size);
      } else {
        box.style.padding = `${0.1 * size}px ${0.3 * size}px`;
        lines.forEach((l) => {
          const o = Math.max(2, size / 14);
          l.style.webkitTextStroke = `${o * 2}px ${p['outline']}`;
          (l.style as any).paintOrder = 'stroke fill';
        });
      }
      lineEls.push(lines);
      return { box, words, cue };
    });
    // Place each box once (measured with the real font), bottom/center/top inside the safe zone.
    nodes.forEach((n) => {
      n.box.style.display = 'block';
      let bw = n.box.getBoundingClientRect().width;
      if (bw > maxW) {
        // Too wide for 80% of the frame: shrink this cue's font (down to 60%) and say so.
        const k = Math.max(0.6, maxW / bw);
        lineEls[nodes.indexOf(n)]!.forEach((l) => (l.style.fontSize = px(size * k)));
        n.box.style.padding = `${0.22 * size * k}px ${0.5 * size * k}px`;
        bw = n.box.getBoundingClientRect().width;
        c.warn(
          `cue ${n.cue.i} is wider than ${Math.round(maxW)} px at this font size; its font was reduced to ${Math.round(k * 100)}%${bw > maxW + 1 ? ' and it still does not fit' : ''}`,
        );
      }
      const bh = n.box.getBoundingClientRect().height;
      const x = (W - bw) / 2;
      const y =
        p['position'] === 'top'
          ? z.top * H
          : p['position'] === 'center'
            ? (H - bh) / 2
            : (1 - z.bottom) * H - bh;
      Object.assign(n.box.style, { left: px(x), top: px(y) });
      (n.box as any)._rect = { x, y, w: bw, h: bh };
      n.box.style.display = 'none';
    });
    (window as any).__captionBoxes = nodes.map((n) => ({ cue: n.cue.i, ...(n.box as any)._rect }));
    return {
      update(t) {
        for (const n of nodes) {
          const on = t >= n.cue.start && t < n.cue.end;
          n.box.style.display = on ? 'block' : 'none';
          if (on && style === 'karaoke') {
            // The word being spoken stays highlighted until the next one starts.
            let active = -1;
            n.words.forEach((s, i) => {
              if (t >= (s as any)._w.start) active = i;
            });
            n.words.forEach((s, i) => {
              s.style.color = i === active ? p['highlight'] : p['color'];
            });
          }
        }
      },
    };
  },
};

function card(c: Ctx, k1: string, k2: string, isOutro: boolean): Instance {
  const { u, W, H, p } = c;
  const bg = h(
    'div',
    { left: '0', top: '0', width: px(W), height: px(H), background: paint(p['background']) },
    undefined,
    c.root,
  );
  const wipe = h(
    'div',
    {
      left: '0',
      top: '0',
      width: px(W),
      height: px(H),
      background: p['accent'],
      transformOrigin: 'left',
    },
    undefined,
    c.root,
  );
  const col = h(
    'div',
    {
      left: px(c.safe.l),
      width: px(W - c.safe.l - c.safe.r),
      top: '0',
      height: px(H),
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      alignItems: 'center',
      textAlign: 'center',
    },
    undefined,
    c.root,
  );
  if (p['logo']) {
    const img = document.createElement('img');
    img.src = p['logo'];
    Object.assign(img.style, {
      position: 'relative',
      height: px(110 * u),
      marginBottom: px(36 * u),
      objectFit: 'contain',
    });
    col.appendChild(img);
  }
  const t1 = h(
    'div',
    { position: 'relative', font: `800 ${96 * u}px/1.08 "${c.family}"`, color: p['color'] },
    p[k1],
    col,
  );
  const rule = h(
    'div',
    {
      position: 'relative',
      height: px(6 * u),
      width: px(180 * u),
      background: p['accent'],
      margin: `${28 * u}px 0`,
      borderRadius: px(3 * u),
    },
    undefined,
    col,
  );
  let t2: HTMLElement | null = null;
  if (p[k2]) {
    t2 = isOutro
      ? h(
          'div',
          {
            position: 'relative',
            font: `700 ${44 * u}px/1 "${c.family}"`,
            color: p['background'] === 'transparent' ? p['color'] : p['background'],
            background: p['accent'],
            padding: `${18 * u}px ${36 * u}px`,
            borderRadius: px(999 * u),
          },
          p[k2],
          col,
        )
      : h(
          'div',
          {
            position: 'relative',
            font: `400 ${44 * u}px/1.25 "${c.family}"`,
            color: p['subtitleColor'],
          },
          p[k2],
          col,
        );
  }
  c.watch(t1, 'card title', 'safe');
  if (t2) c.watch(t2, 'card line 2', 'safe');
  return {
    update(t) {
      const outP = ramp(t, c.durMs - p['exitMs'], p['exitMs'], p['exitEase']);
      const e = p['entranceMs'];
      // Wipe in, then out the other side, uncovering the text.
      const wIn = ramp(t, 0, e * 0.8, 'cubic.inOut');
      const wOut = ramp(t, e * 0.8, e * 0.8, 'cubic.inOut');
      wipe.style.transformOrigin = wOut > 0 ? 'right' : 'left';
      wipe.style.transform = `scaleX(${wOut > 0 ? 1 - wOut : wIn})`;
      const k = ramp(t, e * 1.1, e, p['ease']);
      t1.style.opacity = String(k * (1 - outP));
      t1.style.transform = `translateY(${(1 - k) * 40 * u}px)`;
      rule.style.opacity = String(k * (1 - outP));
      rule.style.transform = `scaleX(${k})`;
      if (t2) {
        const k2 = ramp(t, e * 1.4, e, p['ease']);
        t2.style.opacity = String(k2 * (1 - outP));
        t2.style.transform = `translateY(${(1 - k2) * 24 * u}px)`;
      }
      bg.style.opacity = String(p['background'] === 'transparent' ? 0 : 1 - outP * 0);
    },
  };
}

let inst: Instance | null = null;
let ctxG: Ctx | null = null;
let fpsG = 30;
const warnings: string[] = [];
const watched: { el: Element; label: string; within: 'frame' | 'safe' }[] = [];

(window as any).studio = {
  async init(a: InitArgs) {
    for (const f of a.fonts) {
      const bin = Uint8Array.from(atob(f.data), (ch) => ch.charCodeAt(0));
      const face = new FontFace(f.family, bin.buffer, { weight: f.weight });
      await face.load(); // rejects on corrupt data: the render fails instead of substituting
      (document.fonts as unknown as { add(f: FontFace): void }).add(face);
    }
    await document.fonts.ready;
    for (const f of a.fonts)
      if (!document.fonts.check(`${f.weight} 20px "${f.family}"`))
        throw new Error(`font ${f.family} ${f.weight} did not load`);
    document.documentElement.style.cssText = 'margin:0;background:transparent';
    document.body.style.cssText = `margin:0;overflow:hidden;width:${a.width}px;height:${a.height}px;position:relative;background:${a.checker ? `repeating-conic-gradient(${a.checker[0]} 0% 25%, ${a.checker[1]} 0% 50%) 0 0/32px 32px` : 'transparent'}`;
    const root = document.createElement('div');
    root.style.cssText = `position:absolute;left:0;top:0;width:${a.width}px;height:${a.height}px;overflow:hidden`;
    document.body.appendChild(root);
    const t = T[a.comp];
    if (!t) throw new Error(`no template "${a.comp}" in the page bundle`);
    const z = safeZoneFor(a.width, a.height);
    ctxG = {
      root,
      W: a.width,
      H: a.height,
      u: Math.min(a.width, a.height) / 1080,
      fps: a.fps,
      durMs: a.durMs,
      p: a.props,
      safe: {
        l: z.side * a.width,
        r: z.side * a.width,
        t: z.top * a.height,
        b: z.bottom * a.height,
      },
      family: a.family,
      watch: (el, label, within = 'frame') => watched.push({ el, label, within }),
      warn: (m) => warnings.push(m),
    };
    fpsG = a.fps;
    inst = t(ctxG);
    // Images (a logo) must be decoded before the first frame; a broken one fails the render.
    await Promise.all(Array.from(document.images).map((im) => im.decode()));
    // Overflow check at the hold point: every watched element must lie inside the frame (or the safe area).
    inst.update(Math.max(0, a.durMs - a.props['exitMs'] - 1));
    for (const w of watched) {
      const r = w.el.getBoundingClientRect();
      const m = w.within === 'safe' ? 0 : 0;
      const L = w.within === 'safe' ? ctxG.safe.l : m;
      const R = a.width - (w.within === 'safe' ? ctxG.safe.r : m);
      const Tp = w.within === 'safe' ? ctxG.safe.t : m;
      const B = a.height - (w.within === 'safe' ? ctxG.safe.b : m);
      if (r.left < L - 1 || r.right > R + 1 || r.top < Tp - 1 || r.bottom > B + 1)
        warnings.push(
          `${w.label} leaves the ${w.within === 'safe' ? 'safe area' : 'frame'} (box ${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)} in ${a.width}x${a.height})`,
        );
    }
    return {
      warnings,
      captionBoxes: (window as any).__captionBoxes ?? null,
      extra: (window as any).__extra ?? null,
    };
  },
  render(frame: number) {
    inst!.update((frame * 1000) / fpsG);
  },
};
