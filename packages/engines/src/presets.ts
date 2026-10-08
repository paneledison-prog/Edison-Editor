/** Defaults from Context §7. Platform specs change: check current platform docs before publishing. */
export interface Preset {
  id: string;
  /** null = use the project canvas */
  w: number | null;
  h: number | null;
  /** null = project fps */
  fps: number | null;
  kind: 'video' | 'gif';
  crf: number;
  x264Preset: string;
  audioKbps: number | null;
  /** Integrated loudness target (LUFS) and true-peak ceiling (dBTP); null = no audio normalization */
  loudness: { I: number; TP: number } | null;
  ext: 'mp4' | 'gif' | 'mov';
}

const v = (
  id: string,
  w: number,
  h: number,
  fps: number | null,
  crf: number,
  audioKbps = 192,
): Preset => ({
  id,
  w,
  h,
  fps,
  kind: 'video',
  crf,
  x264Preset: 'medium',
  audioKbps,
  loudness: { I: -14, TP: -1.5 },
  ext: 'mp4',
});

export const PRESETS: Record<string, Preset> = {
  'youtube-1080p': v('youtube-1080p', 1920, 1080, null, 19),
  'youtube-4k': v('youtube-4k', 3840, 2160, null, 18, 256),
  'vertical-1080x1920': v('vertical-1080x1920', 1080, 1920, 30, 20),
  'square-1080': v('square-1080', 1080, 1080, 30, 20),
  'portrait-4x5': v('portrait-4x5', 1080, 1350, 30, 20),
  'overlay-alpha': {
    id: 'overlay-alpha',
    w: null,
    h: null,
    fps: null,
    kind: 'video',
    crf: 0,
    x264Preset: '',
    audioKbps: null,
    loudness: null,
    ext: 'mov',
  },
  'gif-small': {
    id: 'gif-small',
    w: null,
    h: null,
    fps: 12,
    kind: 'gif',
    crf: 0,
    x264Preset: '',
    audioKbps: null,
    loudness: null,
    ext: 'gif',
  },
};

/** A fast, low-resolution render for checking edits. Uses the same backend as finals. */
export const PREVIEW: Preset = {
  id: 'preview',
  w: null,
  h: null,
  fps: null,
  kind: 'video',
  crf: 30,
  x264Preset: 'veryfast',
  audioKbps: 96,
  loudness: null,
  ext: 'mp4',
};

export function getPreset(id: string): Preset {
  const p = PRESETS[id];
  if (!p) throw new Error(`unknown preset "${id}"; available: ${Object.keys(PRESETS).join(', ')}`);
  return p;
}
