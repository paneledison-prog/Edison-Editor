/**
 * Expressions: a tiny, safe, deterministic formula language for animation ("1 + 0.2 * sin(t * 6)").
 * Parsed to an AST and evaluated directly: no eval, no Function, no property access, no loops, no I/O.
 * The same module runs in Node (baking keyframes, scripts) and in the motion page (plugin templates), so a
 * formula means the same thing in both. Same inputs, same output: `wiggle` and `noise` are seeded hashes.
 */

export interface ExprEnv {
  /** variables: t (seconds), f (frame), dur (seconds), i, n, and anything the caller adds */
  vars?: Record<string, number>;
  /** extra functions, e.g. `ease` supplied by the caller */
  fns?: Record<string, (...a: number[]) => number>;
}

type Node =
  | { k: 'num'; v: number }
  | { k: 'var'; name: string }
  | { k: 'un'; op: '-' | '!'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'cond'; c: Node; a: Node; b: Node }
  | { k: 'call'; name: string; args: Node[] };

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExprError';
  }
}

const MAX_LEN = 400;
const MAX_DEPTH = 24;

/** Hash of an integer lattice point and seed to [0, 1). */
function hash(n: number, seed: number): number {
  let x = (Math.imul(n | 0, 0x27d4eb2d) ^ Math.imul((seed | 0) + 0x165667b1, 0x85ebca6b)) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0;
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39) >>> 0;
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}
/** Smooth 1D value noise in [-1, 1]. */
export function noise(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const s = f * f * (3 - 2 * f);
  return (hash(i, seed) * (1 - s) + hash(i + 1, seed) * s) * 2 - 1;
}

const FNS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  abs: Math.abs,
  sqrt: Math.sqrt,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  mod: (a, b) => (b === 0 ? 0 : ((a % b) + b) % b),
  clamp: (x, lo, hi) => Math.min(hi, Math.max(lo, x)),
  lerp: (a, b, x) => a + (b - a) * x,
  smooth: (a, b, x) => {
    const u = Math.min(1, Math.max(0, (x - a) / (b - a || 1)));
    return u * u * (3 - 2 * u);
  },
  noise: (x, seed = 0) => noise(x, seed),
  /** wiggle(freq, amp, seed): smooth random offset around 0, `freq` changes per second */
  wiggle: (freq, amp, seed = 0) => 0, // replaced at eval time (needs t)
  /** pingpong(x, len): triangle wave 0..len..0 */
  pingpong: (x, len) => {
    const m = ((x % (2 * len)) + 2 * len) % (2 * len);
    return m <= len ? m : 2 * len - m;
  },
  /** step(edge, x): 0 below edge, 1 at or above */
  step: (edge, x) => (x >= edge ? 1 : 0),
};
const CONSTS: Record<string, number> = { pi: Math.PI, tau: Math.PI * 2, e: Math.E };
const PREC: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
  '^': 8,
};

function tokenize(src: string): string[] {
  const out: string[] = [];
  const re = /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+)|([A-Za-z_][A-Za-z0-9_]*)|(\|\||&&|==|!=|<=|>=|[-+*/%^(),<>?:!]))/gy;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) {
      if (/^\s*$/.test(src.slice(pos))) break;
      throw new ExprError(`unexpected character "${src.slice(pos).trim()[0]}" at ${pos}`);
    }
    out.push(m[1] ?? m[2] ?? m[3]!);
    pos = re.lastIndex;
  }
  return out;
}

export function parseExpr(src: string): Node {
  if (src.length > MAX_LEN) throw new ExprError(`expression is ${src.length} characters, max ${MAX_LEN}`);
  const toks = tokenize(src);
  if (!toks.length) throw new ExprError('empty expression');
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (t: string) => {
    if (next() !== t) throw new ExprError(`expected "${t}"`);
  };
  function primary(d: number): Node {
    if (d > MAX_DEPTH) throw new ExprError('expression is nested too deeply');
    const t = next();
    if (t === undefined) throw new ExprError('unexpected end of expression');
    if (t === '(') {
      const e = ternary(d + 1);
      expect(')');
      return e;
    }
    if (t === '-' || t === '!') return { k: 'un', op: t, a: binary(7, d + 1) };
    if (/^[\d.]/.test(t)) return { k: 'num', v: Number(t) };
    if (/^[A-Za-z_]/.test(t)) {
      if (peek() === '(') {
        next();
        const args: Node[] = [];
        if (peek() !== ')') {
          do args.push(ternary(d + 1));
          while (peek() === ',' && next());
        }
        expect(')');
        return { k: 'call', name: t, args };
      }
      return { k: 'var', name: t };
    }
    throw new ExprError(`unexpected "${t}"`);
  }
  function binary(minPrec: number, d: number): Node {
    let left = primary(d);
    for (;;) {
      const op = peek();
      const pr = op !== undefined ? PREC[op] : undefined;
      if (pr === undefined || pr < minPrec) return left;
      next();
      const right = op === '^' ? binary(pr, d + 1) : binary(pr + 1, d + 1);
      left = { k: 'bin', op: op!, a: left, b: right };
    }
  }
  function ternary(d: number): Node {
    const c = binary(1, d);
    if (peek() === '?') {
      next();
      const a = ternary(d + 1);
      expect(':');
      const b = ternary(d + 1);
      return { k: 'cond', c, a, b };
    }
    return c;
  }
  const ast = ternary(0);
  if (p < toks.length) throw new ExprError(`unexpected "${toks[p]}"`);
  return ast;
}

function run(n: Node, env: ExprEnv): number {
  switch (n.k) {
    case 'num':
      return n.v;
    case 'var': {
      const v = env.vars?.[n.name] ?? CONSTS[n.name];
      if (v === undefined)
        throw new ExprError(
          `unknown variable "${n.name}"; available: ${[...Object.keys(env.vars ?? {}), ...Object.keys(CONSTS)].join(', ')}`,
        );
      return v;
    }
    case 'un': {
      const a = run(n.a, env);
      return n.op === '-' ? -a : a ? 0 : 1;
    }
    case 'cond':
      return run(n.c, env) ? run(n.a, env) : run(n.b, env);
    case 'bin': {
      const a = run(n.a, env);
      if (n.op === '&&') return a && run(n.b, env) ? 1 : 0;
      if (n.op === '||') return a || run(n.b, env) ? 1 : 0;
      const b = run(n.b, env);
      switch (n.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return b === 0 ? 0 : a / b;
        case '%':
          return b === 0 ? 0 : a % b;
        case '^':
          return Math.pow(a, b);
        case '==':
          return a === b ? 1 : 0;
        case '!=':
          return a !== b ? 1 : 0;
        case '<':
          return a < b ? 1 : 0;
        case '<=':
          return a <= b ? 1 : 0;
        case '>':
          return a > b ? 1 : 0;
        default:
          return a >= b ? 1 : 0;
      }
    }
    case 'call': {
      const args = n.args.map((a) => run(a, env));
      if (n.name === 'wiggle') {
        const [freq = 1, amp = 1, seed = 0] = args;
        return amp * noise((env.vars?.['t'] ?? 0) * freq, seed);
      }
      const fn = env.fns?.[n.name] ?? FNS[n.name];
      if (!fn)
        throw new ExprError(
          `unknown function "${n.name}"; available: ${[...Object.keys(FNS), ...Object.keys(env.fns ?? {})].sort().join(', ')}`,
        );
      return fn(...args);
    }
  }
}

/** Parses once, evaluates many times. Throws ExprError on a bad formula, an unknown name, or a non-finite result. */
export function compileExpr(src: string, fns?: ExprEnv['fns']): (vars: Record<string, number>) => number {
  const ast = parseExpr(src);
  return (vars) => {
    const v = run(ast, { vars, ...(fns ? { fns } : {}) });
    if (!Number.isFinite(v)) throw new ExprError(`"${src}" gave ${v} for ${JSON.stringify(vars)}`);
    return v;
  };
}

export const EXPR_FUNCTIONS = [...Object.keys(FNS), 'ease (supplied by the CLI)'].sort();
