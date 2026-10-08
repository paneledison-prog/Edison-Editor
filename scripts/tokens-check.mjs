// Enforces rules/11: one token file, two themes, no color literals elsewhere, contrast thresholds.
// If a pair fails, change the token value in tokens.css, never the threshold here.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const TOKENS = arg('tokens') ?? 'apps/ui/src/tokens.css';
// UI and motion templates only. Backend packages hold project data (e.g. the default '#000000' background), not UI color.
const SCAN_ROOTS = (arg('roots')?.split(',') ?? ['apps', 'motion']).filter(existsSync);
const SCAN_EXT = /\.(css|html|tsx?|jsx?|svg|mjs)$/;
const SKIP_DIR = /(^|\/)(node_modules|dist|dist-types|\.studio|renders)(\/|$)/;

const failures = [];
const fail = (m) => failures.push(m);

// ---- parse tokens.css -------------------------------------------------------
const css = readFileSync(TOKENS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const blocks = [];
for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
  blocks.push({ sel: m[1].trim().replace(/\s+/g, ' ').replace(/'/g, '"'), body: m[2] });
// @media wraps a nested :root rule; the regex above captures the inner rule, so also record @media text.
const ALLOWED = new Set([':root', ':root[data-theme="dark"]', ':root[data-theme="light"]']);
for (const b of blocks)
  if (!ALLOWED.has(b.sel))
    fail(`tokens.css: selector "${b.sel}" is not allowed (only :root, dark, light)`);
for (const m of css.matchAll(/@media\s*([^{]+)\{/g)) {
  if (!/prefers-reduced-motion/.test(m[1]))
    fail(`tokens.css: @media (${m[1].trim()}) is not allowed`);
}
const decls = (body) =>
  Object.fromEntries(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  );
const theme = (name) =>
  decls(blocks.find((b) => b.sel === `:root[data-theme="${name}"]`)?.body ?? '');
const dark = theme('dark');
const light = theme('light');
if (!Object.keys(dark).length || !Object.keys(light).length)
  fail('tokens.css: missing dark or light theme block');

// ---- 2. parity ---------------------------------------------------------------
const themed = (o) =>
  Object.keys(o)
    .filter((k) => /^--(color|track|shadow)-/.test(k))
    .sort();
const d = themed(dark),
  l = themed(light);
for (const k of d) if (!l.includes(k)) fail(`parity: ${k} is in dark but not light`);
for (const k of l) if (!d.includes(k)) fail(`parity: ${k} is in light but not dark`);

// ---- 4. contrast -------------------------------------------------------------
function rgb(v) {
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16));
  return null; // rgb()/alpha tokens are not contrast-checked
}
const lum = ([r, g, b]) => {
  const f = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const rows = [];
function check(themeName, vars, fg, bg, min) {
  const a = rgb(vars[fg] ?? ''),
    b = rgb(vars[bg] ?? '');
  if (!a || !b) return fail(`${themeName}: cannot resolve ${fg} on ${bg}`);
  const r = ratio(a, b);
  rows.push({ theme: themeName, fg, bg, ratio: r, min, ok: r >= min });
  if (r < min) fail(`${themeName}: ${fg} on ${bg} is ${r.toFixed(2)}:1, needs ${min}:1`);
}
const SURFACES = ['--color-bg-surface', '--color-bg-raised', '--color-bg-canvas'];
for (const [name, v] of [
  ['dark', dark],
  ['light', light],
]) {
  for (const t of ['--color-text-primary', '--color-text-secondary', '--color-text-muted'])
    for (const s of SURFACES) check(name, v, t, s, 4.5);
  check(name, v, '--color-on-action', '--color-action', 4.5);
  for (const k of Object.keys(v).filter((k) => /^--track-.+-fg$/.test(k)))
    check(name, v, k, k.replace(/-fg$/, '-bg'), 4.5);
  for (const t of ['--color-accent', '--color-border-strong', '--color-playhead'])
    for (const s of SURFACES) check(name, v, t, s, 3);
}

// ---- 1. no color literals outside tokens.css -----------------------------------
const LITERAL =
  /(^|[^\w&/])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/g;
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (SKIP_DIR.test(p)) continue;
    statSync(p).isDirectory() ? walk(p, out) : SCAN_EXT.test(p) && out.push(p);
  }
  return out;
}
let scanned = 0;
for (const root of SCAN_ROOTS) {
  for (const f of walk(root)) {
    if (relative('.', f) === TOKENS) continue;
    scanned++;
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const m of line.matchAll(LITERAL))
          fail(`literal: ${f}:${i + 1} has color literal "${m[0].trim()}"`);
      });
  }
}

// ---- 5. table -------------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
console.log(
  `${pad('theme', 6)} ${pad('foreground', 26)} ${pad('background', 24)} ${pad('ratio', 8)} ${pad('min', 4)} result`,
);
for (const r of rows)
  console.log(
    `${pad(r.theme, 6)} ${pad(r.fg, 26)} ${pad(r.bg, 24)} ${pad(r.ratio.toFixed(2) + ':1', 8)} ${pad(r.min, 4)} ${r.ok ? 'pass' : 'FAIL'}`,
  );
console.log(
  `\n${rows.length} contrast pairs, ${rows.filter((r) => !r.ok).length} failing; ${d.length} themed tokens per theme; ${scanned} source files scanned for literals`,
);
if (failures.length) {
  console.error('\n' + failures.map((f) => 'FAIL ' + f).join('\n'));
  process.exit(1);
}
console.log('tokens:check passed');
