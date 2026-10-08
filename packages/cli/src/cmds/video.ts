import { join as join2 } from 'node:path';
import { CliError } from '../args.js';
import type { Handler } from '../main.js';
import { clipContext, num, runSpecs, store, str } from './shared.js';

export const cutSilence: Handler = async (inv) => {
  const E = await import('@studio/engines');
  const I = await import('@studio/inspect');
  const cx = clipContext(inv, str(inv, 'clip'));
  const { clip, asset } = cx;
  if (!asset.probe.audio)
    throw new CliError(
      'INVALID_ARGS',
      `clip ${clip.id} has no audio, so there is no silence to detect`,
    );
  if (cx.speed !== 1)
    throw new CliError(
      'INVALID_ARGS',
      `clip ${clip.id} is sped up ${cx.speed}x; cut silences first, then change speed`,
    );
  if (clip.keyframes && Object.keys(clip.keyframes).length)
    throw new CliError(
      'INVALID_ARGS',
      `clip ${clip.id} has keyframes; cutting would split them. Remove them first`,
    );

  const minS = num(inv, 'min-s') ?? 0.4;
  const padMs = num(inv, 'pad-ms') ?? 100;
  if (minS < 0.4)
    throw new CliError(
      'INVALID_ARGS',
      '--min-s below 0.4 would cut natural rhythm (rules/02)',
      2,
      'omit --min-s, or pass 0.4 or more',
    );
  const range = { fromMs: cx.srcFromMs, toMs: cx.srcToMs };
  const warnings: string[] = [];

  // Threshold: measured noise floor + 8 dB, clamped, unless given.
  let noiseDb = num(inv, 'noise-db');
  let floor: number | null | undefined;
  if (noiseDb === undefined) {
    const L = await I.loudness(cx.src, range);
    floor = L.noiseFloorDbfs;
    noiseDb = Math.min(-20, Math.max(-50, Math.round((floor ?? -42) + 8)));
    warnings.push(
      `threshold ${noiseDb} dB = measured noise floor ${floor} dBFS + 8 dB (clamped to -50..-20)`,
    );
  }

  const dir = E.cacheDir(inv.dir, cx.hex);
  const found = await E.cachedJson(
    dir,
    'silence',
    { range, noiseDb, minS, method: 'rms20ms' },
    () => I.silenceRms(cx.src, noiseDb!, minS, range),
  );
  const { spans: silences, merged } = E.mergeSilences(found.value.spans);
  const plan = E.planSilenceCuts(silences, clip.dur, padMs);
  const frac = plan.removedMs / clip.dur;
  const summary = {
    clip: clip.id,
    asset: cx.assetId,
    thresholdDb: noiseDb,
    minSilenceS: minS,
    padMs,
    noiseFloorDbfs: floor,
    silencesFound: silences.length,
    fragmentsMerged: merged,
    silencesSkipped: plan.skipped,
    analysisCached: found.cached,
    removedMs: plan.removedMs,
    removedFraction: Math.round(frac * 1000) / 1000,
    cuts: plan.removed.length,
    keptSegments: plan.kept.length,
    removed: plan.removed.map((r) => ({ ...r, clipStartMs: clip.start + r.startMs })),
  };
  if (!plan.removed.length)
    return {
      data: { ...summary, applied: false },
      warnings: [...warnings, 'no silence long enough to cut at this threshold; nothing changed'],
    };
  if (frac > 0.4 && !inv.flags['yes']) {
    throw new CliError(
      'NEEDS_CONFIRMATION',
      `this would remove ${(frac * 100).toFixed(0)}% of the clip (${plan.removedMs} ms); that usually means the threshold is wrong`,
      2,
      `check \`studio inspect silence\`, lower --noise-db, or pass --yes to proceed`,
      summary,
    );
  }
  warnings.push(
    'no transcript yet: pauses before punchlines or after questions are not protected beyond the padding',
  );
  warnings.push(
    'silence is found by 20 ms RMS level only (no voice-activity model): music or steady noise above the threshold counts as speech',
  );
  warnings.push(
    'only clips later on the same track are shifted; check overlays and music on other tracks',
  );

  // Ops: replace the clip with the kept segments, contiguous from its start; shift later clips on the track.
  const pieces = plan.kept.map((k, i) => {
    const before = plan.kept.slice(0, i).reduce((n, x) => n + (x.endMs - x.startMs), 0);
    const { id: _id, ...rest } = clip;
    return {
      ...rest,
      start: clip.start + before,
      dur: k.endMs - k.startMs,
      srcIn: cx.srcFromMs + k.startMs,
    };
  });
  const origEnd = clip.start + clip.dur;
  const specs: { type: string; args: Record<string, unknown> }[] = [
    { type: 'clip.delete', args: { id: clip.id } },
  ];
  for (const piece of pieces) specs.push({ type: 'clip.add', args: { clip: piece } });
  if (!inv.flags['no-ripple']) {
    for (const o of cx.project.clips) {
      if (o.id !== clip.id && o.track === clip.track && o.start >= origEnd)
        specs.push({ type: 'clip.move', args: { id: o.id, start: o.start - plan.removedMs } });
    }
  }
  const res = runSpecs(inv, specs, `cut silence in ${clip.id}`);
  const ids = store(inv).readLog().at(-1);
  const newIds =
    ids && ids.kind === 'apply'
      ? ids.ops.filter((o) => o.type === 'clip.add').map((o) => (o.args as any).clip.id)
      : [];
  return {
    ...res,
    data: {
      ...(res.data as object),
      ...summary,
      applied: !inv.dryRun,
      newClipIds: newIds,
      shiftedLaterClips: !inv.flags['no-ripple'],
    },
    warnings,
  };
};

export const scenes: Handler = async (inv) => {
  const E = await import('@studio/engines');
  const I = await import('@studio/inspect');
  const clipId = str(inv, 'clip');
  const assetArg = str(inv, 'asset');
  if (!clipId && !assetArg) throw new CliError('INVALID_ARGS', 'give --clip or --asset');
  const threshold = num(inv, 'threshold') ?? 0.3;
  const warnings = [
    'scene scores can fire on scrolling, animation, and fades; these are candidates, not cuts. Screen recordings are the worst case: prefer cursor events or transcript sections when you have them',
  ];
  let src: string,
    hex: string,
    from = 0,
    to: number | undefined;
  let clip: ReturnType<typeof clipContext>['clip'] | undefined;
  if (clipId) {
    const cx = clipContext(inv, clipId);
    ({ src, hex, clip } = cx);
    from = cx.srcFromMs;
    to = cx.srcToMs;
  } else {
    const { project } = store(inv).load();
    const a = project.assets[assetArg!];
    if (!a) throw new CliError('INVALID_ARGS', `asset ${assetArg} not found`);
    if (a.kind !== 'video')
      throw new CliError(
        'INVALID_ARGS',
        `asset ${assetArg} is ${a.kind}, scene detection needs video`,
      );
    src = join2(inv.dir, a.workingCopy?.path ?? a.path);
    hex = a.hash.split(':')[1]!;
    to = a.probe.durMs;
  }
  const range = to !== undefined ? { fromMs: from, toMs: to } : undefined;
  const found = await E.cachedJson(E.cacheDir(inv.dir, hex), 'scenes', { threshold, range }, () =>
    I.scenes(src, threshold, range),
  );
  const cuts = found.value.map((c) => ({
    ...c,
    sourceMs: from + c.tMs,
    ...(clip ? { timelineMs: clip.start + c.tMs } : {}),
  }));
  const data: Record<string, unknown> = {
    threshold,
    count: cuts.length,
    cuts,
    analysisCached: found.cached,
    markersAdded: 0,
  };
  if (inv.flags['apply']) {
    if (!clip)
      throw new CliError(
        'INVALID_ARGS',
        '--apply adds markers on the timeline, so it needs --clip',
      );
    if (!cuts.length)
      return {
        data,
        warnings: [...warnings, 'no scene changes at this threshold; no markers added'],
      };
    const res = runSpecs(
      inv,
      cuts.map((c, i) => ({
        type: 'marker.add',
        args: { t: c.timelineMs!, label: `Scene ${i + 2}` },
      })),
      `scene markers for ${clip.id}`,
    );
    return {
      ...res,
      data: { ...(res.data as object), ...data, markersAdded: cuts.length },
      warnings,
    };
  }
  return { data, warnings };
};
export const speed: Handler = async (inv) => {
  const factor = num(inv, 'factor');
  if (factor === undefined) throw new CliError('INVALID_ARGS', 'missing --factor');
  const cx = clipContext(inv, str(inv, 'clip'));
  const warnings: string[] = [];
  if (factor > 8 && cx.asset.probe.audio) warnings.push(`above 8x the audio is dropped at render`);
  if (factor < 0.5 && cx.asset.kind === 'video')
    warnings.push('below 0.5x there is no frame interpolation, so motion will judder');
  if (factor > 1)
    warnings.push(
      'a speed badge on sped-up sections is not built (the motion renderer has no speed-badge template yet)',
    );
  const res = runSpecs(
    inv,
    [{ type: 'clip.speed', args: { id: cx.clip.id, factor, ripple: !!inv.flags['ripple'] } }],
    `speed ${factor}x on ${cx.clip.id}`,
  );
  const after = store(inv)
    .load()
    .project.clips.find((c) => c.id === cx.clip.id);
  return {
    ...res,
    data: {
      ...(res.data as object),
      clip: cx.clip.id,
      factor,
      durBeforeMs: cx.clip.dur,
      durAfterMs: inv.dryRun ? Math.round((cx.clip.dur * cx.speed) / factor) : after?.dur,
      rippled: !!inv.flags['ripple'],
    },
    warnings,
  };
};

const TARGETS: Record<string, { preset: string; id: string }> = {
  vertical: { preset: 'vertical-1080x1920', id: 'vert' },
  square: { preset: 'square-1080', id: 'square' },
  'portrait-4x5': { preset: 'portrait-4x5', id: 'portrait' },
  youtube: { preset: 'youtube-1080p', id: 'yt' },
};

export const reframe: Handler = async (inv) => {
  const E = await import('@studio/engines');
  const to = str(inv, 'to') ?? '';
  const t = TARGETS[to];
  if (!t)
    throw new CliError('INVALID_ARGS', `--to must be one of ${Object.keys(TARGETS).join(', ')}`);
  const method = (str(inv, 'method') ?? 'fit') as 'fit' | 'blur' | 'center-crop';
  const id = str(inv, 'id') ?? t.id;
  const { project } = store(inv).load();
  // Dry run of the render plan gives the real notes: upscale factor, how much a crop keeps, what fills the bars.
  const plan = await E.render({
    project,
    projectDir: inv.dir,
    preset: t.preset,
    reframe: method,
    explain: true,
  });
  const warnings = [...plan.notes];
  if (method === 'center-crop')
    warnings.push(
      'center crop assumes the subject is centered: render a still and look before you rely on it',
    );
  warnings.push(
    'tracked cropping needs detection data and keyframes (keyframes are not implemented in any backend); not available, so only fit, blur, and center-crop exist',
  );
  const res = runSpecs(
    inv,
    [{ type: 'export.set', args: { id, preset: t.preset, reframe: method } }],
    `reframe ${to} (${method})`,
  );
  let still: string | undefined;
  const at = num(inv, 'still');
  if (at !== undefined && !inv.dryRun) {
    const fresh = store(inv).load().project;
    const r = await E.render({
      project: fresh,
      projectDir: inv.dir,
      preset: t.preset,
      reframe: method,
      still: at,
      width: 540,
      noNormalize: true,
    });
    still = r.output;
  }
  return {
    ...res,
    data: {
      ...(res.data as object),
      export: id,
      preset: t.preset,
      method,
      canvas: `${plan.width}x${plan.height}`,
      ...(still ? { still } : {}),
    },
    warnings,
  };
};
