/**
 * Transitions: how a clip comes in or goes out (`transIn`, `transOut` on the clip).
 *
 * A clip's `transIn` where it follows another clip on the same track with no gap is a transition between the two, centred on the
 * cut: for its duration both are on screen, the one before playing on past its out point and this one starting before its in
 * point, each from its own media (nothing is frozen: where a file has less to spare, the transition is shortened and says so).
 * Elsewhere a transition acts on its clip alone, over whatever is below it.
 *
 * In the render each transition is a change over time to one clip's own picture, after its placement, so it works the same for a
 * full frame and for a cut-out element: its opacity (dissolve), a moving mask (wipe), a colour mixed in (dip), or its position on
 * screen (push, slide). The audio is not touched: a clip lengthened for a transition has its sound cut back to its own length.
 */
import { speedOf, type Clip, type Project } from '@studio/core';
import { expr, pointsOf } from './zoom.js';

type Trans = NonNullable<Clip['transIn']>;
type Kind = Trans['kind'];
type Dir = NonNullable<Trans['dir']>;

/** A transition as it acts on one clip of the render: its window in the clip's own time (ms from the render clip's start). */
export interface ClipTrans {
  role: 'in' | 'out';
  kind: Kind;
  l0: number;
  l1: number;
  ease: string;
  dir: Dir;
  color: string;
  feather: number;
  /** a transition between two clips (each takes its part), or one clip alone */
  paired: boolean;
}

/** A clip as the render sees it: lengthened at its head or tail for a transition, with the transitions acting on it. */
export type RenderClip = Clip & {
  /** ms added before the clip's in point (the clip starts this much earlier) */
  headExtMs?: number;
  /** ms added after its out point */
  tailExtMs?: number;
  /** the clip's own start on the timeline (its time-driven effects keep this clock) */
  clockStartMs?: number;
  trans?: ClipTrans[];
};

/** What one transition does, for the command that sets it and for the render's notes. */
export interface TransitionPlan {
  clip: string;
  side: 'in' | 'out';
  kind: Kind;
  /** the clips the transition is between (the one before, this one); absent for a clip alone */
  between?: [string, string];
  /** where it runs on the timeline, ms */
  window: [number, number];
  /** what each clip has to spare beyond the cut, ms (Infinity for a still image) */
  spare?: { before: number; after: number };
  warnings: string[];
}

export const DEFAULT_EASE: Record<Kind, string> = { dissolve: 'linear', dip: 'linear', wipe: 'sine.inOut', push: 'sine.inOut', slide: 'sine.inOut' };

/**
 * The clips of the render with their transitions laid out, and a plan per transition. Run on the whole timeline, before a render
 * window cuts it.
 */
export function planTransitions(p: Project): { clips: RenderClip[]; plans: TransitionPlan[] } {
  const out = new Map<string, RenderClip>(p.clips.map((c) => [c.id, { ...c }]));
  const plans: TransitionPlan[] = [];
  // windows in timeline ms; turned into clip time once every clip has its final start
  const pending: { clip: string; t: Omit<ClipTrans, 'l0' | 'l1'> & { t0: number; t1: number } }[] = [];
  const media = (c: Clip) => !!c.asset && !c.comp && !!p.assets[c.asset];
  const spareBefore = (c: Clip) => (p.assets[c.asset!]!.kind === 'image' ? Infinity : (c.srcIn ?? 0) / speedOf(c));
  const spareAfter = (c: Clip) => {
    const a = p.assets[c.asset!]!;
    if (a.kind === 'image') return Infinity;
    const len = a.probe.durMs ?? 0;
    return Math.max(0, (len - ((c.srcIn ?? 0) + c.dur * speedOf(c))) / speedOf(c));
  };
  const pairedCuts = new Set<string>();
  const byStart = [...p.clips].sort((x, y) => x.start - y.start);
  for (const b of byStart) {
    const tr = b.transIn;
    if (!tr || !media(b)) continue;
    const base = { kind: tr.kind, ease: tr.ease ?? DEFAULT_EASE[tr.kind], dir: tr.dir ?? 'left', color: tr.color ?? '#000000', feather: tr.feather ?? 0 };
    const a = byStart.find((x) => x.id !== b.id && x.track === b.track && media(x) && Math.abs(x.start + x.dur - b.start) <= 1);
    const warnings: string[] = [];
    if (!a) {
      const d = Math.min(tr.dur, b.dur);
      pending.push({ clip: b.id, t: { ...base, role: 'in', paired: false, t0: b.start, t1: b.start + d } });
      plans.push({ clip: b.id, side: 'in', kind: tr.kind, window: [b.start, b.start + d], warnings });
      continue;
    }
    pairedCuts.add(a.id);
    // centred on the cut, each side as far as its media allows; what one side cannot give, the other gives if it can
    const before = spareBefore(b);
    const after = spareAfter(a);
    const half = Math.min(tr.dur, b.dur, a.dur) / 2;
    let eB = Math.min(half, before);
    const eA = Math.min(2 * half - eB, after);
    eB = Math.min(2 * half - eA, before);
    const T = b.start;
    if (eA + eB < 2 * half - 0.5) {
      const why = [before < half ? `${b.id} has ${Math.round(before)} ms before its in point` : '', after < half ? `${a.id} has ${Math.round(after)} ms after its out point` : ''].filter(Boolean).join(' and ');
      warnings.push(`the ${tr.kind} is ${Math.round(eA + eB)} ms instead of ${tr.dur}: ${why} (nothing is frozen to fill it; trim the clips to leave more)`);
    } else if (eB < half - 0.5 || eA < half - 0.5) {
      warnings.push(eB < half - 0.5 ? `${b.id} has only ${Math.round(before)} ms of its file before its in point, so the ${tr.kind} runs ${Math.round(half - eB)} ms later than centred on the cut` : `${a.id} has only ${Math.round(after)} ms of its file after its out point, so the ${tr.kind} runs ${Math.round(half - eA)} ms earlier than centred on the cut`);
    }
    if (eA + eB < 40) {
      warnings.push(`no transition: neither clip has media past the cut (it stays a cut)`);
      plans.push({ clip: b.id, side: 'in', kind: tr.kind, between: [a.id, b.id], window: [T, T], spare: { before, after }, warnings });
      continue;
    }
    const t0 = T - eB;
    const t1 = T + eA;
    const ra = out.get(a.id)!;
    ra.dur += Math.round(eA);
    ra.tailExtMs = (ra.tailExtMs ?? 0) + Math.round(eA);
    const rb = out.get(b.id)!;
    const sb = Math.round(eB);
    if (sb > 0) {
      rb.start -= sb;
      rb.dur += sb;
      rb.srcIn = Math.max(0, Math.round((rb.srcIn ?? 0) - sb * speedOf(b)));
      rb.headExtMs = (rb.headExtMs ?? 0) + sb;
      rb.clockStartMs = b.start;
      if (rb.keyframes) rb.keyframes = Object.fromEntries(Object.entries(rb.keyframes).map(([k, v]) => [k, v.map((x) => ({ ...x, t: x.t + sb }))]));
    }
    pending.push({ clip: b.id, t: { ...base, role: 'in', paired: true, t0, t1 } });
    pending.push({ clip: a.id, t: { ...base, role: 'out', paired: true, t0, t1 } });
    plans.push({ clip: b.id, side: 'in', kind: tr.kind, between: [a.id, b.id], window: [Math.round(t0), Math.round(t1)], spare: { before, after }, warnings });
  }
  for (const a of byStart) {
    const tr = a.transOut;
    if (!tr || !media(a)) continue;
    const base = { kind: tr.kind, ease: tr.ease ?? DEFAULT_EASE[tr.kind], dir: tr.dir ?? 'left', color: tr.color ?? '#000000', feather: tr.feather ?? 0 };
    if (pairedCuts.has(a.id)) {
      plans.push({ clip: a.id, side: 'out', kind: tr.kind, window: [a.start + a.dur, a.start + a.dur], warnings: [`${a.id}'s transition out is not used: the next clip's transition in covers this cut`] });
      continue;
    }
    const d = Math.min(tr.dur, a.dur);
    const end = a.start + a.dur;
    pending.push({ clip: a.id, t: { ...base, role: 'out', paired: false, t0: end - d, t1: end } });
    plans.push({ clip: a.id, side: 'out', kind: tr.kind, window: [end - d, end], warnings: [] });
  }
  for (const { clip, t } of pending) {
    const rc = out.get(clip)!;
    const { t0, t1, ...rest } = t;
    (rc.trans ??= []).push({ ...rest, l0: t0 - rc.start, l1: t1 - rc.start });
  }
  return { clips: p.clips.map((c) => out.get(c.id)!), plans };
}

const f3 = (v: number) => (Math.round(v * 1000) / 1000).toString();

/** The transition's progress 0..1 as an FFmpeg expression of `t` (seconds, the clip's own time), eased; held outside the window. */
export function progressExpr(tr: ClipTrans): string {
  return `(${expr(pointsOf([{ id: 'k_aaaa', t: tr.l0, v: 0, ease: tr.ease }, { id: 'k_bbbb', t: tr.l1, v: 1 }], 0))})`;
}

/**
 * The lines that change one clip's picture for its transitions, after its placement: opacity (dissolve), a mask (wipe), a colour
 * mixed in (dip). Reads `from`, writes `to`; `at` is the clip's start on the render's timeline (s). Empty when nothing to do.
 */
export function transitionLines(c: RenderClip, from: string, to: string, uid: string, o: { width: number; height: number; fps: number; at: string }): string[] {
  const list = (c.trans ?? []).filter((t) => t.kind === 'dissolve' || t.kind === 'wipe' || t.kind === 'dip');
  if (!list.length) return [];
  const { width: W, height: H, fps, at } = o;
  const dur = f3((c.dur + 2000 / fps) / 1000);
  const lines: string[] = [];
  let cur = from;
  list.forEach((t, i) => {
    const u = `${uid}${i}`;
    const P = progressExpr(t);
    const out = i === list.length - 1 ? to : `${u}o`;
    // a grey picture whose level follows an expression of the clip's time: tiny, then enlarged
    const level = (e: string, tag: string) => `color=c=black:s=16x16:r=${fps}:d=${dur},format=gray,geq=lum='255*clip(${e.replace(/\bt\b/g, 'T')},0,1)',scale=${W}:${H},setpts=PTS-STARTPTS+${at}/TB[${u}${tag}]`;
    const mulAlpha = (mask: string) => [`[${cur}]format=yuva420p,split=2[${u}p][${u}s]`, `[${u}s]alphaextract[${u}a]`, `[${u}a][${mask}]blend=all_mode=multiply[${u}am]`, `[${u}p][${u}am]alphamerge[${out}]`];
    const mid = (t.l0 + t.l1) / 2 / 1000;
    if (t.kind === 'dissolve') {
      // in: from nothing to all of it; out: only alone (in a pair the clip going out stays under the one coming in)
      if (t.role === 'out' && t.paired) lines.push(`[${cur}]null[${out}]`);
      else lines.push(level(t.role === 'in' ? P : `(1-${P})`, 'm'), ...mulAlpha(`${u}m`));
    } else if (t.kind === 'dip') {
      // through a colour: going out it turns to the colour (in a pair over the first half), coming in it turns from it (second half)
      const half = t.paired ? (t.role === 'out' ? { ...t, l1: (t.l0 + t.l1) / 2 } : { ...t, l0: (t.l0 + t.l1) / 2 }) : t;
      const Q = progressExpr(half);
      const amount = t.role === 'out' ? Q : `(1-${Q})`;
      lines.push(level(amount, 'm'));
      lines.push(`color=c=0x${t.color.slice(1, 7)}:s=${W}x${H}:r=${fps}:d=${dur},format=yuv420p,setpts=PTS-STARTPTS+${at}/TB[${u}c]`, `[${u}c][${u}m]alphamerge[${u}ca]`);
      lines.push(`[${cur}]format=yuva420p,split=2[${u}p][${u}s]`, `[${u}s]alphaextract[${u}a0]`, `[${u}p]format=yuv420p[${u}po]`, `[${u}po][${u}ca]overlay=format=auto[${u}pc]`);
      if (t.paired && t.role === 'in') {
        // the clip coming in shows only from the middle, when the one going out is all colour
        lines.push(level(`gte(t,${f3(mid)})`, 'g'), `[${u}a0][${u}g]blend=all_mode=multiply[${u}a]`);
      } else lines.push(`[${u}a0]null[${u}a]`);
      lines.push(`[${u}pc][${u}a]alphamerge[${out}]`);
    } else {
      // wipe: a black panel slides over a white frame; what it covers is hidden. The edge travels the frame plus the feather on
      // each side, so it starts and ends out of sight.
      if (t.role === 'out' && t.paired) {
        lines.push(`[${cur}]null[${out}]`);
        cur = out;
        return;
      }
      const F = t.feather;
      const horiz = t.dir === 'left' || t.dir === 'right';
      const span = (horiz ? W : H) + 2 * F;
      const e = `(${-F}+${span}*${P})`;
      const ax = horiz ? 'x' : 'y';
      // where the panel goes, by role and direction (see the docs: in = revealed, out = hidden, dir = the way the edge moves)
      const panel: Record<string, string> = {
        'in:right': `${e}`,
        'in:left': `-${e}`,
        'in:down': `${e}`,
        'in:up': `-${e}`,
        'out:right': `-${horiz ? W : H}+${e}`,
        'out:left': `${horiz ? W : H}-${e}`,
        'out:down': `-${horiz ? W : H}+${e}`,
        'out:up': `${horiz ? W : H}-${e}`,
      };
      const p0 = panel[`${t.role}:${t.dir}`]!;
      lines.push(
        `color=c=white:s=${W}x${H}:r=${fps}:d=${dur},format=gbrp[${u}w]`,
        `color=c=black:s=${W}x${H}:r=${fps}:d=${dur},format=gbrp[${u}b]`,
        `[${u}w][${u}b]overlay=${ax}='${p0}':${ax === 'x' ? 'y' : 'x'}=0:eval=frame:format=gbrp,format=gray${F > 0 ? `,gblur=sigma=${f3(F / 2)}` : ''},setpts=PTS-STARTPTS+${at}/TB[${u}m]`,
        ...mulAlpha(`${u}m`),
      );
    }
    cur = out;
  });
  return lines;
}

/** Where the clip sits on screen during a push or slide: x and y expressions of the timeline's `t` (s), or undefined. */
export function transitionOffset(c: RenderClip, o: { width: number; height: number }): { x: string; y: string } | undefined {
  const list = (c.trans ?? []).filter((t) => t.kind === 'push' || (t.kind === 'slide' && !(t.role === 'out' && t.paired)));
  if (!list.length) return undefined;
  const xs: string[] = [];
  const ys: string[] = [];
  const s = c.start / 1000;
  for (const t of list) {
    const P = progressExpr(t).replace(/\bt\b/g, `(t-${f3(s)})`);
    const amt = t.role === 'in' ? `(1-${P})` : P;
    // in: from off screen to its place, moving the way of dir; out: from its place off screen, the same way
    const sign = t.role === 'in' ? (t.dir === 'left' || t.dir === 'up' ? 1 : -1) : t.dir === 'left' || t.dir === 'up' ? -1 : 1;
    if (t.dir === 'left' || t.dir === 'right') xs.push(`${sign * o.width}*${amt}`);
    else ys.push(`${sign * o.height}*${amt}`);
  }
  return { x: xs.length ? xs.join('+') : '0', y: ys.length ? ys.join('+') : '0' };
}
