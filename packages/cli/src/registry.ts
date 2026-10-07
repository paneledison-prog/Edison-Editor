import type { FlagDef } from './args.js';

export interface CmdMeta {
  name: string;
  argv: string[];
  summary: string;
  usage: string;
  example: string;
  flags: FlagDef[];
  writes: boolean;
  /** Module loaded on demand, so `studio tools` never imports zod or an engine. */
  module: 'tools' | 'project' | 'ops' | 'tl' | 'doctor' | 'ingest' | 'cache' | 'render' | 'inspect';
  fn: string;
}

const s = (name: string, desc: string, required = false): FlagDef => ({
  name,
  type: 'string',
  desc,
  required,
});
const n = (name: string, desc: string, required = false): FlagDef => ({
  name,
  type: 'number',
  desc,
  required,
});
const b = (name: string, desc: string): FlagDef => ({ name, type: 'boolean', desc });
const cmd = (c: Omit<CmdMeta, 'argv' | 'fn'> & { fn?: string }): CmdMeta => ({
  ...c,
  argv: c.name.split('.'),
  fn:
    c.fn ??
    c.name
      .split('.')
      .pop()!
      .replace(/-./g, (m) => m[1]!.toUpperCase()),
});

/** The single source of the command surface. `studio tools` is generated from this list. */
export const COMMANDS: CmdMeta[] = [
  cmd({
    name: 'tools',
    module: 'tools',
    writes: false,
    summary: 'List every implemented command with flags and an example.',
    usage: 'studio tools [--json]',
    example: 'studio tools',
    flags: [],
  }),
  cmd({
    name: 'doctor',
    module: 'doctor',
    writes: false,
    summary: 'Check node, ffmpeg, encoders (by test-encoding), disk, and models.',
    usage: 'studio doctor',
    example: 'studio doctor',
    flags: [],
  }),
  cmd({
    name: 'init',
    module: 'project',
    writes: true,
    summary: 'Create a project in the project directory.',
    usage: 'studio init <name> [--width N --height N --fps N --background #rrggbb]',
    example: 'studio init "Demo v2" --width 1920 --height 1080 --fps 30',
    flags: [
      n('width', 'canvas width'),
      n('height', 'canvas height'),
      n('fps', 'project frame rate'),
      s('background', 'sRGB hex'),
    ],
  }),
  cmd({
    name: 'ingest',
    module: 'ingest',
    writes: true,
    summary: 'Probe, hash, copy into assets/, register as assets; derive proxy, thumbnails, peaks.',
    usage: 'studio ingest <path...> [--sync] [--no-derive]',
    example: 'studio ingest ~/rec.mp4 --sync',
    flags: [
      b('sync', 'build proxy/thumbs/peaks now instead of in a background process'),
      b('no-derive', 'skip proxy/thumbs/peaks (run `studio cache build` later)'),
      s('label', 'log label'),
    ],
  }),
  cmd({
    name: 'cache.build',
    module: 'cache',
    writes: true,
    summary: 'Build missing proxy, thumbnails, and peaks (resumable; skips finished artifacts).',
    usage: 'studio cache build [--assets a_x,a_y]',
    example: 'studio cache build',
    flags: [s('assets', 'comma-separated asset ids (default: all)')],
  }),
  cmd({
    name: 'render',
    module: 'render',
    writes: true,
    summary:
      'Render the timeline with the FFmpeg backend (two-pass loudness, safe write, versioned name).',
    usage:
      'studio render [--preset ID] [--range A:B] [--preview] [--still MS] [--out NAME] [--explain]',
    example: 'studio render --preset youtube-1080p',
    flags: [
      s(
        'preset',
        'youtube-1080p (default), youtube-4k, vertical-1080x1920, square-1080, portrait-4x5, gif-small',
      ),
      s('range', 'timeline range in ms, A:B'),
      b('preview', 'fast low-resolution render'),
      n('still', 'one PNG frame at this timeline ms'),
      s('out', 'output base name (default: <project>-<preset>-vN)'),
      s('encoder', 'video encoder (libx264 only for now)'),
      b('no-normalize', 'skip loudness normalization'),
      b('explain', 'print the plan and ffmpeg arguments, run nothing'),
    ],
  }),
  cmd({
    name: 'inspect.frame',
    module: 'inspect',
    writes: true,
    summary: "Extract PNG frames at times (ms). Also reports each frame's mean colour.",
    usage: 'studio inspect frame <file> --at MS[,MS...] [--width N]',
    example: 'studio inspect frame renders/demo-youtube-1080p-v1.mp4 --at 0,1500,4000',
    flags: [s('at', 'comma-separated times in ms', true), n('width', 'scale to this width')],
  }),
  cmd({
    name: 'inspect.sheet',
    module: 'inspect',
    writes: true,
    summary: 'Contact sheets, at most 24 tiles each, with tile times.',
    usage: 'studio inspect sheet <file> [--fps N] [--cols N] [--width N]',
    example: 'studio inspect sheet renders/demo-youtube-1080p-v1.mp4 --fps 1 --cols 6 --width 320',
    flags: [
      n('fps', 'tiles per second (default 1)'),
      n('cols', 'columns (default 6)'),
      n('width', 'tile width px (default 320)'),
    ],
  }),
  cmd({
    name: 'inspect.waveform',
    module: 'inspect',
    writes: true,
    summary: 'Waveform PNG of the audio.',
    usage: 'studio inspect waveform <file>',
    example: 'studio inspect waveform assets/vo.wav',
    flags: [],
  }),
  cmd({
    name: 'inspect.loudness',
    module: 'inspect',
    writes: false,
    summary: 'Integrated LUFS, LRA, true peak, sample peak, noise floor, clipping.',
    usage: 'studio inspect loudness <file>',
    example: 'studio inspect loudness renders/demo-youtube-1080p-v1.mp4',
    flags: [],
  }),
  cmd({
    name: 'inspect.silence',
    module: 'inspect',
    writes: false,
    summary: 'Silent spans. Default threshold is the measured noise floor + 8 dB.',
    usage: 'studio inspect silence <file> [--noise-db N] [--min-s S]',
    example: 'studio inspect silence assets/talk.mp4 --min-s 0.4',
    flags: [
      n('noise-db', 'threshold in dB (default: noise floor + 8, between -50 and -20)'),
      n('min-s', 'minimum span in seconds (default 0.4)'),
    ],
  }),
  cmd({
    name: 'inspect.black',
    module: 'inspect',
    writes: false,
    summary: 'Black-frame spans (at least one frame) and frozen spans (at least 1 s).',
    usage: 'studio inspect black <file>',
    example: 'studio inspect black renders/demo-youtube-1080p-v1.mp4',
    flags: [],
  }),
  cmd({
    name: 'inspect.qc',
    module: 'inspect',
    writes: false,
    summary:
      'Technical QC with per-check pass/fail/warn/skipped and measured values. Exits 4 on any failure.',
    usage: 'studio inspect qc <file> [expectation flags]',
    example: 'studio inspect qc renders/demo-youtube-1080p-v1.mp4',
    flags: [
      n('width', 'expected width'),
      n('height', 'expected height'),
      n('fps', 'expected fps'),
      n('duration-ms', 'expected duration'),
      s('expect-audio', 'true|false'),
      n('target-lufs', 'loudness target'),
      n('true-peak-max', 'dBTP ceiling'),
      b('h264', 'check H.264 High/yuv420p/AAC-LC delivery'),
      s('joins', 'join times in ms, comma-separated'),
      s('planned-black', 'intended black/frozen ranges, A:B,A:B'),
      n('max-size-mb', 'file size budget'),
    ],
  }),
  cmd({
    name: 'project.show',
    module: 'project',
    writes: false,
    summary: 'Summarize the project (tracks, clips, assets, derived duration, undo depth).',
    usage: 'studio project show [--full]',
    example: 'studio project show',
    flags: [b('full', 'include the whole project file')],
  }),
  cmd({
    name: 'project.validate',
    module: 'project',
    writes: false,
    summary: 'Check schema and invariants; warns if the file was edited outside ops.',
    usage: 'studio project validate',
    example: 'studio project validate',
    flags: [],
  }),
  cmd({
    name: 'project.diff',
    module: 'project',
    writes: false,
    summary: 'Show the ops of one transaction (by txn or op id).',
    usage: 'studio project diff <txnId|opId>',
    example: 'studio project diff tx_ab12cd',
    flags: [],
  }),
  cmd({
    name: 'project.log',
    module: 'project',
    writes: false,
    summary: 'List recent log entries.',
    usage: 'studio project log [--limit N]',
    example: 'studio project log --limit 10',
    flags: [n('limit', 'entries to show (default 20)')],
  }),
  cmd({
    name: 'project.undo',
    module: 'project',
    writes: true,
    summary: 'Undo the last transaction(s) by applying inverse ops; logs the undo.',
    usage: 'studio project undo [--n N]',
    example: 'studio project undo --n 2',
    flags: [n('n', 'transactions to undo (default 1)')],
  }),
  cmd({
    name: 'project.redo',
    module: 'project',
    writes: true,
    summary: 'Redo undone transaction(s).',
    usage: 'studio project redo [--n N]',
    example: 'studio project redo',
    flags: [n('n', 'transactions to redo (default 1)')],
  }),
  cmd({
    name: 'ops.apply',
    module: 'ops',
    writes: true,
    summary: 'Apply a JSON batch of ops atomically (all or none). File path or - for stdin.',
    usage: 'studio ops apply <ops.json|->',
    example: 'studio ops apply ops.json --dry-run',
    flags: [s('label', 'log label')],
  }),
  cmd({
    name: 'tl.add-track',
    module: 'tl',
    writes: true,
    summary: 'Add a track.',
    usage: 'studio tl add-track --type video|audio|graphics|captions --name N',
    example: 'studio tl add-track --type video --name Screen',
    flags: [
      {
        name: 'type',
        type: 'string',
        desc: 'track type',
        required: true,
        values: ['video', 'audio', 'graphics', 'captions'],
      },
      s('name', 'track name', true),
      s('role', 'e.g. music'),
      s('id', 'explicit id'),
      n('index', 'position'),
    ],
  }),
  cmd({
    name: 'tl.add-clip',
    module: 'tl',
    writes: true,
    summary: 'Add a clip from an asset or a composition.',
    usage: 'studio tl add-clip --track t --asset a|--comp name --start MS --dur MS',
    example: 'studio tl add-clip --track t_v1 --asset a_k3f9 --start 0 --dur 8200 --src-in 12000',
    flags: [
      s('track', 'track id', true),
      s('asset', 'asset id'),
      s('comp', 'composition id'),
      n('start', 'timeline ms', true),
      n('dur', 'duration ms', true),
      n('src-in', 'source in-point ms'),
      s('props', 'JSON props for comp clips'),
      s('id', 'explicit id'),
    ],
  }),
  cmd({
    name: 'tl.move',
    module: 'tl',
    writes: true,
    summary: 'Move a clip to an absolute start (optionally another track).',
    usage: 'studio tl move --id c --start MS [--track t]',
    example: 'studio tl move --id c_01 --start 1500',
    flags: [s('id', 'clip id', true), n('start', 'timeline ms', true), s('track', 'target track')],
  }),
  cmd({
    name: 'tl.trim',
    module: 'tl',
    writes: true,
    summary: 'Set absolute start, duration, or source in-point.',
    usage: 'studio tl trim --id c [--start MS] [--dur MS] [--src-in MS]',
    example: 'studio tl trim --id c_01 --dur 4000',
    flags: [
      s('id', 'clip id', true),
      n('start', 'timeline ms'),
      n('dur', 'duration ms'),
      n('src-in', 'source in-point ms'),
    ],
  }),
  cmd({
    name: 'tl.split',
    module: 'tl',
    writes: true,
    summary: 'Split a clip at a timeline time.',
    usage: 'studio tl split --id c --at MS',
    example: 'studio tl split --id c_01 --at 3000',
    flags: [s('id', 'clip id', true), n('at', 'timeline ms', true)],
  }),
  cmd({
    name: 'tl.ripple-delete',
    module: 'tl',
    writes: true,
    summary: 'Delete a clip and close the gap.',
    usage: 'studio tl ripple-delete --id c [--scope track|all]',
    example: 'studio tl ripple-delete --id c_01 --scope all',
    flags: [
      s('id', 'clip id', true),
      { name: 'scope', type: 'string', desc: 'which tracks shift', values: ['track', 'all'] },
    ],
  }),
  cmd({
    name: 'tl.set',
    module: 'tl',
    writes: true,
    summary: 'Patch clip transform, fx, props, link, label (JSON; null removes a field).',
    usage: 'studio tl set --id c --patch JSON',
    example: `studio tl set --id c_01 --patch '{"transform":{"scale":1.2}}'`,
    flags: [s('id', 'clip id', true), s('patch', 'JSON patch', true)],
  }),
  cmd({
    name: 'tl.keyframe',
    module: 'tl',
    writes: true,
    summary: 'Set a keyframe (or delete one with --delete).',
    usage:
      'studio tl keyframe --clip c --prop scale --t MS --v N [--ease expo.inOut] | --clip c --delete k_id',
    example: 'studio tl keyframe --clip c_01 --prop scale --t 1000 --v 1.8 --ease expo.inOut',
    flags: [
      s('clip', 'clip id', true),
      s('prop', 'property name'),
      n('t', 'ms from clip start'),
      n('v', 'value'),
      s('ease', 'easing name'),
      s('delete', 'keyframe id to delete'),
    ],
  }),
  cmd({
    name: 'tl.marker',
    module: 'tl',
    writes: true,
    summary: 'Add a marker.',
    usage: 'studio tl marker --t MS --label TEXT',
    example: 'studio tl marker --t 5000 --label "Click: Save"',
    flags: [n('t', 'timeline ms', true), s('label', 'text', true)],
  }),
];
