import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPlugin, PluginError, type Fx } from '@studio/core';
import { CliError } from '../args.js';
import type { Handler } from '../main.js';
import { parseJson, runSpecs, store, str } from './shared.js';

const COMMON_PROPS = {
  entranceMs: { type: 'number', default: 400, min: 0, max: 2000, desc: 'entrance duration in ms' },
  exitMs: { type: 'number', default: 250, min: 0, max: 2000, desc: 'exit duration in ms' },
  ease: { type: 'ease', default: 'expo.out', desc: 'entrance easing' },
  exitEase: { type: 'ease', default: 'cubic.in', desc: 'exit easing' },
};

export const list: Handler = async (inv) => {
  const E = await import('@studio/engines');
  const only = str(inv, 'id');
  const plugins = E.loadedPlugins().filter((p) => !only || p.manifest.id === only);
  if (only && !plugins.length)
    throw new CliError('NOT_FOUND', `no plugin "${only}"`, 2, 'studio plugins list shows what is loaded');
  return {
    data: {
      plugins: plugins.map((p) => ({
        id: p.manifest.id,
        name: p.manifest.name,
        version: p.manifest.version,
        summary: p.manifest.summary,
        license: p.manifest.license,
        source: p.source,
        bytes: p.bytes,
        templates: (p.manifest.templates ?? []).map((t) => ({ id: t.id, summary: t.summary, props: t.props })),
        effects: (p.manifest.effects ?? []).map((e) => ({ id: e.id, summary: e.summary, params: e.params })),
        scripts: (p.manifest.scripts ?? []).map((s) => ({ name: `${p.manifest.id}/${s.name}`, summary: s.summary })),
      })),
      totalBytes: plugins.reduce((n, p) => n + p.bytes, 0),
      problems: only ? [] : E.pluginProblems(),
    },
  };
};

const SCAFFOLD: Record<string, (id: string) => { manifest: Record<string, unknown>; files: Record<string, string> }> = {
  template: (id) => ({
    manifest: {
      page: 'page.js',
      templates: [
        {
          id,
          summary: 'Fades a line of text in and out.',
          kind: 'overlay',
          defaultDurMs: 3000,
          props: {
            text: { type: 'string', default: 'Hello', maxLen: 60, desc: 'the text' },
            color: { type: 'color', default: 'token:fg', desc: 'text color' },
            ...COMMON_PROPS,
          },
        },
      ],
    },
    files: {
      'page.js': `// Drawing code for the "${id}" template. Everything is a pure function of time t (ms): no timers, no Math.random.
// c: { root, W, H, u (1 at 1080p), p (props), family, safe, watch(el,label,'safe'|'frame') }; lib: see docs/plugins.md
register('${id}', (c, lib) => {
  const el = lib.h('div', {
    left: '0', top: '0', width: c.W + 'px', height: c.H + 'px',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: c.p.color, font: \`700 \${88 * c.u}px "\${c.family}"\`,
  }, c.p.text, c.root);
  return {
    update(t) {
      const { a } = lib.life(c, t);
      el.style.opacity = String(a);
      el.style.transform = \`translateY(\${(1 - lib.ramp(t, 0, c.p.entranceMs, c.p.ease)) * 40 * c.u}px)\`;
    },
  };
});
`,
    },
  }),
  effect: (id) => ({
    manifest: {
      effects: [
        {
          id,
          summary: 'Soft glow: a blurred copy screened over the picture.',
          params: {
            radius: { type: 'number', default: 12, min: 1, max: 60, desc: 'blur radius in pixels' },
            amount: { type: 'number', default: 0.5, min: 0, max: 1, desc: 'strength of the glow' },
          },
          graph:
            '[in]format=gbrp,split=2[a][b];[a]gblur=sigma={radius}[g];[b][g]blend=all_mode=screen:all_opacity={amount},format=yuv420p[out]',
        },
      ],
    },
    files: {},
  }),
  script: (id) => ({
    manifest: { scripts: [{ name: id, summary: 'Describe what this script does.', file: `${id}.mjs` }] },
    files: {
      [`${id}.mjs`]: `// A Studio script. It changes the project only through \`studio\` commands, so every change is an op.
// api: { args, project, studio(argv) -> JSON (throws on failure), expr(src, vars) -> number, log(msg) }
export const meta = { args: { clip: { type: 'string', desc: 'clip id', required: true } } };
export default async function run(api) {
  const clip = api.project.clips.find((c) => c.id === api.args.clip);
  if (!clip) throw new Error('no such clip ' + api.args.clip);
  await api.studio(['tl', 'marker', '--t', String(clip.start), '--label', 'start of ' + clip.id]);
  return { marked: clip.id };
}
`,
    },
  }),
};

export const newPlugin: Handler = async (inv) => {
  const id = inv.positionals[0];
  const kind = str(inv, 'kind') ?? 'template';
  if (!id || !/^[a-z][a-z0-9-]{1,31}$/.test(id))
    throw new CliError('INVALID_ARGS', 'give a plugin id: lowercase letters, digits, dashes (2-32 characters)', 2);
  const make = SCAFFOLD[kind];
  if (!make)
    throw new CliError('INVALID_ARGS', `--kind must be one of ${Object.keys(SCAFFOLD).join(', ')}`, 2);
  const dir = join(inv.dir, 'plugins', id);
  if (existsSync(dir) && !inv.force)
    throw new CliError('WOULD_OVERWRITE', `plugins/${id} exists`, 5, 'pass --force to overwrite');
  const { manifest, files } = make(id);
  const full = {
    api: 1,
    id,
    name: id,
    version: '0.1.0',
    summary: `A ${kind} plugin.`,
    license: 'MIT',
    ...manifest,
  };
  if (!inv.dryRun) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify(full, null, 2) + '\n');
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  }
  return {
    data: { id, kind, dir: `plugins/${id}`, files: ['plugin.json', ...Object.keys(files)], next: `studio plugins check ${id}` },
    artifacts: inv.dryRun ? [] : [{ kind: 'plugin', path: `plugins/${id}/plugin.json` }],
  };
};

/** Validates a plugin and exercises it: effects run on a test pattern, templates render a frame. */
export const check: Handler = async (inv) => {
  const id = inv.positionals[0];
  if (!id) throw new CliError('INVALID_ARGS', 'give a plugin id', 2, 'studio plugins list');
  const E = await import('@studio/engines');
  const found = E.loadedPlugins().find((p) => p.manifest.id === id);
  if (!found) {
    // not loaded: load it directly to give the real reason
    const dir = join(inv.dir, 'plugins', id);
    try {
      loadPlugin(dir, 'project');
    } catch (e) {
      throw new CliError('PLUGIN_INVALID', (e as PluginError).message, 4, (e as PluginError).fix);
    }
    throw new CliError('PLUGIN_INVALID', `${id} is valid but was not loaded (id clash?)`, 4, 'studio plugins list shows problems');
  }
  const results: { kind: string; id: string; ok: boolean; detail: string }[] = [];
  for (const e of found.manifest.effects ?? []) {
    const lines = E.effectLines({ id: e.id }, 'src', 'fxout', 'chk');
    let failure = '';
    try {
      await E.ffmpeg([
      '-hide_banner',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=320x180:d=0.5:r=24',
      '-filter_complex',
      `[0:v]format=yuv420p[src];${lines.join(';')}`,
      '-map',
      '[fxout]',
      '-frames:v',
      '3',
      '-f',
      'null',
      '-',
    ]);
    } catch (err) {
      failure = (err as Error).message.split('\n').slice(-2).join(' | ');
    }
    results.push({
      kind: 'effect',
      id: e.id,
      ok: !failure,
      detail: failure || 'graph ran on a test pattern',
    });
  }
  for (const t of found.manifest.templates ?? []) {
    try {
      const prep = E.prepare({
        comp: t.id,
        props: undefined,
        width: 640,
        height: 360,
        fps: 24,
        durMs: t.defaultDurMs,
        projectDir: inv.dir,
      });
      const out = join(inv.dir, 'renders', 'motion', `check-${t.id}.png`);
      mkdirSync(join(inv.dir, 'renders', 'motion'), { recursive: true });
      const r = await E.motionStill(prep, Math.floor(prep.frames / 2), out, {});
      results.push({
        kind: 'template',
        id: t.id,
        ok: r.warnings.length === 0,
        detail: r.warnings.length ? r.warnings.join('; ') : `rendered a frame in ${r.ms} ms`,
      });
    } catch (e) {
      results.push({ kind: 'template', id: t.id, ok: false, detail: (e as Error).message });
    }
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length)
    throw new CliError(
      'PLUGIN_INVALID',
      `${id}: ${failed.map((f) => `${f.kind} ${f.id}: ${f.detail}`).join('; ')}`,
      4,
      'fix the plugin and run `studio plugins check` again',
    );
  return { data: { id, bytes: found.bytes, hash: found.hash, results } };
};

/** Adds a plugin effect to a clip as an ordinary, undoable op. */
export const apply: Handler = async (inv) => {
  const E = await import('@studio/engines');
  const clipId = str(inv, 'clip');
  const effect = str(inv, 'effect');
  if (!clipId || !effect) throw new CliError('INVALID_ARGS', '--clip and --effect are required', 2);
  const e = E.pluginEffects().find((x) => x.decl.id === effect);
  if (!e)
    throw new CliError(
      'NOT_FOUND',
      `no plugin effect "${effect}"; available: ${E.pluginEffects().map((x) => x.decl.id).join(', ') || 'none'}`,
      2,
      'studio plugins list',
    );
  const params = inv.flags['params'] ? parseJson('--params', String(inv.flags['params'])) : undefined;
  // validate now: a bad value fails here, with the allowed range, not at render time
  E.effectLines({ id: effect, params }, 'a', 'b', 'v');
  const { project } = store(inv).load();
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) throw new CliError('NOT_FOUND', `no clip ${clipId}`, 2, 'studio project show');
  const fx: Fx[] = [...(clip.fx ?? []), { type: 'plugin', id: effect, ...(params ? { params } : {}) }];
  return runSpecs(inv, [{ type: 'clip.set', args: { id: clipId, patch: { fx } } }], `plugin ${effect}`);
};
