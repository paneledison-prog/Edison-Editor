import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile } from './hash.js';
import { EngineError, run } from './run.js';

export interface ManifestEntry {
  kind: 'onnx' | 'binary-zip' | 'whisper-dir';
  task: string;
  file: string;
  url: string;
  sha256: string;
  bytes: number;
  license: string;
  licenseSource: string;
  notes: string;
  /** whisper-dir: every file of the model directory, each checked by size and sha256. */
  files?: { file: string; url: string; sha256: string; bytes: number }[];
}
export interface Manifest {
  schema: 1;
  models: Record<string, ManifestEntry>;
}

/** The Studio checkout or install: the closest ancestor of this file that holds models/manifest.json. */
export function studioRoot(): string {
  if (process.env['STUDIO_HOME']) return resolve(process.env['STUDIO_HOME']);
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, 'models', 'manifest.json'))) return d;
    d = dirname(d);
  }
  throw new EngineError(
    'ENGINE_MISSING',
    'cannot find models/manifest.json',
    'set STUDIO_HOME to the Studio checkout',
  );
}

export const modelsDir = () => process.env['STUDIO_MODELS_DIR'] ?? join(studioRoot(), 'models');

export function loadManifest(): Manifest {
  return JSON.parse(readFileSync(join(studioRoot(), 'models', 'manifest.json'), 'utf8'));
}

function entry(name: string): ManifestEntry {
  const e = loadManifest().models[name];
  if (!e)
    throw new EngineError(
      'INVALID_INPUT',
      `unknown model "${name}"; known: ${Object.keys(loadManifest().models).join(', ')}`,
    );
  return e;
}

/** Where a model or engine binary lives once fetched. */
export function modelFile(name: string): string {
  const e = entry(name);
  return e.kind === 'binary-zip'
    ? join(modelsDir(), 'engines', name, e.file)
    : join(modelsDir(), e.file);
}

export interface ModelStatus {
  name: string;
  kind: string;
  task: string;
  present: boolean;
  license: string;
  path: string;
  bytes?: number;
}

/** Presence is checked by size, which is quick; `fetchModel` verifies the sha256. */
export function modelStatus(): ModelStatus[] {
  return Object.entries(loadManifest().models).map(([name, e]) => {
    const path = modelFile(name);
    const present =
      e.kind === 'whisper-dir'
        ? (e.files ?? []).every((f) => {
            const fp = join(path, f.file);
            return existsSync(fp) && statSync(fp).size === f.bytes;
          })
        : existsSync(path) && (e.kind === 'binary-zip' || statSync(path).size === e.bytes);
    return {
      name,
      kind: e.kind,
      task: e.task,
      present,
      license: e.license,
      path,
      ...(present ? { bytes: e.bytes } : {}),
    };
  });
}

export function requireModel(name: string): string {
  const s = modelStatus().find((m) => m.name === name);
  if (!s?.present)
    throw new EngineError(
      'ENGINE_MISSING',
      `model ${name} is not installed`,
      `run \`studio models fetch ${name}\` (license: ${entry(name).license})`,
    );
  return s.path;
}

export interface FetchResult {
  name: string;
  path: string;
  bytes: number;
  sha256: string;
  downloaded: boolean;
  license: string;
}

/** Downloads with curl (it honors the proxy settings), checks size and sha256 against the manifest, then installs atomically. */
export async function fetchModel(
  name: string,
  o: { force?: boolean; log?: (m: string) => void } = {},
): Promise<FetchResult> {
  const e = entry(name);
  const log = o.log ?? (() => {});
  if (e.kind === 'whisper-dir') return fetchDir(name, e, o);
  const dest = e.kind === 'binary-zip' ? join(modelsDir(), `${name}.zip`) : modelFile(name);
  mkdirSync(dirname(dest), { recursive: true });
  const ok = e.kind === 'binary-zip' ? existsSync(modelFile(name)) : existsSync(dest);
  if (ok && !o.force) {
    if (e.kind === 'onnx') {
      const h = await hashFile(dest, Infinity);
      if (h.hex !== e.sha256)
        throw new EngineError(
          'ENGINE_FAILED',
          `${name}: installed file does not match the manifest sha256`,
          `run \`studio models fetch ${name} --force\``,
        );
    }
    return {
      name,
      path: modelFile(name),
      bytes: e.bytes,
      sha256: e.sha256,
      downloaded: false,
      license: e.license,
    };
  }
  log(
    `downloading ${name} (${(e.bytes / 1048576).toFixed(1)} MB, license ${e.license}) from ${e.url}`,
  );
  const tmp = dest + '.partial';
  rmSync(tmp, { force: true });
  const r = await run(
    'curl',
    ['-fsSL', '--retry', '3', '--connect-timeout', '20', '-o', tmp, e.url],
    { timeoutMs: 600_000 },
  ).catch((err) => {
    if ((err as { code?: string }).code === 'ENGINE_MISSING')
      throw new EngineError(
        'ENGINE_MISSING',
        'curl is needed to download models',
        'install curl, or place the file at ' + dest,
      );
    throw err;
  });
  if (r.code !== 0) {
    rmSync(tmp, { force: true });
    throw new EngineError(
      'ENGINE_FAILED',
      `download of ${name} failed: ${r.stderr.trim().split('\n').pop() || 'curl exit ' + r.code}`,
      'check network access to ' + new URL(e.url).host,
    );
  }
  const h = await hashFile(tmp, Infinity);
  if (h.size !== e.bytes || h.hex !== e.sha256) {
    rmSync(tmp, { force: true });
    throw new EngineError(
      'ENGINE_FAILED',
      `${name}: downloaded file does not match the manifest (size ${h.size} vs ${e.bytes}, sha256 ${h.hex.slice(0, 12)}…)`,
      'the upstream file changed or the download was altered; nothing was installed',
    );
  }
  renameSync(tmp, dest);
  if (e.kind === 'binary-zip') {
    const dir = join(modelsDir(), 'engines', name);
    mkdirSync(dir, { recursive: true });
    const u = await run('unzip', ['-o', '-q', dest, '-d', dir], { timeoutMs: 120_000 }).catch(
      () => null,
    );
    if (!u || u.code !== 0)
      throw new EngineError('ENGINE_MISSING', `could not unzip ${name}`, 'install unzip');
    rmSync(dest, { force: true });
    chmodSync(modelFile(name), 0o755);
    if (!existsSync(modelFile(name)))
      throw new EngineError('ENGINE_FAILED', `${name}: ${e.file} is not in the archive`);
  }
  return {
    name,
    path: modelFile(name),
    bytes: e.bytes,
    sha256: h.hex,
    downloaded: true,
    license: e.license,
  };
}

/** Multi-file models: each file is downloaded, size- and sha256-checked, and installed atomically. */
async function fetchDir(
  name: string,
  e: ManifestEntry,
  o: { force?: boolean; log?: (m: string) => void },
): Promise<FetchResult> {
  const log = o.log ?? (() => {});
  const dir = modelFile(name);
  mkdirSync(dir, { recursive: true });
  let downloaded = false;
  for (const f of e.files ?? []) {
    const dest = join(dir, f.file);
    if (existsSync(dest) && !o.force) {
      const h = await hashFile(dest, Infinity);
      if (h.hex === f.sha256 && h.size === f.bytes) continue;
      log(`${name}/${f.file} does not match the manifest; downloading again`);
    }
    log(
      `downloading ${name}/${f.file} (${(f.bytes / 1048576).toFixed(1)} MB, license ${e.license})`,
    );
    const tmp = dest + '.partial';
    rmSync(tmp, { force: true });
    const r = await run(
      'curl',
      ['-fsSL', '--retry', '3', '--connect-timeout', '20', '-o', tmp, f.url],
      { timeoutMs: 1_800_000 },
    ).catch(() => null);
    if (!r || r.code !== 0) {
      rmSync(tmp, { force: true });
      throw new EngineError(
        'ENGINE_FAILED',
        `download of ${name}/${f.file} failed`,
        'check network access to ' + new URL(f.url).host,
      );
    }
    const h = await hashFile(tmp, Infinity);
    if (h.size !== f.bytes || h.hex !== f.sha256) {
      rmSync(tmp, { force: true });
      throw new EngineError(
        'ENGINE_FAILED',
        `${name}/${f.file}: downloaded file does not match the manifest (size ${h.size} vs ${f.bytes}); nothing was installed`,
      );
    }
    renameSync(tmp, dest);
    downloaded = true;
  }
  return { name, path: dir, bytes: e.bytes, sha256: '', downloaded, license: e.license };
}
