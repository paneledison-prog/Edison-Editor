/**
 * The scene renderer: a design and a time in, DOM out. The editor canvas and the video export both use this one
 * function, so what you scrub is what you render. It is a pure function of (design, t): no transitions, no timers,
 * no clock, no randomness.
 */
import { resolve, type Resolved } from './anim.js';
import type { Design, Fill, Layer } from './schema.js';

export interface SceneOptions {
  /** turns `assets/x.png` into something an <img> can load (the export uses file URLs through a route, the editor a server path) */
  assetUrl?: (src: string) => string;
  /** default font family for text layers that name none */
  fontFamily?: string;
}

const NS = 'http://www.w3.org/2000/svg';
const px = (n: number) => `${Math.round(n * 1000) / 1000}px`;

function cssFill(f: Fill | undefined, solid: string | null): string {
  if (solid) return solid;
  if (!f) return 'transparent';
  if (f.type === 'solid') return f.color;
  const stops = f.stops.map((s) => `${s.color} ${Math.round(s.at * 1000) / 10}%`).join(', ');
  return f.type === 'linear' ? `linear-gradient(${f.angle}deg, ${stops})` : `radial-gradient(circle at 50% 50%, ${stops})`;
}

function svgEl<K extends string>(tag: K, attrs: Record<string, string | number> = {}): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** `<defs>` for a gradient fill on an SVG shape; returns the paint to use for `fill`/`stroke` */
function svgPaint(defs: SVGElement, id: string, f: Fill | undefined, solid: string | null): string {
  defs.replaceChildren();
  if (solid) return solid;
  if (!f) return 'none';
  if (f.type === 'solid') return f.color;
  const g =
    f.type === 'linear'
      ? svgEl('linearGradient', { id, gradientTransform: `rotate(${f.angle - 90} .5 .5)` })
      : svgEl('radialGradient', { id });
  for (const s of f.stops) g.appendChild(svgEl('stop', { offset: s.at, 'stop-color': s.color.slice(0, 7), 'stop-opacity': s.color.length === 9 ? parseInt(s.color.slice(7), 16) / 255 : 1 }));
  defs.appendChild(g);
  return `url(#${id})`;
}

function starPoints(w: number, h: number, n: number, inner: number): string {
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? inner : 1;
    const a = (Math.PI * i) / n - Math.PI / 2;
    pts.push(`${(w / 2 + (Math.cos(a) * r * w) / 2).toFixed(2)},${(h / 2 + (Math.sin(a) * r * h) / 2).toFixed(2)}`);
  }
  return pts.join(' ');
}

interface Node {
  el: HTMLElement;
  type: string;
  /** inner element for svg and text layers */
  inner?: SVGSVGElement | HTMLElement;
  defs?: SVGElement;
  shape?: SVGElement;
}

export class Scene {
  private nodes = new Map<string, Node>();
  private stage: HTMLElement;
  constructor(
    private root: HTMLElement,
    private opts: SceneOptions = {},
  ) {
    this.stage = document.createElement('div');
    Object.assign(this.stage.style, { position: 'absolute', left: '0', top: '0', overflow: 'hidden', transformOrigin: '0 0' });
    root.appendChild(this.stage);
  }

  /** Draws the design at time `t` (ms). Cheap enough to call on every pointer move and every playback frame. */
  update(d: Design, t: number): void {
    const { width, height, background, duration } = d.meta;
    Object.assign(this.stage.style, { width: px(width), height: px(height), background: background === 'transparent' ? 'transparent' : background });
    const live = new Set(d.layers.map((l) => l.id));
    for (const [id, n] of this.nodes) if (!live.has(id)) (n.el.remove(), this.nodes.delete(id));
    const order: Layer[] = d.layers;
    const parentEl = (l: Layer) => (l.parent ? this.nodes.get(l.parent)!.el : this.stage);
    // elements first (so parents exist), then place them in depth-first order
    for (const l of order) {
      let n = this.nodes.get(l.id);
      if (!n || n.type !== l.type) {
        n?.el.remove();
        n = this.make(l);
        this.nodes.set(l.id, n);
      }
    }
    const last = new Map<HTMLElement, HTMLElement | null>();
    for (const l of order) {
      const n = this.nodes.get(l.id)!;
      const p = parentEl(l);
      const prev = last.get(p) ?? null;
      const want = prev ? prev.nextSibling : p.firstChild;
      if (n.el.parentNode !== p || n.el !== want) p.insertBefore(n.el, want);
      last.set(p, n.el);
      this.style(n, l, resolve(l, t, duration));
    }
  }

  /** The element drawn for a layer (the editor measures it for selection handles). */
  elementOf(id: string): HTMLElement | undefined {
    return this.nodes.get(id)?.el;
  }
  get stageElement(): HTMLElement {
    return this.stage;
  }
  destroy() {
    this.stage.remove();
    this.nodes.clear();
  }

  private make(l: Layer): Node {
    const el = document.createElement('div');
    el.dataset['layer'] = l.id;
    Object.assign(el.style, { position: 'absolute', boxSizing: 'border-box', margin: '0', transformOrigin: '50% 50%' });
    const n: Node = { el, type: l.type };
    if (l.type === 'star' || l.type === 'path') {
      const svg = svgEl('svg') as SVGSVGElement;
      svg.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible';
      const defs = svgEl('defs');
      svg.appendChild(defs);
      const shape = l.type === 'star' ? svgEl('polygon') : svgEl('path');
      svg.appendChild(shape);
      el.appendChild(svg);
      Object.assign(n, { inner: svg, defs, shape });
    } else if (l.type === 'text') {
      const inner = document.createElement('div');
      inner.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;white-space:pre-wrap;overflow-wrap:anywhere';
      el.appendChild(inner);
      n.inner = inner;
    } else if (l.type === 'image') {
      const img = document.createElement('img');
      img.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block';
      img.draggable = false;
      el.appendChild(img);
      n.inner = img;
    }
    return n;
  }

  private style(n: Node, l: Layer, r: Resolved) {
    const s = n.el.style;
    if (!r.alive || l.type === 'audio') {
      s.display = 'none';
      return;
    }
    s.display = 'block';
    s.left = px(r.x);
    s.top = px(r.y);
    s.width = px(r.w);
    s.height = px(r.h);
    s.opacity = String(r.opacity);
    s.transform = r.rotation || r.scale !== 1 ? `rotate(${r.rotation}deg) scale(${r.scale})` : 'none';
    s.filter = r.layerBlur > 0.01 ? `blur(${px(r.layerBlur)})` : 'none';
    s.mixBlendMode = l.blend ?? 'normal';
    const glass = !!l.glass;
    const bg = l.bgBlur ?? (glass ? 16 : 0);
    s.setProperty('backdrop-filter', bg > 0 ? `blur(${px(bg)})` : 'none');
    const solid = r.fillColor;
    const radius = l.type === 'ellipse' ? '50%' : px(Math.min(r.cornerRadius, Math.min(r.w, r.h) / 2));

    // outline (stroke) and shadow share box-shadow so they follow the rounded shape
    const shadows: string[] = [];
    const sw = r.strokeWidth;
    if (r.strokeColor && sw > 0 && l.type !== 'path' && l.type !== 'star' && l.type !== 'text') {
      const align = l.stroke?.align ?? 'inside';
      if (align === 'inside') shadows.push(`inset 0 0 0 ${px(sw)} ${r.strokeColor}`);
      else if (align === 'outside') shadows.push(`0 0 0 ${px(sw)} ${r.strokeColor}`);
      else shadows.push(`inset 0 0 0 ${px(sw / 2)} ${r.strokeColor}`, `0 0 0 ${px(sw / 2)} ${r.strokeColor}`);
    }
    if (r.shadow && (r.shadow.blur > 0 || r.shadow.x || r.shadow.y) && l.type !== 'text') shadows.push(`${px(r.shadow.x)} ${px(r.shadow.y)} ${px(r.shadow.blur)} ${r.shadow.color}`);

    switch (l.type) {
      case 'frame':
      case 'group':
      case 'rect':
      case 'ellipse': {
        s.borderRadius = radius;
        s.overflow = l.type === 'frame' && l.clip !== false ? 'hidden' : 'visible';
        s.background = glass && !solid && !l.fill ? 'rgba(255,255,255,0.16)' : l.type === 'group' ? 'transparent' : cssFill(l.fill, solid);
        s.boxShadow = shadows.join(', ') || 'none';
        s.border = glass ? '1px solid rgba(255,255,255,0.35)' : '0';
        break;
      }
      case 'star': {
        s.boxShadow = 'none';
        const poly = n.shape!;
        const paint = svgPaint(n.defs!, `g_${l.id}`, l.fill, solid);
        poly.setAttribute('points', starPoints(r.w, r.h, l.points, l.innerRatio));
        poly.setAttribute('fill', paint);
        poly.setAttribute('stroke', r.strokeColor ?? 'none');
        poly.setAttribute('stroke-width', String(sw));
        poly.setAttribute('stroke-linejoin', 'round');
        (n.inner as SVGSVGElement).style.filter = r.shadow ? `drop-shadow(${px(r.shadow.x)} ${px(r.shadow.y)} ${px(r.shadow.blur / 2)} ${r.shadow.color})` : 'none';
        break;
      }
      case 'path': {
        s.boxShadow = 'none';
        const p = n.shape!;
        const svg = n.inner as SVGSVGElement;
        svg.setAttribute('viewBox', `0 0 ${l.w || 1} ${l.h || 1}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        const paint = svgPaint(n.defs!, `g_${l.id}`, l.fill, solid);
        p.setAttribute('d', l.d);
        p.setAttribute('pathLength', '1');
        p.setAttribute('fill', l.fill || solid ? paint : 'none');
        p.setAttribute('stroke', r.strokeColor ?? 'none');
        p.setAttribute('stroke-width', String(sw));
        p.setAttribute('stroke-linecap', l.cap ?? 'round');
        p.setAttribute('stroke-linejoin', 'round');
        p.setAttribute('vector-effect', 'non-scaling-stroke');
        p.setAttribute('stroke-dasharray', r.trim >= 0.9999 ? 'none' : `${Math.max(0, r.trim)} 2`);
        p.style.display = r.trim <= 0.0005 ? 'none' : 'inline';
        svg.style.filter = r.shadow ? `drop-shadow(${px(r.shadow.x)} ${px(r.shadow.y)} ${px(r.shadow.blur / 2)} ${r.shadow.color})` : 'none';
        break;
      }
      case 'text': {
        const t = n.inner as HTMLElement;
        s.boxShadow = 'none';
        const ts = t.style;
        ts.font = `${l.fontWeight ?? 500} ${px(l.fontSize)}/${l.lineHeight ?? 1.2} ${l.fontFamily ?? this.opts.fontFamily ?? 'Inter'}, system-ui, sans-serif`;
        ts.letterSpacing = px(l.letterSpacing ?? 0);
        ts.textAlign = l.align ?? 'left';
        const paint = cssFill(l.fill ?? { type: 'solid', color: '#000000' }, solid);
        if (paint.includes('gradient')) {
          ts.background = paint;
          ts.setProperty('-webkit-background-clip', 'text');
          ts.setProperty('background-clip', 'text');
          ts.color = 'transparent';
        } else {
          ts.background = 'none';
          ts.color = paint;
        }
        ts.textShadow = r.shadow ? `${px(r.shadow.x)} ${px(r.shadow.y)} ${px(r.shadow.blur)} ${r.shadow.color}` : 'none';
        // the rest of the text stays in the layout (hidden) so letters do not shift while they type on
        const chars = [...l.text];
        const shown = r.charProgress >= 0.9999 ? chars.length : Math.floor(chars.length * Math.max(0, r.charProgress));
        if (shown >= chars.length) {
          if (t.childNodes.length !== 1 || t.textContent !== l.text) t.textContent = l.text;
        } else {
          t.replaceChildren(document.createTextNode(chars.slice(0, shown).join('')));
          const rest = document.createElement('span');
          rest.style.visibility = 'hidden';
          rest.textContent = chars.slice(shown).join('');
          t.appendChild(rest);
        }
        break;
      }
      case 'image': {
        s.borderRadius = radius;
        s.overflow = 'hidden';
        s.boxShadow = shadows.join(', ') || 'none';
        const img = n.inner as HTMLImageElement;
        const url = (this.opts.assetUrl ?? ((x: string) => x))(l.src);
        if (img.getAttribute('src') !== url) img.setAttribute('src', url);
        img.style.objectFit = l.fit === 'contain' ? 'contain' : l.fit === 'fill' ? 'fill' : 'cover';
        break;
      }
    }
  }
}

/** Resolves every image before the first frame is captured (the export waits for this). */
export async function imagesReady(root: HTMLElement): Promise<string[]> {
  const bad: string[] = [];
  await Promise.all(
    Array.from(root.querySelectorAll('img')).map((im) => im.decode().catch(() => void bad.push(im.getAttribute('src') ?? '?'))),
  );
  return bad;
}
