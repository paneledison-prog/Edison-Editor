import { statfsSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { run } from './run.js';

export interface EncoderCheck {
  name: string;
  kind: 'software' | 'hardware';
  usable: boolean;
  error?: string;
}
export interface DoctorReport {
  node: { version: string; ok: boolean };
  ffmpeg: null | {
    version: string;
    license: string;
    libass: boolean;
    ffprobe: boolean;
    encoders: EncoderCheck[];
  };
  machine: { cpus: number; ramGb: number; platform: string; arch: string };
  disk: { path: string; freeGb: number };
  models: { manifest: boolean; files: number };
  problems: { code: string; message: string; fix: string }[];
}

const SOFTWARE = ['libx264', 'libx265', 'libvpx-vp9', 'aac', 'libopus'];
const HARDWARE = ['h264_nvenc', 'h264_vaapi', 'h264_qsv', 'h264_videotoolbox', 'hevc_nvenc'];

/** Encoders are tested by encoding 5 real frames. A name in `ffmpeg -encoders` only means it was compiled in. */
async function tryEncoder(name: string): Promise<EncoderCheck> {
  const kind = HARDWARE.includes(name) ? 'hardware' : 'software';
  const audio = name === 'aac' || name === 'libopus';
  const vaapi = name.endsWith('_vaapi');
  const args = [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    ...(vaapi ? ['-vaapi_device', '/dev/dri/renderD128'] : []),
    ...(audio
      ? ['-f', 'lavfi', '-i', 'sine=d=0.5']
      : ['-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=1']),
    ...(vaapi ? ['-vf', 'format=nv12,hwupload'] : []),
    ...(audio ? ['-c:a', name] : ['-frames:v', '5', '-c:v', name]),
    '-f',
    'null',
    '-',
  ];
  try {
    const r = await run('ffmpeg', args, { timeoutMs: 20_000 });
    if (r.code === 0) return { name, kind, usable: true };
    return {
      name,
      kind,
      usable: false,
      error: r.stderr.trim().split('\n').filter(Boolean).slice(-1)[0] ?? 'failed',
    };
  } catch (e) {
    return { name, kind, usable: false, error: (e as Error).message };
  }
}

export async function doctor(projectDir: string): Promise<DoctorReport> {
  const problems: DoctorReport['problems'] = [];
  const major = Number(process.versions.node.split('.')[0]);
  const node = { version: process.versions.node, ok: major >= 20 };
  if (!node.ok)
    problems.push({
      code: 'NODE_OLD',
      message: `node ${node.version} is older than 20`,
      fix: 'install Node 20 or newer',
    });

  let ff: DoctorReport['ffmpeg'] = null;
  const v = await run('ffmpeg', ['-version'], { timeoutMs: 10_000 }).catch(() => null);
  if (!v || v.code !== 0) {
    problems.push({
      code: 'ENGINE_MISSING',
      message: 'ffmpeg not found on PATH',
      fix: 'install ffmpeg (apt install ffmpeg / brew install ffmpeg)',
    });
  } else {
    const version = /ffmpeg version (\S+)/.exec(v.stdout)?.[1] ?? 'unknown';
    const probe = await run('ffprobe', ['-version'], { timeoutMs: 10_000 }).catch(() => null);
    if (!probe || probe.code !== 0)
      problems.push({
        code: 'ENGINE_MISSING',
        message: 'ffprobe not found on PATH',
        fix: 'install ffmpeg (ffprobe ships with it)',
      });
    const lic = await run('ffmpeg', ['-L'], { timeoutMs: 10_000 }).catch(() => null);
    const license = /--enable-nonfree/.test(v.stdout)
      ? 'nonfree'
      : /--enable-gpl/.test(v.stdout)
        ? /--enable-version3/.test(v.stdout)
          ? 'GPLv3'
          : 'GPL'
        : (lic?.stdout
            .split('\n')
            .find((l) => /license/i.test(l))
            ?.trim() ?? 'LGPL');
    const encoders = await Promise.all([...SOFTWARE, ...HARDWARE].map(tryEncoder));
    ff = {
      version,
      license,
      libass: /--enable-libass/.test(v.stdout),
      ffprobe: !!probe && probe.code === 0,
      encoders,
    };
    if (!encoders.find((e) => e.name === 'libx264')?.usable) {
      problems.push({
        code: 'ENCODER_MISSING',
        message: 'libx264 cannot encode',
        fix: 'install an ffmpeg build with libx264',
      });
    }
    if (!ff.libass)
      problems.push({
        code: 'LIBASS_MISSING',
        message: 'ffmpeg has no libass; burned-in subtitles unavailable',
        fix: 'install an ffmpeg build with --enable-libass',
      });
  }

  let freeGb = NaN;
  try {
    const s = statfsSync(projectDir);
    freeGb = Math.round(((s.bavail * s.bsize) / 1024 ** 3) * 10) / 10;
  } catch {
    /* directory may not exist yet */
  }
  if (Number.isFinite(freeGb) && freeGb < 2)
    problems.push({
      code: 'DISK_LOW',
      message: `${freeGb} GB free`,
      fix: 'free disk space or clear .studio/cache',
    });

  const man = join(projectDir, 'models', 'manifest.json');
  let files = 0;
  if (existsSync(man)) {
    try {
      files = Object.keys(JSON.parse(readFileSync(man, 'utf8')).models ?? {}).length;
    } catch {
      /* ignore */
    }
  }

  return {
    node,
    ffmpeg: ff,
    machine: {
      cpus: os.cpus().length,
      ramGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
      platform: os.platform(),
      arch: os.arch(),
    },
    disk: { path: projectDir, freeGb },
    models: { manifest: existsSync(man), files },
    problems,
  };
}
