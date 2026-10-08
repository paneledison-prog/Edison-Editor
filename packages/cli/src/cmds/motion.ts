import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { TEMPLATES } from '@studio/motion';
import { CliError } from '../args.js';
import type { Handler, Invocation } from '../main.js';
import { num, parseJson, store, str } from './shared.js';

const rel = (inv: Invocation, p: string) =>
  p.startsWith(inv.dir + '/') ? p.slice(inv.dir.length + 1) : p;

function readProps(inv: Invocation, text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  if (text.trim().startsWith('{')) return parseJson('--props', text);
  const f = resolve(inv.dir, text);
  if (!existsSync(f))
    throw new CliError(
      'INVALID_ARGS',
      `props file ${text} does not exist`,
      2,
      'studio motion scaffold --comp <name> writes a starting file',
    );
  return parseJson(text, readFileSync(f, 'utf8'));
}

/** Template, props, and canvas from flags, or from a composition clip of the project. */
async function target(inv: Invocation) {
  const E = await import('@studio/engines');
  const clipId = str(inv, 'clip');
  let spec: import('@studio/engines').MotionSpec;
  if (clipId) {
    const { project } = store(inv).load();
    const clip = project.clips.find((c) => c.id === clipId);
    if (!clip?.comp)
      throw new CliError(
        'INVALID_ARGS',
        `clip ${clipId} is not a composition clip`,
        2,
        'studio project show lists clips',
      );
    spec = E.clipSpec(clip, inv.dir, {
      width: num(inv, 'width') ?? project.meta.width,
      height: num(inv, 'height') ?? project.meta.height,
      fps: num(inv, 'fps') ?? project.meta.fps,
    });
    if (num(inv, 'dur')) spec.durMs = num(inv, 'dur')!;
  } else {
    const comp = str(inv, 'comp');
    if (!comp)
      throw new CliError(
        'INVALID_ARGS',
        'name a template with --comp, or a project composition clip with --clip',
        2,
        'studio motion templates',
      );
    let w = 1920,
      h = 1080,
      fps = 30;
    if (existsSync(join(inv.dir, 'project.studio.json'))) {
      const m = store(inv).load().project.meta;
      [w, h, fps] = [m.width, m.height, m.fps];
    }
    const props = readProps(inv, str(inv, 'props'));
    spec = {
      comp,
      props,
      width: num(inv, 'width') ?? w,
      height: num(inv, 'height') ?? h,
      fps: num(inv, 'fps') ?? fps,
      durMs: num(inv, 'dur') ?? TEMPLATES[comp]?.defaultDurMs ?? 3000,
      projectDir: inv.dir,
    };
  }
  const prep = E.prepare(spec);
  const warnings: string[] = [];
  const min = (await import('@studio/motion')).minDurMs(prep.comp, prep.props);
  if (prep.durMs < min)
    warnings.push(
      `duration ${prep.durMs} ms is shorter than the ${min} ms needed for the entrance, reading time, and exit; text may not be readable`,
    );
  return { E, prep, warnings };
}

export const templates: Handler = async (inv) => {
  const only = str(inv, 'comp');
  if (only && !TEMPLATES[only])
    throw new CliError(
      'INVALID_ARGS',
      `unknown template "${only}"`,
      2,
      `available: ${Object.keys(TEMPLATES).join(', ')}`,
    );
  const list = Object.values(TEMPLATES).filter((t) => !only || t.id === only);
  return {
    data: {
      templates: list.map((t) => ({
        id: t.id,
        summary: t.summary,
        kind: t.kind,
        defaultDurMs: t.defaultDurMs,
        props: t.props,
      })),
    },
  };
};

export const scaffold: Handler = async (inv) => {
  const comp = str(inv, 'comp');
  if (!comp || !TEMPLATES[comp])
    throw new CliError(
      'INVALID_ARGS',
      `--comp must be one of ${Object.keys(TEMPLATES).join(', ')}`,
      2,
      'studio motion templates',
    );
  const props: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(TEMPLATES[comp]!.props))
    if (s.default !== undefined) props[k] = s.default;
  const outRel = str(inv, 'out') ?? join('motion', 'props', `${comp}.json`);
  const out = resolve(inv.dir, outRel);
  if (existsSync(out) && !inv.force)
    throw new CliError('WOULD_OVERWRITE', `${outRel} exists`, 5, 'pass --force to overwrite');
  if (!inv.dryRun) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(props, null, 2) + '\n');
  }
  return {
    data: { file: outRel, comp, props },
    artifacts: inv.dryRun ? [] : [{ kind: 'props', path: outRel }],
  };
};

export const still: Handler = async (inv) => {
  const { E, prep, warnings } = await target(inv);
  const at = num(inv, 'at');
  const frame = num(inv, 'frame') ?? (at !== undefined ? Math.round((at * prep.fps) / 1000) : 0);
  const outRel =
    str(inv, 'out') ?? join('renders', 'motion', `${prep.comp}-${prep.key}-f${frame}.png`);
  const out = resolve(inv.dir, outRel);
  if (inv.dryRun)
    return { data: { wouldRender: outRel, frame, frames: prep.frames, key: prep.key } };
  const r = await E.motionStill(prep, frame, out, { checker: !!inv.flags['checker'] });
  return {
    data: {
      file: outRel,
      frame,
      frames: prep.frames,
      width: r.width,
      height: r.height,
      ms: r.ms,
      key: prep.key,
      codeVersion: prep.codeVersion,
    },
    warnings: [...warnings, ...r.warnings],
    artifacts: [{ kind: 'still', path: outRel }],
  };
};

export const render: Handler = async (inv) => {
  const { E, prep, warnings } = await target(inv);
  const fmt = (str(inv, 'format') ?? 'prores4444') as import('@studio/engines').OverlayFormat;
  if (!['prores4444', 'webm', 'png'].includes(fmt))
    throw new CliError('INVALID_ARGS', `--format must be prores4444, webm, or png`);
  const ext = fmt === 'png' ? '' : fmt === 'webm' ? '.webm' : '.mov';
  const outRel =
    str(inv, 'out') ?? join('renders', 'motion', `${prep.comp}-${prep.key}${ext || '-frames'}`);
  const out = resolve(inv.dir, outRel);
  if (existsSync(out) && !inv.force)
    throw new CliError(
      'WOULD_OVERWRITE',
      `${outRel} exists`,
      5,
      'pass --force or choose another --out',
    );
  if (inv.dryRun)
    return {
      data: { wouldRender: outRel, frames: prep.frames, fps: prep.fps, key: prep.key, format: fmt },
    };
  let last = -1;
  const r = await E.motionFrames(prep, join(inv.dir, '.studio', 'cache'), {
    concurrency: num(inv, 'concurrency'),
    onProgress: (d, t) => {
      const pct = Math.floor((d / t) * 10) * 10;
      if (pct !== last) {
        last = pct;
        inv.log(`${d}/${t} frames (${pct}%)`);
      }
    },
  });
  const enc = await E.exportOverlay(r.dir, prep.fps, out, fmt);
  const secsOut = prep.durMs / 1000;
  const slow = !r.cached && r.ms / 1000 / secsOut > 3;
  return {
    data: {
      file: outRel,
      format: fmt,
      frames: r.frames,
      fps: prep.fps,
      width: prep.width,
      height: prep.height,
      cached: r.cached,
      renderMs: r.ms,
      renderFps: r.renderFps,
      concurrency: r.concurrency,
      bytes: enc.bytes,
      key: prep.key,
      codeVersion: prep.codeVersion,
      frameDir: rel(inv, r.dir),
    },
    warnings: [
      ...warnings,
      ...r.warnings,
      ...(slow
        ? [
            `rendering took ${(r.ms / 1000 / secsOut).toFixed(1)} s per second of video (over the 3 s guideline): look for heavy blur, shadows, or large images`,
          ]
        : []),
    ],
    artifacts: [{ kind: 'motion', path: outRel }],
  };
};
