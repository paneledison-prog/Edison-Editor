import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpDir } from './helpers.js';

const ROOT = join(import.meta.dirname, '..');
const REAL = readFileSync(join(ROOT, 'apps/ui/src/tokens.css'), 'utf8');

function check(css: string, files: Record<string, string> = {}) {
  const dir = tmpDir('tokens-');
  const src = join(dir, 'ui');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(dir, 'tokens.css'), css);
  for (const [n, c] of Object.entries(files)) writeFileSync(join(src, n), c);
  const r = spawnSync(
    'node',
    [join(ROOT, 'scripts/tokens-check.mjs'), '--tokens', join(dir, 'tokens.css'), '--roots', src],
    { encoding: 'utf8' },
  );
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('tokens:check', () => {
  it('passes on the real tokens and prints a ratio table', () => {
    const r = spawnSync('node', [join(ROOT, 'scripts/tokens-check.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/dark\s+--color-text-primary\s+--color-bg-surface\s+[\d.]+:1/);
    expect(r.stdout).toMatch(/0 failing/);
  });

  it('fails a low-contrast pair and names it', () => {
    const r = check(REAL.replace('--color-text-muted: #8d8d96;', '--color-text-muted: #3a3a40;'));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(
      /dark: --color-text-muted on --color-bg-surface is [\d.]+:1, needs 4.5:1/,
    );
  });

  it('fails when a token exists in only one theme', () => {
    const r = check(
      REAL.replace('  --track-comp-bg: #ffb07a;     --track-comp-fg: #3b1a05;\n', ''),
    );
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/parity: --track-comp-bg is in dark but not light/);
  });

  it('fails a third theme selector', () => {
    const r = check(REAL + '\n:root[data-theme="contrast"] { --color-bg-surface: #000; }\n');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/selector ":root\[data-theme="contrast"\]" is not allowed/);
  });

  it('fails color literals in components: hex, rgb(), hsl(), oklch()', () => {
    const r = check(REAL, {
      'a.css': '.x { color: #ff00aa; }\n.y { background: rgb(1 2 3); }',
      'b.tsx': 'const c = "hsl(10 20% 30%)"; const d = `oklch(0.5 0.1 200)`;',
    });
    expect(r.code).toBe(1);
    expect(r.err.match(/FAIL literal/g)).toHaveLength(4);
  });

  it('does not flag ids, anchors, or var(--token) usage (a hex-looking token in a comment is flagged on purpose)', () => {
    const r = check(REAL, {
      'ok.css': '.x { color: var(--color-accent); } a[href="#main"] {}',
      'ok.tsx': 'const id = "#section-3x";',
    });
    expect(r.code, r.err).toBe(0);
  });
});
