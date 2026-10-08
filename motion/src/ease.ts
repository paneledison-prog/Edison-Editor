/** The one easing module. Names match the project schema (`expo.out`, `bezier(.2,.8,.2,1)`, `linear`, `hold`). */
export type EaseFn = (t: number) => number;

const c1 = 1.70158;
const c3 = c1 + 1;
const c4 = (2 * Math.PI) / 3;
const bounceOut: EaseFn = (x) => {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
};

const OUT: Record<string, EaseFn> = {
  quad: (t) => 1 - (1 - t) ** 2,
  cubic: (t) => 1 - (1 - t) ** 3,
  quart: (t) => 1 - (1 - t) ** 4,
  quint: (t) => 1 - (1 - t) ** 5,
  sine: (t) => Math.sin((t * Math.PI) / 2),
  expo: (t) => (t === 1 ? 1 : 1 - 2 ** (-10 * t)),
  circ: (t) => Math.sqrt(1 - (t - 1) ** 2),
  back: (t) => 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2,
  elastic: (t) => (t === 0 ? 0 : t === 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1),
  bounce: bounceOut,
};
const IN =
  (f: EaseFn): EaseFn =>
  (t) =>
    1 - f(1 - t);
const INOUT =
  (f: EaseFn): EaseFn =>
  (t) =>
    t < 0.5 ? (1 - f(1 - 2 * t)) / 2 : (1 + f(2 * t - 1)) / 2;

function bezier(x1: number, y1: number, x2: number, y2: number): EaseFn {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const X = (t: number) => ((ax * t + bx) * t + cx) * t;
  const Y = (t: number) => ((ay * t + by) * t + cy) * t;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let t = x;
    for (let i = 0; i < 40; i++) {
      const v = X(t);
      if (Math.abs(v - x) < 1e-7) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return Y(t);
  };
}

export function easeFn(name: string): EaseFn {
  if (name === 'linear') return (t) => t;
  if (name === 'hold') return (t) => (t >= 1 ? 1 : 0);
  const b = /^bezier\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/.exec(
    name,
  );
  if (b) return bezier(+b[1]!, +b[2]!, +b[3]!, +b[4]!);
  const m = /^([a-z]+)\.(in|out|inOut)$/.exec(name);
  const out = m && OUT[m[1]!];
  if (!m || !out) throw new Error(`unknown easing "${name}"`);
  const f = m[2] === 'out' ? out : m[2] === 'in' ? IN(out) : INOUT(out);
  return (t) => f(Math.min(1, Math.max(0, t)));
}

/** Eased progress of a [start, start+dur] window at time t, clamped to 0..1. */
export function ramp(t: number, start: number, dur: number, ease: string): number {
  if (dur <= 0) return t >= start ? 1 : 0;
  return easeFn(ease)(Math.min(1, Math.max(0, (t - start) / dur)));
}
