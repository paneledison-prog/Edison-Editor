import { ProjectSchema, type Project, type Track, type Clip } from './schema.js';

export interface Issue {
  code: string;
  message: string;
  path?: string;
}

const ACCEPTS: Record<Track['type'], ReadonlyArray<'video' | 'audio' | 'image'>> = {
  video: ['video', 'image'],
  audio: ['audio', 'video'],
  graphics: ['image'],
  captions: [],
};

/**
 * Invariants from rules/01 that must hold after every op.
 * Not enforced yet (no registry exists before Phase 4): that `comp` ids and `token:` references exist.
 */
export function validateProject(p: unknown): Issue[] {
  const parsed = ProjectSchema.safeParse(p);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => ({
      code: 'SCHEMA',
      message: i.message,
      path: i.path.join('.'),
    }));
  }
  const proj: Project = parsed.data;
  const issues: Issue[] = [];
  const add = (code: string, message: string, path?: string) =>
    issues.push({ code, message, path });

  const trackById = new Map<string, Track>();
  for (const t of proj.tracks) {
    if (trackById.has(t.id)) add('DUP_ID', `duplicate track id ${t.id}`, `tracks.${t.id}`);
    trackById.set(t.id, t);
  }

  const clipIds = new Set<string>();
  const kfIds = new Set<string>();
  const byTrack = new Map<string, Clip[]>();
  for (const c of proj.clips) {
    if (clipIds.has(c.id)) add('DUP_ID', `duplicate clip id ${c.id}`, `clips.${c.id}`);
    clipIds.add(c.id);
    const track = trackById.get(c.track);
    if (!track) {
      add('MISSING_REF', `clip ${c.id} references missing track ${c.track}`, `clips.${c.id}.track`);
      continue;
    }
    (byTrack.get(c.track) ?? byTrack.set(c.track, []).get(c.track)!).push(c);

    if (c.asset !== undefined) {
      const a = proj.assets[c.asset];
      if (!a) {
        add(
          'MISSING_REF',
          `clip ${c.id} references missing asset ${c.asset}`,
          `clips.${c.id}.asset`,
        );
      } else {
        if (!ACCEPTS[track.type].includes(a.kind)) {
          add(
            'TRACK_KIND',
            `${a.kind} asset ${c.asset} cannot go on ${track.type} track ${track.id}`,
            `clips.${c.id}`,
          );
        }
        if ((a.kind === 'video' || a.kind === 'audio') && a.probe.durMs !== undefined) {
          if ((c.srcIn ?? 0) + c.dur > a.probe.durMs) {
            add(
              'SRC_BOUNDS',
              `clip ${c.id}: srcIn+dur ${(c.srcIn ?? 0) + c.dur} ms exceeds asset duration ${a.probe.durMs} ms`,
              `clips.${c.id}`,
            );
          }
        }
      }
    } else if (track.type === 'video' || track.type === 'audio') {
      add('TRACK_KIND', `clip ${c.id}: ${track.type} track needs an asset`, `clips.${c.id}`);
    }

    for (const [prop, kfs] of Object.entries(c.keyframes ?? {})) {
      let prev = -1;
      for (const k of kfs) {
        if (kfIds.has(k.id))
          add('DUP_ID', `duplicate keyframe id ${k.id}`, `clips.${c.id}.keyframes.${prop}`);
        kfIds.add(k.id);
        if (k.t > c.dur)
          add(
            'KF_BOUNDS',
            `clip ${c.id} ${prop}: keyframe at ${k.t} ms is after clip end (${c.dur} ms)`,
            `clips.${c.id}.keyframes.${prop}`,
          );
        if (k.t <= prev)
          add(
            'KF_ORDER',
            `clip ${c.id} ${prop}: keyframe times must be strictly increasing (${prev} then ${k.t})`,
            `clips.${c.id}.keyframes.${prop}`,
          );
        prev = k.t;
      }
    }
  }

  for (const [trackId, clips] of byTrack) {
    const type = trackById.get(trackId)!.type;
    if (type === 'graphics') continue; // overlaps allowed only here
    const sorted = [...clips].sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1]!;
      const b = sorted[i]!;
      if (a.start + a.dur > b.start) {
        add(
          'OVERLAP',
          `clips ${a.id} and ${b.id} overlap on ${type} track ${trackId} (${a.start + a.dur} ms > ${b.start} ms)`,
          `tracks.${trackId}`,
        );
      }
    }
  }

  const ids = new Set<string>();
  for (const m of proj.markers) {
    if (ids.has(m.id)) add('DUP_ID', `duplicate marker id ${m.id}`, `markers.${m.id}`);
    ids.add(m.id);
  }
  const exps = new Set<string>();
  for (const e of proj.exports) {
    if (exps.has(e.id)) add('DUP_ID', `duplicate export id ${e.id}`, `exports.${e.id}`);
    exps.add(e.id);
  }
  return issues;
}
