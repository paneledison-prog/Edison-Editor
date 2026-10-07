import { EngineError, lastLine, run } from './run.js';

export interface ProbeInfo {
  durMs?: number;
  fps?: number;
  rFps?: number;
  vfr?: boolean;
  w?: number;
  h?: number;
  /** Degrees clockwise needed to display upright (from the display matrix). 0 when absent. */
  rotation?: number;
  codec?: string;
  pixFmt?: string;
  colorRange?: string;
  colorPrimaries?: string;
  colorTransfer?: string;
  colorSpace?: string;
  hdr?: boolean;
  audio?: { sr: number; ch: number } | null;
}
export interface ProbeResult {
  kind: 'video' | 'audio' | 'image';
  probe: ProbeInfo;
  warnings: string[];
}

const rate = (s?: string) => {
  if (!s) return undefined;
  const [n, d] = s.split('/').map(Number);
  return n && d ? n / d : undefined;
};
const clean = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== 'unknown')) as T;

/**
 * Reads up to 600 video packet timestamps and flags non-constant spacing.
 * Heuristic: VFR when avg/r frame rates disagree by >2%, or more than 2% of pts deltas deviate
 * from the median by >10%. Limit: only the first 600 packets are examined.
 */
export async function detectVfr(
  path: string,
  avg?: number,
  r?: number,
): Promise<{ vfr: boolean; method: string }> {
  if (avg && r && Math.abs(avg - r) / r > 0.02) {
    return {
      vfr: true,
      method: `avg_frame_rate ${avg.toFixed(3)} differs from r_frame_rate ${r.toFixed(3)}`,
    };
  }
  const res = await run(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-read_intervals',
      '%+#600',
      '-show_entries',
      'packet=pts_time',
      '-of',
      'csv=p=0',
      path,
    ],
    { timeoutMs: 60_000 },
  );
  const pts = res.stdout
    .split('\n')
    .map((l) => parseFloat(l))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (pts.length < 10) return { vfr: false, method: 'too few packets to test; assumed CFR' };
  const deltas = pts
    .slice(1)
    .map((v, i) => v - pts[i]!)
    .filter((d) => d > 1e-6);
  const med = [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length / 2)]!;
  const bad = deltas.filter((d) => Math.abs(d - med) / med > 0.1).length;
  return {
    vfr: bad / deltas.length > 0.02,
    method: `${bad}/${deltas.length} pts deltas off median ${(med * 1000).toFixed(2)} ms by >10%`,
  };
}

export async function probeFile(path: string): Promise<ProbeResult> {
  const r = await run(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    { timeoutMs: 60_000 },
  );
  if (r.code !== 0) {
    throw new EngineError(
      'UNSUPPORTED_INPUT',
      `ffprobe cannot read ${path}: ${lastLine(r.stderr).replace(path + ': ', '')}`,
      'check the file is a complete, non-corrupt media file',
    );
  }
  let j: any;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    throw new EngineError('ENGINE_FAILED', 'ffprobe returned invalid JSON');
  }
  const streams: any[] = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v && !a)
    throw new EngineError(
      'UNSUPPORTED_INPUT',
      `${path} has no video or audio stream`,
      'ingest only supports files with at least one decodable stream',
    );

  const warnings: string[] = [];
  const fmt: string = j.format?.format_name ?? '';
  const frames = Number(v?.nb_frames);
  const isImage =
    !!v &&
    !a &&
    (fmt === 'image2' || /_pipe$/.test(fmt)) &&
    (!Number.isFinite(frames) || frames <= 1);
  const durS = Number(j.format?.duration ?? v?.duration ?? a?.duration);
  const probe: ProbeInfo = {};
  if (Number.isFinite(durS) && !isImage) probe.durMs = Math.round(durS * 1000);
  if (!isImage && probe.durMs === 0)
    throw new EngineError('UNSUPPORTED_INPUT', `${path} has zero duration`);

  if (v) {
    const avg = rate(v.avg_frame_rate);
    const rfr = rate(v.r_frame_rate);
    let rotation = 0;
    const dm = (v.side_data_list ?? []).find((s: any) => s.side_data_type === 'Display Matrix');
    // ffprobe reports the rotation to apply counterclockwise; the project stores clockwise-to-upright.
    if (dm && typeof dm.rotation === 'number') rotation = ((-dm.rotation % 360) + 360) % 360;
    else if (v.tags?.rotate) rotation = ((Number(v.tags.rotate) % 360) + 360) % 360;
    const trc: string | undefined = v.color_transfer;
    Object.assign(
      probe,
      clean({
        w: v.width,
        h: v.height,
        codec: v.codec_name,
        pixFmt: v.pix_fmt,
        colorRange: v.color_range,
        colorPrimaries: v.color_primaries,
        colorTransfer: trc,
        colorSpace: v.color_space,
        rotation,
        hdr: trc === 'smpte2084' || trc === 'arib-std-b67' ? true : undefined,
      }),
    );
    if (!isImage) {
      probe.fps = avg ? Math.round(avg * 1000) / 1000 : undefined;
      probe.rFps = rfr ? Math.round(rfr * 1000) / 1000 : undefined;
      const vf = await detectVfr(path, avg, rfr);
      probe.vfr = vf.vfr;
      if (vf.vfr) warnings.push(`variable frame rate: ${vf.method}`);
    }
    if (probe.hdr)
      warnings.push(`HDR source (${trc}); no tone-mapping is applied, it is kept as is`);
    if (rotation)
      warnings.push(
        `rotation ${rotation}° (display matrix); applied explicitly at render, not baked into the original`,
      );
  }
  probe.audio = a ? { sr: Number(a.sample_rate), ch: Number(a.channels) } : null;
  if (!a && !isImage) warnings.push('no audio stream');
  if (a && probe.audio && probe.audio.sr !== 48000)
    warnings.push(`audio is ${probe.audio.sr} Hz; converted to 48 kHz once at render`);
  return {
    kind: isImage ? 'image' : v ? 'video' : 'audio',
    probe: clean(probe) as ProbeInfo,
    warnings,
  };
}
