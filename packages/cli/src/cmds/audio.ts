import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fx } from '@studio/core';
import { CliError } from '../args.js';
import type { Handler, Invocation } from '../main.js';
import { clipContext, num, runSpecs, str, type ClipCtx } from './shared.js';

type Loud = Awaited<ReturnType<typeof import('@studio/inspect').loudness>>;
const SINGLETON: Fx['type'][] = [
  'highpass',
  'denoise',
  'eq',
  'compress',
  'limit',
  'loudnorm',
  'duck',
  'gain',
];

/** Replace an existing effect of the same type in place, or append. Loudnorm always goes last. */
function upsert(list: Fx[], entry: Fx): Fx[] {
  const out = [...list];
  const i = SINGLETON.includes(entry.type) ? out.findIndex((f) => f.type === entry.type) : -1;
  if (i >= 0) out[i] = entry;
  else out.push(entry);
  const ln = out.findIndex((f) => f.type === 'loudnorm');
  if (ln >= 0 && ln !== out.length - 1) out.push(out.splice(ln, 1)[0]!);
  return out;
}

/** Runs the exact chain the renderer will use over the clip's source range, and measures the result. */
async function measure(cx: ClipCtx, fx: Fx[] | undefined) {
  const E = await import('@studio/engines');
  const I = await import('@studio/inspect');
  const tmp = mkdtempSync(join(tmpdir(), 'studio-measure-'));
  try {
    const wav = join(tmp, 'chain.wav');
    const graph = await E.renderAudioChain(
      {
        src: cx.src,
        srcInMs: cx.srcFromMs,
        srcSpanMs: cx.srcToMs - cx.srcFromMs,
        channels: cx.channels,
        fx,
      },
      wav,
    );
    const L = await I.loudness(wav);
    return { graph, L, wav, tmp, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}
const r1 = (n: number | null | undefined) =>
  n === null || n === undefined ? n : Math.round(n * 10) / 10;
const brief = (L: Loud) => ({
  integratedLufs: r1(L.integratedLufs),
  lra: r1(L.lra),
  truePeakDbtp: r1(L.truePeakDbtp),
  noiseFloorDbfs: r1(L.noiseFloorDbfs),
  clippingRuns: L.clippingRuns,
});

function needAudio(cx: ClipCtx) {
  if (!cx.asset.probe.audio) throw new CliError('INVALID_ARGS', `clip ${cx.clip.id} has no audio`);
}
function apply(inv: Invocation, cx: ClipCtx, fx: Fx[], label: string) {
  return runSpecs(inv, [{ type: 'clip.set', args: { id: cx.clip.id, patch: { fx } } }], label);
}

export const denoise: Handler = async (inv) => {
  const cx = clipContext(inv, str(inv, 'clip'));
  needAudio(cx);
  const method = (str(inv, 'method') ?? 'afftdn') as 'afftdn' | 'arnndn';
  if (!['afftdn', 'arnndn'].includes(method))
    throw new CliError('INVALID_ARGS', '--method must be afftdn or arnndn');
  const hp = num(inv, 'hp') ?? 80;
  let fx: Fx[] = cx.clip.fx ?? [];
  if (hp > 0) fx = upsert(fx, { type: 'highpass', hz: hp });
  fx = upsert(fx, {
    type: 'denoise',
    method,
    ...(num(inv, 'nr') !== undefined ? { nr: num(inv, 'nr')! } : { nr: 12 }),
    ...(num(inv, 'nf') !== undefined ? { nf: num(inv, 'nf')! } : {}),
    ...(str(inv, 'model') ? { model: str(inv, 'model')! } : {}),
  });
  const before = await measure(cx, cx.clip.fx);
  before.cleanup();
  const after = await measure(cx, fx); // throws ENGINE_MISSING for arnndn without a model
  after.cleanup();
  const res = apply(inv, cx, fx, `denoise ${cx.clip.id} (${method})`);
  const delta = (after.L.noiseFloorDbfs ?? 0) - (before.L.noiseFloorDbfs ?? 0);
  return {
    ...res,
    data: {
      ...(res.data as object),
      clip: cx.clip.id,
      method,
      filtergraph: after.graph,
      before: brief(before.L),
      after: brief(after.L),
      noiseFloorDeltaDb: r1(delta),
      applied: !inv.dryRun,
    },
    warnings: [
      `noise floor ${r1(before.L.noiseFloorDbfs)} -> ${r1(after.L.noiseFloorDbfs)} dBFS (${r1(delta)} dB). Timbre and naturalness are not measured: listen to 10 s of speech and 10 s of room tone, since over-processing sounds watery or metallic`,
      'steady hiss and hum are reduced; reverb and overlapping speech cannot be removed by this chain',
      ...(method === 'afftdn'
        ? [
            "afftdn is FFmpeg's built-in denoiser; RNNoise/DeepFilterNet are not installed (use --method arnndn --model <file> after recording its license)",
          ]
        : []),
    ],
  };
};

export const cleanPodcast: Handler = async (inv) => {
  const E = await import('@studio/engines');
  const cx = clipContext(inv, str(inv, 'clip'));
  needAudio(cx);
  const target = num(inv, 'target') ?? -16;
  let fx: Fx[] = cx.clip.fx ?? [];
  fx = upsert(fx, { type: 'highpass', hz: 80 });
  if (!inv.flags['no-denoise']) fx = upsert(fx, { type: 'denoise', method: 'afftdn', nr: 12 });
  if (!inv.flags['no-eq'])
    fx = upsert(fx, {
      type: 'eq',
      bands: [
        { hz: 250, gain: -2, q: 1 },
        ...(inv.flags['presence'] ? [{ hz: 3000, gain: 2, q: 1 }] : []),
      ],
    });
  if (!inv.flags['no-compress'])
    fx = upsert(fx, {
      type: 'compress',
      thresholdDb: -24,
      ratio: 2.5,
      attackMs: 15,
      releaseMs: 150,
    });
  fx = upsert(fx, { type: 'limit', ceilingDb: -1.5 });
  fx = fx.filter((f) => f.type !== 'loudnorm');
  const before = await measure(
    cx,
    (cx.clip.fx ?? []).filter((f) => f.type !== 'loudnorm'),
  );
  before.cleanup();
  let measured;
  if (!inv.flags['no-normalize']) {
    const pre = await measure(cx, fx);
    try {
      measured = await E.measureLoudnorm(pre.wav, { I: target, TP: -1.5 });
    } finally {
      pre.cleanup();
    }
    fx = upsert(fx, { type: 'loudnorm', I: target, TP: -1.5, measured });
  }
  const after = await measure(cx, fx);
  after.cleanup();
  const res = apply(inv, cx, fx, `podcast cleanup ${cx.clip.id}`);
  const off =
    after.L.integratedLufs === null || after.L.integratedLufs === undefined
      ? NaN
      : after.L.integratedLufs - target;
  return {
    ...res,
    data: {
      ...(res.data as object),
      clip: cx.clip.id,
      filtergraph: after.graph,
      steps: fx.map((f) => f.type),
      before: brief(before.L),
      after: brief(after.L),
      targetLufs: inv.flags['no-normalize'] ? null : target,
      applied: !inv.dryRun,
    },
    warnings: [
      `output is stereo, so the stereo podcast target ${target} LUFS applies (mono deliverables use ${target - 3})`,
      ...(Number.isFinite(off) && Math.abs(off) > 1 && !inv.flags['no-normalize']
        ? [
            `after the chain the clip measures ${r1(after.L.integratedLufs)} LUFS, ${r1(off)} LU from target`,
          ]
        : []),
      ...(after.L.lra !== null && after.L.lra !== undefined && after.L.lra < 3
        ? [`loudness range is ${r1(after.L.lra)} LU: the speech may sound squashed`]
        : []),
      'when this clip is rendered with a preset that has its own loudness target, the final mix is normalized again to that target',
    ],
  };
};

export const normalize: Handler = async (inv) => {
  const E = await import('@studio/engines');
  const cx = clipContext(inv, str(inv, 'clip'));
  needAudio(cx);
  const target = num(inv, 'target') ?? -14;
  const tp = num(inv, 'tp') ?? -1.5;
  const base = (cx.clip.fx ?? []).filter((f) => f.type !== 'loudnorm');
  const pre = await measure(cx, base);
  let measured;
  try {
    measured = await E.measureLoudnorm(pre.wav, { I: target, TP: tp });
  } finally {
    pre.cleanup();
  }
  const fx = upsert(base, { type: 'loudnorm', I: target, TP: tp, measured });
  const after = await measure(cx, fx);
  after.cleanup();
  const res = apply(inv, cx, fx, `normalize ${cx.clip.id} to ${target} LUFS`);
  const achieved = after.L.integratedLufs ?? NaN;
  return {
    ...res,
    data: {
      ...(res.data as object),
      clip: cx.clip.id,
      targetLufs: target,
      truePeakCeilingDbtp: tp,
      filtergraph: after.graph,
      before: {
        integratedLufs: r1(measured.I),
        truePeakDbtp: r1(measured.TP),
        lra: r1(measured.LRA),
      },
      after: brief(after.L),
      applied: !inv.dryRun,
    },
    warnings: [
      'two-pass: pass 1 measured the clip, pass 2 applies the measured gain linearly',
      ...(Math.abs(achieved - target) > 1
        ? [
            `achieved ${r1(achieved)} LUFS, ${r1(achieved - target)} LU from target (the true-peak ceiling may have limited the gain)`,
          ]
        : []),
    ],
  };
};

export const duck: Handler = async (inv) => {
  const cx = clipContext(inv, str(inv, 'clip'));
  needAudio(cx);
  const by = str(inv, 'by');
  if (!by) throw new CliError('INVALID_ARGS', 'missing --by <track id of the voice>');
  const reduction = num(inv, 'reduction') ?? 15;
  const ratio = num(inv, 'ratio') ?? 8;
  const attackMs = num(inv, 'attack') ?? 20;
  const releaseMs = num(inv, 'release') ?? 400;
  if (reduction < 3 || reduction > 30)
    throw new CliError('INVALID_ARGS', '--reduction must be between 3 and 30 dB');
  if (ratio < 2) throw new CliError('INVALID_ARGS', '--ratio must be at least 2');
  const track = cx.project.tracks.find((t) => t.id === by);
  if (!track) throw new CliError('INVALID_ARGS', `track ${by} not found`);

  // Speech level: the loudest among the voice track's clips, measured through their own chains.
  const voiceClips = cx.project.clips
    .filter((c) => c.track === by && c.asset && cx.project.assets[c.asset]?.probe.audio)
    .slice(0, 6);
  if (!voiceClips.length)
    throw new CliError('INVALID_ARGS', `track ${by} has no clips with audio to duck by`);
  let voiceL = -Infinity;
  let voiceLufs = -Infinity;
  for (const vc of voiceClips) {
    const m = await measure(
      clipContext({ ...inv, flags: { ...inv.flags, clip: vc.id } } as Invocation, vc.id),
      vc.fx,
    );
    m.cleanup();
    // The sidechain detector sees plain RMS, not K-weighted loudness: use the RMS of the speech windows.
    if (m.L.activeRmsDbfs !== null && m.L.activeRmsDbfs !== undefined)
      voiceL = Math.max(voiceL, m.L.activeRmsDbfs);
    if (m.L.integratedLufs !== null && m.L.integratedLufs !== undefined)
      voiceLufs = Math.max(voiceLufs, m.L.integratedLufs);
  }
  if (!Number.isFinite(voiceL))
    throw new CliError('INVALID_ARGS', `the audio on track ${by} is silent: nothing to duck by`);

  // threshold from: reduction = (speechLevel - threshold) * (1 - 1/ratio)
  const thresholdDb = Math.round((voiceL - reduction / (1 - 1 / ratio)) * 10) / 10;
  let fx: Fx[] = cx.clip.fx ?? [];
  let gainDb: number | undefined;
  let musicL: number | undefined;
  if (!inv.flags['no-level']) {
    const offset = num(inv, 'music-offset-db') ?? -20;
    const m = await measure(
      cx,
      fx.filter((f) => f.type !== 'gain'),
    );
    m.cleanup();
    musicL = m.L.integratedLufs ?? undefined;
    if (musicL === undefined) throw new CliError('INVALID_ARGS', `clip ${cx.clip.id} is silent`);
    gainDb = Math.max(-40, Math.min(10, Math.round((voiceLufs + offset - musicL) * 10) / 10));
    fx = upsert(fx, { type: 'gain', db: gainDb });
  }
  fx = upsert(fx, {
    type: 'duck',
    by,
    thresholdDb: Math.max(-60, Math.min(0, thresholdDb)),
    ratio,
    attackMs,
    releaseMs,
  });
  const res = apply(inv, cx, fx, `duck ${cx.clip.id} under ${by}`);
  return {
    ...res,
    data: {
      ...(res.data as object),
      clip: cx.clip.id,
      by,
      speechRmsDbfs: r1(voiceL),
      speechLufs: r1(voiceLufs),
      musicLufs: r1(musicL),
      musicGainDb: gainDb,
      thresholdDb,
      ratio,
      attackMs,
      releaseMs,
      expectedReductionDb: reduction,
      applied: !inv.dryRun,
    },
    warnings: [
      "the threshold is estimated from the RMS of the voice clips' speech windows, so the real reduction can differ by a few dB",
      'verify: render, then compare the music alone and under speech, e.g. `studio inspect loudness <render> --from A --to B` on a music-only span and a speech span',
    ],
  };
};

export const sfxAdd: Handler = async (inv) => {
  const E = await import('@studio/engines');
  const f = inv.positionals[0];
  if (!f)
    throw new CliError(
      'INVALID_ARGS',
      'missing file',
      2,
      'studio audio sfx add <file> --tags a,b --license "..."',
    );
  const license = str(inv, 'license');
  if (license === undefined)
    throw new CliError(
      'INVALID_ARGS',
      'missing --license',
      2,
      'pass --license "<note>", or --license unknown if you do not know it (a warning is raised at export)',
    );
  const tags = (str(inv, 'tags') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const ls = num(inv, 'loop-start');
  const le = num(inv, 'loop-end');
  if (inv.dryRun) return { data: { wouldAdd: f, tags, license } };
  const r = await E.addToLibrary(inv.dir, f, {
    tags,
    license,
    bpm: num(inv, 'bpm'),
    loop: ls !== undefined && le !== undefined ? { startMs: ls, endMs: le } : undefined,
  });
  return {
    data: { created: r.created, entry: r.entry },
    warnings: r.warnings,
    artifacts: [{ kind: 'library', path: '.studio/library.json' }],
  };
};

export const sfxSearch: Handler = async (inv) => {
  const E = await import('@studio/engines');
  const hits = E.searchLibrary(inv.dir, inv.positionals.join(' '), num(inv, 'limit') ?? 10);
  return {
    data: {
      query: inv.positionals.join(' '),
      count: hits.length,
      results: hits.map((h) => ({ ...h.entry, score: h.score, matched: h.matched })),
    },
    warnings: [
      'search matches file names and tags only; it does not listen to the audio',
      ...(hits.length ? [] : ['no match in the library; nothing is fetched from the internet']),
      ...hits
        .filter((h) => h.entry.license.toLowerCase() === 'unknown')
        .map((h) => `${h.entry.id}: license unknown`),
    ],
  };
};

export const sfxList: Handler = async (inv) => {
  const E = await import('@studio/engines');
  const lib = E.loadLibrary(inv.dir);
  return {
    data: { count: lib.entries.length, entries: lib.entries },
    warnings: lib.entries
      .filter((e) => e.license.toLowerCase() === 'unknown')
      .map((e) => `${e.id} ${e.name}: license unknown`),
  };
};
