import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FIX = join(import.meta.dirname, '.fixtures');
export const fx = (name: string) => join(FIX, name);

function ff(args: string[]) {
  execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], {
    stdio: 'pipe',
  });
}
const once = (name: string, make: (out: string) => void) => {
  const out = fx(name);
  if (!existsSync(out)) make(out);
};

const SRC = (d: number, r = 30) => ['-f', 'lavfi', '-i', `testsrc2=s=640x360:r=${r}:d=${d}`];
const SINE = (d: number, sr: number, hz = 440) => [
  '-f',
  'lavfi',
  '-i',
  `sine=f=${hz}:r=${sr}:d=${d}`,
];
const H264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '30'];

/** Deterministic fixtures made by ffmpeg. No binaries are committed (rules: tests/). */
export function ensureFixtures(): void {
  mkdirSync(FIX, { recursive: true });
  once('clean.mp4', (o) =>
    ff([...SRC(6), ...SINE(6, 48000), ...H264, '-c:a', 'aac', '-shortest', o]),
  );
  once('noaudio.mp4', (o) => ff([...SRC(4), ...H264, '-an', o]));
  // Irregular timestamps: drop frames by a fixed pattern and keep the original pts.
  once('vfr.mp4', (o) =>
    ff([
      ...SRC(8, 30),
      ...SINE(8, 48000),
      '-vf',
      "select='not(mod(n\\,5))+not(mod(n\\,3))+not(mod(n\\,7))'",
      '-fps_mode',
      'vfr',
      ...H264,
      '-c:a',
      'aac',
      '-shortest',
      o,
    ]),
  );
  once('rotated.mp4', (o) => {
    const tmp = fx('_portrait_src.mp4');
    ff([...SRC(4), ...SINE(4, 48000), ...H264, '-c:a', 'aac', '-shortest', tmp]);
    // Display matrix only: the coded frame stays 640x360, players show it rotated.
    ff(['-display_rotation', '90', '-i', tmp, '-c', 'copy', o]);
  });
  once('audio44.wav', (o) => ff([...SINE(5, 44100, 330), '-ac', '1', o]));
  once('audio48.wav', (o) => ff([...SINE(5, 48000, 550), '-ac', '2', o]));
  // P1 fixtures. blackmid: a 0.5 s black section planted at 2.0 s (15 frames at 30 fps).
  once('blackmid.mp4', (o) =>
    ff([
      ...SRC(6),
      ...SINE(6, 48000, 440),
      '-vf',
      "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='gte(t,2)*lt(t,2.5)'",
      ...H264,
      '-c:a',
      'aac',
      '-shortest',
      o,
    ]),
  );
  // Level fixtures: tone at very different levels, for planted loudness errors.
  once('quiet.mp4', (o) =>
    ff([
      ...SRC(5),
      ...SINE(5, 48000, 440),
      '-af',
      'volume=0.03',
      ...H264,
      '-c:a',
      'aac',
      '-shortest',
      o,
    ]),
  );
  // Loud (0.75 FS) tone with video, for join tests where a cut without fades would step by up to 0.75.
  once('tone.mp4', (o) =>
    ff([
      ...SRC(6),
      ...SINE(6, 48000, 440),
      '-af',
      'volume=6',
      ...H264,
      '-c:a',
      'aac',
      '-shortest',
      o,
    ]),
  );
  once('hot.wav', (o) => ff([...SINE(5, 48000, 440), '-af', 'volume=12', '-c:a', 'pcm_s16le', o]));
  // Hard splice with no fade: two tones at different phase/frequency, joined at exactly 2.0 s.
  once('splice.wav', (o) => {
    const a = fx('_sp_a.wav'),
      b = fx('_sp_b.wav');
    ff([
      '-f',
      'lavfi',
      '-i',
      'sine=f=300:r=48000:d=2.0013',
      '-af',
      'volume=6',
      '-c:a',
      'pcm_s16le',
      a,
    ]);
    ff([...SINE(2, 48000, 777), '-af', 'volume=6', '-c:a', 'pcm_s16le', b]);
    ff(['-i', a, '-i', b, '-filter_complex', '[0][1]concat=n=2:v=0:a=1', '-c:a', 'pcm_s16le', o]);
  });
  // Tone plus steady noise: noise floor is measurable.
  once('noisy.wav', (o) =>
    ff([
      ...SINE(6, 48000, 440),
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=d=6:c=white:a=0.01:r=48000:seed=7',
      '-filter_complex',
      "[0]volume=0.2,volume='if(between(t,1,3)+between(t,4,6),1,0)':eval=frame[t];[t][1]amix=inputs=2:normalize=0",
      '-c:a',
      'pcm_s16le',
      o,
    ]),
  );
  once('still.png', (o) => ff([...SRC(1, 1), '-frames:v', '1', o]));
  once('corrupt.mp4', (o) => writeFileSync(o, 'this is not a media file\n'));
  once('empty.mp4', (o) => writeFileSync(o, ''));
}
