/**
 * Caption cues: building from word timestamps, checking against the rules/06 limits, and sidecar export.
 * Pure functions on millisecond integers, so every result is reproducible and testable.
 */

export interface TWord {
  w: string;
  /** ms */
  start: number;
  end: number;
  /** recognizer probability 0..1 (absent for hand-written transcripts) */
  p?: number;
  review?: boolean;
}

export interface Cue {
  /** 1-based index */
  i: number;
  start: number;
  end: number;
  /** 1 or 2 lines, already broken */
  lines: string[];
  /** Words with the line each sits on, for karaoke highlight */
  words: { w: string; start: number; end: number; line: number }[];
  review?: boolean;
}

export interface CueLimits {
  maxLines: number;
  maxChars: number;
  /** characters per second */
  maxCps: number;
  minDurMs: number;
  maxDurMs: number;
  /** ms before the first word that the cue appears (rounded to whole frames by the builder) */
  leadFrames: number;
  /** ms the cue may linger after the last word */
  tailMs: number;
  minGapFrames: number;
  /** social style: force at most this many words per cue (cps and min duration are relaxed) */
  wordsPerCue?: number;
}

export const DEFAULT_LIMITS: CueLimits = {
  maxLines: 2,
  maxChars: 42,
  maxCps: 17,
  minDurMs: 1000,
  maxDurMs: 7000,
  leadFrames: 1,
  tailMs: 250,
  minGapFrames: 2,
};

const ARTICLES = new Set([
  'a',
  'an',
  'the',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'with',
  'by',
  'and',
  'or',
  'but',
  'my',
  'your',
  'our',
  'their',
  'his',
  'her',
  'its',
  'this',
  'that',
]);
const CONJ = new Set([
  'and',
  'but',
  'or',
  'so',
  'because',
  'which',
  'when',
  'while',
  'that',
  'then',
]);
const UNITS =
  /^(%|percent|ms|s|sec|seconds?|minutes?|hours?|days?|kb|mb|gb|tb|k|m|km|kg|lb|lbs|dollars?|euros?|pounds?|x|fps|hz|khz|db)$/i;

const frameMs = (fps: number) => 1000 / fps;
export const chars = (s: string) => [...s].length;

/** True when a break after words[i] would split something that should stay together. */
function bound(words: TWord[], i: number): boolean {
  const a = words[i]!.w;
  const b = words[i + 1]?.w;
  if (b === undefined) return false;
  if (ARTICLES.has(a.toLowerCase().replace(/[^\w']/g, '')) && !/[,.;:!?]$/.test(a)) return true;
  if (/\d/.test(a) && UNITS.test(b.replace(/[^\w%]/g, ''))) return true;
  // Two consecutive capitalized words that are not at a sentence start read as one name.
  const prevEnds = i > 0 && /[.!?]$/.test(words[i - 1]!.w);
  if (/^[A-Z][a-z]/.test(a) && /^[A-Z][a-z]/.test(b) && i > 0 && !prevEnds && !/[,.;:!?]$/.test(a))
    return true;
  return false;
}

/** Score for ending a cue (or a line) after words[i]; higher is a better place to break. */
function breakScore(words: TWord[], i: number): number {
  const a = words[i]!.w;
  if (bound(words, i)) return -100;
  if (/[.!?]$/.test(a)) return 30;
  if (/[,;:—]$/.test(a)) return 18;
  const b = words[i + 1]?.w;
  if (b && CONJ.has(b.toLowerCase())) return 10;
  return 0;
}

/** Best way to put `words` on at most `maxLines` lines of `maxChars`; null when it cannot fit. */
export function breakLines(
  words: TWord[],
  limits: CueLimits,
): { lines: string[]; lineOf: number[] } | null {
  const text = words.map((x) => x.w).join(' ');
  if (chars(text) <= limits.maxChars) return { lines: [text], lineOf: words.map(() => 0) };
  if (limits.maxLines < 2) return null;
  let best: { k: number; s: number } | null = null;
  for (let k = 0; k < words.length - 1; k++) {
    const l1 = chars(
      words
        .slice(0, k + 1)
        .map((x) => x.w)
        .join(' '),
    );
    const l2 = chars(
      words
        .slice(k + 1)
        .map((x) => x.w)
        .join(' '),
    );
    if (l1 > limits.maxChars || l2 > limits.maxChars) continue;
    // Balanced lines, a natural break point, and the longer line on the bottom.
    const s = breakScore(words, k) - Math.abs(l1 - l2) * 0.5 - (l1 > l2 ? 1 : 0);
    if (!best || s > best.s) best = { k, s };
  }
  if (!best) return null;
  const lineOf = words.map((_, i) => (i <= best!.k ? 0 : 1));
  return {
    lines: [
      words
        .slice(0, best.k + 1)
        .map((x) => x.w)
        .join(' '),
      words
        .slice(best.k + 1)
        .map((x) => x.w)
        .join(' '),
    ],
    lineOf,
  };
}

/**
 * Groups words into cues. A cue closes at a sentence end, a long pause, or when the next word would break a limit;
 * when it must close mid-sentence it closes at the best break point among its last words.
 */
export function buildCues(words: TWord[], fps: number, over: Partial<CueLimits> = {}): Cue[] {
  const L = { ...DEFAULT_LIMITS, ...over };
  const groups: TWord[][] = [];
  let cur: TWord[] = [];
  const fits = (ws: TWord[]) => {
    if (L.wordsPerCue) return ws.length <= L.wordsPerCue && breakLines(ws, L) !== null;
    if (!breakLines(ws, L)) return false;
    const dur = ws[ws.length - 1]!.end - ws[0]!.start;
    return dur <= L.maxDurMs;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const candidate = [...cur, w];
    if (cur.length && !fits(candidate)) {
      // Close at the best break among the last few words of `cur`.
      let cut = cur.length;
      if (!L.wordsPerCue && cur.length > 2) {
        let bestS = -Infinity;
        for (let k = Math.max(0, cur.length - 6); k < cur.length - 1; k++) {
          const s = breakScore(cur, k) - (cur.length - 1 - k) * 2;
          if (s > bestS) {
            bestS = s;
            cut = k + 1;
          }
        }
        if (bestS < 0 && !bound(cur, cur.length - 1)) cut = cur.length;
      }
      groups.push(cur.slice(0, cut));
      cur = [...cur.slice(cut), w];
    } else cur = candidate;
    const next = words[i + 1];
    const pause = next ? next.start - w.end : Infinity;
    if (/[.!?]$/.test(w.w) || pause >= 700 || !next) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length) groups.push(cur);

  const lead = Math.round(L.leadFrames * frameMs(fps));
  const gap = Math.ceil(L.minGapFrames * frameMs(fps));
  const cues: Cue[] = groups
    .filter((g) => g.length)
    .map((g, k) => {
      const b = breakLines(g, L) ?? {
        lines: [g.map((x) => x.w).join(' ')],
        lineOf: g.map(() => 0),
      };
      return {
        i: k + 1,
        start: Math.max(0, Math.round(g[0]!.start - lead)),
        end: Math.round(g[g.length - 1]!.end + L.tailMs),
        lines: b.lines,
        words: g.map((x, j) => ({ w: x.w, start: x.start, end: x.end, line: b.lineOf[j]! })),
        ...(g.some((x) => x.review) ? { review: true } : {}),
      };
    });
  // Enforce gaps, then stretch short or fast cues into free space (never into the next cue's lead-in).
  for (let k = 0; k < cues.length; k++) {
    const c = cues[k]!;
    const next = cues[k + 1];
    const ceiling = next ? next.start - gap : Infinity;
    const lastWordEnd = c.words[c.words.length - 1]!.end;
    c.end = Math.min(c.end, ceiling);
    c.end = Math.max(c.end, Math.min(lastWordEnd, ceiling));
    if (!L.wordsPerCue) {
      const need = Math.max(L.minDurMs, Math.ceil((chars(c.lines.join(' ')) / L.maxCps) * 1000));
      if (c.end - c.start < need) c.end = Math.min(c.start + need, ceiling, c.start + L.maxDurMs);
    }
  }
  return cues;
}

export interface CueViolation {
  cue: number;
  rule:
    | 'lines'
    | 'line-chars'
    | 'cps'
    | 'min-dur'
    | 'max-dur'
    | 'gap'
    | 'order'
    | 'safe-zone'
    | 'empty';
  detail: string;
  value: number | string;
}

export interface SafeZone {
  /** fraction of the frame kept free on each side */
  top: number;
  bottom: number;
  side: number;
}
/** Context.md §7: vertical outputs keep ~12% top, 22% bottom, 8% sides clear; horizontal keeps 5% margins. */
export const safeZoneFor = (w: number, h: number): SafeZone =>
  h > w ? { top: 0.12, bottom: 0.22, side: 0.08 } : { top: 0.05, bottom: 0.05, side: 0.05 };

/** Checks cues by script. `relaxed` (social style) skips cps and min-duration only. */
export function checkCues(
  cues: Cue[],
  fps: number,
  o: {
    limits?: Partial<CueLimits>;
    relaxed?: boolean;
    placement?: { w: number; h: number; box: { x: number; y: number; w: number; h: number } };
  } = {},
): CueViolation[] {
  const L = { ...DEFAULT_LIMITS, ...o.limits };
  const out: CueViolation[] = [];
  const gapMs = (L.minGapFrames * 1000) / fps;
  cues.forEach((c, k) => {
    const dur = c.end - c.start;
    const text = c.lines.join(' ');
    if (!c.lines.length || !text.trim())
      out.push({ cue: c.i, rule: 'empty', detail: 'cue has no text', value: 0 });
    if (c.lines.length > L.maxLines)
      out.push({
        cue: c.i,
        rule: 'lines',
        detail: `${c.lines.length} lines, max ${L.maxLines}`,
        value: c.lines.length,
      });
    for (const ln of c.lines)
      if (chars(ln) > L.maxChars)
        out.push({
          cue: c.i,
          rule: 'line-chars',
          detail: `line of ${chars(ln)} characters, max ${L.maxChars}: "${ln}"`,
          value: chars(ln),
        });
    const cps = chars(text) / (dur / 1000);
    if (!o.relaxed && cps > 20)
      out.push({
        cue: c.i,
        rule: 'cps',
        detail: `${cps.toFixed(1)} characters per second, max 20`,
        value: Math.round(cps * 10) / 10,
      });
    if (!o.relaxed && dur < L.minDurMs)
      out.push({ cue: c.i, rule: 'min-dur', detail: `${dur} ms, min ${L.minDurMs}`, value: dur });
    if (dur > L.maxDurMs)
      out.push({ cue: c.i, rule: 'max-dur', detail: `${dur} ms, max ${L.maxDurMs}`, value: dur });
    const prev = cues[k - 1];
    if (prev && c.start < prev.end)
      out.push({
        cue: c.i,
        rule: 'order',
        detail: `starts ${prev.end - c.start} ms before cue ${prev.i} ends`,
        value: prev.end - c.start,
      });
    else if (prev && c.start - prev.end < gapMs - 1)
      out.push({
        cue: c.i,
        rule: 'gap',
        detail: `${c.start - prev.end} ms after cue ${prev.i}, min ${Math.ceil(gapMs)}`,
        value: c.start - prev.end,
      });
    if (o.placement) {
      const z = safeZoneFor(o.placement.w, o.placement.h);
      const b = o.placement.box;
      const bad =
        b.x < z.side * o.placement.w - 0.5 ||
        b.x + b.w > (1 - z.side) * o.placement.w + 0.5 ||
        b.y < z.top * o.placement.h - 0.5 ||
        b.y + b.h > (1 - z.bottom) * o.placement.h + 0.5;
      if (bad)
        out.push({
          cue: c.i,
          rule: 'safe-zone',
          detail: `caption box ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}x${Math.round(b.h)} leaves the safe zone`,
          value: 'outside',
        });
    }
  });
  return out;
}

// ---- sidecar formats ---------------------------------------------------------------

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
function stamp(ms: number, sep: ',' | '.'): string {
  const t = Math.max(0, Math.round(ms));
  return `${pad(Math.floor(t / 3600000))}:${pad(Math.floor(t / 60000) % 60)}:${pad(Math.floor(t / 1000) % 60)}${sep}${pad(t % 1000, 3)}`;
}
export const toSrt = (cues: Cue[]) =>
  cues
    .map((c) => `${c.i}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.lines.join('\n')}\n`)
    .join('\n');

export function toVtt(cues: Cue[], note?: string): string {
  return (
    `WEBVTT${note ? `\n\nNOTE ${note}` : ''}\n\n` +
    cues
      .map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.lines.join('\n')}\n`)
      .join('\n')
  );
}

export interface AssStyle {
  font: string;
  sizePx: number;
  /** #RRGGBB */
  text: string;
  outline: string;
  box?: string;
  bold: boolean;
  marginV: number;
  marginH: number;
  /** ASS numpad alignment: 2 bottom-center, 8 top-center, 5 middle */
  align: 2 | 5 | 8;
}
const assColor = (hex: string, alpha = 0) => {
  const h = hex.replace('#', '');
  return `&H${pad(alpha, 2).toUpperCase()}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
};
function assStamp(ms: number) {
  const cs = Math.round(ms / 10);
  return `${Math.floor(cs / 360000)}:${pad(Math.floor(cs / 6000) % 60)}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`;
}
export function toAss(
  cues: Cue[],
  s: AssStyle,
  canvas: { w: number; h: number },
  title = 'Studio captions',
): string {
  const back = s.box ? assColor(s.box.slice(0, 7), 0x40) : assColor('#000000', 0xff);
  return [
    '[Script Info]',
    `Title: ${title}`,
    'ScriptType: v4.00+',
    `PlayResX: ${canvas.w}`,
    `PlayResY: ${canvas.h}`,
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${s.font},${s.sizePx},${assColor(s.text)},${assColor(s.text)},${assColor(s.outline)},${back},${s.bold ? -1 : 0},0,0,0,100,100,0,0,${s.box ? 3 : 1},${s.box ? 8 : Math.max(2, Math.round(s.sizePx / 14))},0,${s.align},${s.marginH},${s.marginH},${s.marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...cues.map(
      (c) =>
        `Dialogue: 0,${assStamp(c.start)},${assStamp(c.end)},Default,,0,0,0,,${c.lines.join('\\N')}`,
    ),
    '',
  ].join('\n');
}

/** Sidecar text is checked for characters a renderer or player may drop. */
export const NEEDS_SHAPING = /[֐-ࣿऀ-෿฀-໿က-႟]/;

/** Caption boxes (from the real layout) that leave the safe zone. */
export function safeZoneViolations(
  boxes: { cue: number; x: number; y: number; w: number; h: number }[],
  w: number,
  h: number,
): CueViolation[] {
  const z = safeZoneFor(w, h);
  const out: CueViolation[] = [];
  for (const b of boxes) {
    const bad =
      b.x < z.side * w - 0.5 ||
      b.x + b.w > (1 - z.side) * w + 0.5 ||
      b.y < z.top * h - 0.5 ||
      b.y + b.h > (1 - z.bottom) * h + 0.5;
    if (bad)
      out.push({
        cue: b.cue,
        rule: 'safe-zone',
        detail: `caption box ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}x${Math.round(b.h)} leaves the safe zone of ${w}x${h}`,
        value: 'outside',
      });
  }
  return out;
}

const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lumOf = (hex: string) => {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => lin(parseInt(h.slice(i, i + 2), 16) / 255)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG contrast ratio of two #RRGGBB colors. A translucent color is first composited over `under` (default black). */
export function contrastRatio(a: string, b: string, under = '#000000'): number {
  const flat = (c: string) => {
    if (c.length < 9) return c.slice(0, 7);
    const al = parseInt(c.slice(7, 9), 16) / 255;
    const u = under.replace('#', '');
    const ch = (i: number) =>
      Math.round(
        parseInt(c.slice(1 + i, 3 + i), 16) * al + parseInt(u.slice(i, i + 2), 16) * (1 - al),
      );
    return '#' + [0, 2, 4].map((i) => ch(i).toString(16).padStart(2, '0')).join('');
  };
  const [hi, lo] = [lumOf(flat(a)), lumOf(flat(b))].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
