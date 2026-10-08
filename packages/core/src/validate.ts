import { ProjectSchema, speedOf, type Project, type Track, type Clip } from './schema.js';

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
 * `comp` ids and props are checked against the template catalogue when a composition clip is added (`tl add-clip`) and at render time, not here: core does not depend on the motion package.
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
          const srcEnd = (c.srcIn ?? 0) + Math.round(c.dur * speedOf(c));
          if (srcEnd > a.probe.durMs) {
            add(
              'SRC_BOUNDS',
              `clip ${c.id}: source range end ${srcEnd} ms (srcIn + dur x speed) exceeds asset duration ${a.probe.durMs} ms`,
              `clips.${c.id}`,
            );
          }
        }
      }
    } else if (track.type === 'video' || track.type === 'audio') {
      add('TRACK_KIND', `clip ${c.id}: ${track.type} track needs an asset`, `clips.${c.id}`);
    }

    const fxSeen = new Set<string>();
    const nodeIds = new Set<string>();
    for (const f of c.fx ?? []) {
      const node = (f as { node?: string }).node;
      if (node) {
        if (nodeIds.has(node)) add('DUP_ID', `clip ${c.id}: two effects are named ${node}`, `clips.${c.id}.fx`);
        nodeIds.add(node);
      }
      if (['speed', 'loudnorm', 'duck'].includes(f.type)) {
        if (fxSeen.has(f.type))
          add('FX_INVALID', `clip ${c.id}: more than one ${f.type} effect`, `clips.${c.id}.fx`);
        fxSeen.add(f.type);
      }
      if (f.type === 'duck') {
        const by = trackById.get(f.by);
        if (!by)
          add(
            'MISSING_REF',
            `clip ${c.id}: duck references missing track ${f.by}`,
            `clips.${c.id}.fx`,
          );
        else if (by.type !== 'audio' && by.type !== 'video')
          add(
            'FX_INVALID',
            `clip ${c.id}: duck sidechain track ${f.by} is a ${by.type} track, not audio or video`,
            `clips.${c.id}.fx`,
          );
        else if (f.by === c.track)
          add(
            'FX_INVALID',
            `clip ${c.id}: a clip cannot duck by its own track`,
            `clips.${c.id}.fx`,
          );
      }
      if (f.type === 'stabilize' || f.type === 'pin') {
        const tk = proj.trackers?.[f.tracker];
        if (track.type !== 'video') add('FX_INVALID', `clip ${c.id}: ${f.type} needs a video track`, `clips.${c.id}.fx`);
        if (!tk) add('MISSING_REF', `clip ${c.id}: ${f.type} uses tracker ${f.tracker}, which does not exist`, `clips.${c.id}.fx`);
        else if (tk.asset !== c.asset)
          add('FX_INVALID', `clip ${c.id}: tracker ${f.tracker} was made on ${tk.asset}, but this clip plays ${c.asset ?? 'a composition'}`, `clips.${c.id}.fx`);
        if (f.type === 'pin') {
          const pa = proj.assets[f.asset];
          if (!pa) add('MISSING_REF', `clip ${c.id}: pin uses missing asset ${f.asset}`, `clips.${c.id}.fx`);
          else if (pa.kind === 'audio') add('FX_INVALID', `clip ${c.id}: pin needs an image or video asset, ${f.asset} is audio`, `clips.${c.id}.fx`);
        }
        if (f.type === 'stabilize' && fxSeen.has('stabilize'))
          add('FX_INVALID', `clip ${c.id}: more than one stabilize effect`, `clips.${c.id}.fx`);
        if (f.type === 'stabilize') fxSeen.add('stabilize');
      }
      if (f.type === 'lut' && track.type !== 'video' && track.type !== 'graphics')
        add('FX_INVALID', `clip ${c.id}: lut needs a video track`, `clips.${c.id}.fx`);
      if (f.type === 'plugin' && track.type !== 'video' && track.type !== 'graphics')
        add('FX_INVALID', `clip ${c.id}: plugin effect ${f.id} needs a video track`, `clips.${c.id}.fx`);
      if (f.type === 'blur-region') {
        if (track.type !== 'video' && track.type !== 'graphics')
          add('FX_INVALID', `clip ${c.id}: blur-region needs a video track`, `clips.${c.id}.fx`);
        else if (f.x + f.w > 1.0001 || f.y + f.h > 1.0001)
          add(
            'FX_INVALID',
            `clip ${c.id}: blur-region extends outside the frame`,
            `clips.${c.id}.fx`,
          );
      }
      if (
        [
          'speed',
          'gain',
          'highpass',
          'denoise',
          'eq',
          'compress',
          'limit',
          'loudnorm',
          'duck',
        ].includes(f.type) &&
        track.type !== 'video' &&
        track.type !== 'audio'
      ) {
        add(
          'FX_INVALID',
          `clip ${c.id}: ${f.type} needs a video or audio track`,
          `clips.${c.id}.fx`,
        );
      }
    }
    for (const [prop, kfs] of Object.entries(c.keyframes ?? {})) {
      // A keyframe on an effect (`fx.<node>.<name>`) must name an effect that is on this clip.
      const m = /^fx\.(f_[^.]+)\.([A-Za-z][\w]*)$/.exec(prop);
      if (prop.startsWith('fx.') && !m)
        add('KF_TARGET', `clip ${c.id}: "${prop}" is not an effect keyframe name (fx.<node>.<parameter>)`, `clips.${c.id}.keyframes.${prop}`);
      else if (m && !nodeIds.has(m[1]!))
        add('KF_TARGET', `clip ${c.id}: keyframes on "${prop}" but the clip has no effect ${m[1]}`, `clips.${c.id}.keyframes.${prop}`);
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

  for (const [id, tk] of Object.entries(proj.trackers ?? {})) {
    const a = proj.assets[tk.asset];
    if (!a) add('MISSING_REF', `tracker ${id} was made on ${tk.asset}, which does not exist`, `trackers.${id}`);
    else if (a.kind !== 'video') add('FX_INVALID', `tracker ${id}: ${tk.asset} is ${a.kind}, only video can be tracked`, `trackers.${id}`);
    if (!(tk.from <= tk.at && tk.at <= tk.to)) add('FX_INVALID', `tracker ${id}: the reference time ${tk.at} ms is outside ${tk.from}..${tk.to} ms`, `trackers.${id}`);
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
