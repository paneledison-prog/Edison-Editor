/**
 * Workspaces: up to five per editor (media m1..m5, design d1..d5), each an ordinary Studio project folder under
 * `<root>/workspaces/<slot>/` with its own file, ops log, cache and renders. Nothing here knows the project formats; it
 * only manages slots and the lease that says "an agent is working here".
 *
 * Slots are fixed names created with an atomic `mkdir`, so the limit of five cannot be raced past: of any number of
 * processes asking at once, exactly the free slots are granted.
 *
 * A lease is a small file (`.studio/agent.json`) with an expiry. While it is live the editors are view-only. It is
 * extended by every write the agent makes and expires by itself, so a crashed agent never locks a person out for long.
 */
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const SLOT_LIMIT = 5;
export type Kind = 'media' | 'design';
export const KINDS: Kind[] = ['media', 'design'];
const PREFIX: Record<Kind, string> = { media: 'm', design: 'd' };
export const WS_DIR = 'workspaces';
export const MEDIA_FILE = 'project.studio.json';
export const DESIGN_FILE = 'design.studio.json';
export const DEFAULT_TTL_S = 120;
export const MAX_TTL_S = 3600;

export type WorkspaceCode = 'WORKSPACE_LIMIT' | 'WORKSPACE_BUSY' | 'AGENT_WORKING' | 'NOT_FOUND' | 'INVALID_ARGS';
export class WorkspaceError extends Error {
  constructor(
    public code: WorkspaceCode,
    message: string,
    public fix?: string,
  ) {
    super(message);
  }
}

// ----- slots ------------------------------------------------------------------------------------------------------

export const slotNames = (kind: Kind): string[] => Array.from({ length: SLOT_LIMIT }, (_, i) => `${PREFIX[kind]}${i + 1}`);
export const kindOfSlot = (slot: string): Kind | undefined =>
  /^m[1-5]$/.test(slot) ? 'media' : /^d[1-5]$/.test(slot) ? 'design' : undefined;
export const workspacesDir = (root: string) => join(resolve(root), WS_DIR);
export function slotDir(root: string, slot: string): string {
  if (!kindOfSlot(slot)) throw new WorkspaceError('INVALID_ARGS', `"${slot}" is not a workspace slot`, 'slots are m1..m5 (media) and d1..d5 (design)');
  return join(workspacesDir(root), slot);
}
/** If `dir` is itself a workspace, the root it belongs to; otherwise `dir`. Lets an agent working inside a slot run `ws list`. */
export function rootFrom(dir: string): string {
  const d = resolve(dir);
  return kindOfSlot(basename(d)) && basename(dirname(d)) === WS_DIR ? dirname(dirname(d)) : d;
}

function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.partial`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** A directory used as a mutex (the same scheme the project stores use): atomic to create, taken over when stale. */
function withLock<T>(lock: string, what: string, fn: () => T): T {
  mkdirSync(dirname(lock), { recursive: true });
  const until = Date.now() + 3000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { recursive: true, force: true });
      } catch {
        /* released between the two calls */
      }
      if (Date.now() > until) throw new WorkspaceError('WORKSPACE_BUSY', `${what} is being changed by another process; try again`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export interface Meta {
  slot: string;
  kind: Kind;
  name: string;
  createdAt: string;
}
const metaPath = (dir: string) => join(dir, '.studio', 'workspace.json');
export const writeMeta = (dir: string, m: Meta) => atomicWrite(metaPath(dir), JSON.stringify(m, null, 1) + '\n');
export function readMeta(dir: string): Meta | null {
  try {
    const m = JSON.parse(readFileSync(metaPath(dir), 'utf8'));
    return typeof m?.slot === 'string' && typeof m?.name === 'string' ? (m as Meta) : null;
  } catch {
    return null;
  }
}

/** A slot someone claimed and never finished (no metadata, empty, older than two minutes) is released for reuse. */
function reclaimAbandoned(dir: string): boolean {
  try {
    if (readMeta(dir) || Date.now() - statSync(dir).mtimeMs < 120_000 || readdirSync(dir).length) return false;
    rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Takes `count` free slots of `kind` (or exactly `want`), all or nothing. The returned folders exist and are empty: the
 * caller creates the project in them and then calls `writeMeta`.
 */
export function claimSlots(root: string, kind: Kind, count = 1, want?: string): string[] {
  if (!Number.isInteger(count) || count < 1 || count > SLOT_LIMIT)
    throw new WorkspaceError('INVALID_ARGS', `count must be 1 to ${SLOT_LIMIT}`);
  if (want !== undefined && (kindOfSlot(want) !== kind || count !== 1))
    throw new WorkspaceError('INVALID_ARGS', `--slot ${want} is not a ${kind} slot, or --count was not 1`, `${kind} slots: ${slotNames(kind).join(', ')}`);
  mkdirSync(workspacesDir(root), { recursive: true });
  const got: string[] = [];
  for (const slot of want ? [want] : slotNames(kind)) {
    if (got.length === count) break;
    const dir = slotDir(root, slot);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        mkdirSync(dir);
        got.push(slot);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        if (!reclaimAbandoned(dir)) break;
      }
    }
  }
  if (got.length < count) {
    for (const s of got) rmdirSync(slotDir(root, s)); // empty folders this call just made
    const used = listInfo(root, kind);
    const names = used.map((u) => `${u.slot} "${u.name}"${u.state === 'agent-working' ? ` (${u.agent} working)` : ''}`).join(', ');
    throw new WorkspaceError(
      'WORKSPACE_LIMIT',
      want
        ? `${want} is already in use`
        : `${used.length} of ${SLOT_LIMIT} ${kind} workspaces are in use, so ${count} more do not fit (in use: ${names || 'none readable'})`,
      `close finished ones with \`studio ws close <slot>\` (the folder is archived under workspaces/.closed, not deleted)`,
    );
  }
  return got;
}

/** Frees a slot by moving its folder to `workspaces/.closed/`. Nothing is deleted. */
export function closeSlot(root: string, slot: string, force = false): string {
  const dir = slotDir(root, slot);
  if (!existsSync(dir)) throw new WorkspaceError('NOT_FOUND', `workspace ${slot} does not exist`, 'studio ws list shows the open ones');
  const lease = readLease(dir);
  if (lease && !force)
    throw new WorkspaceError('WORKSPACE_BUSY', `${lease.agent} is still working in ${slot}`, `wait for it to finish (\`studio work end\`), or pass --force`);
  const closed = join(workspacesDir(root), '.closed');
  mkdirSync(closed, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  let to = join(closed, `${slot}-${stamp}`);
  for (let i = 2; existsSync(to); i++) to = join(closed, `${slot}-${stamp}-${i}`);
  renameSync(dir, to);
  return to;
}

export interface Info {
  slot: string;
  kind: Kind;
  dir: string;
  name: string;
  state: 'idle' | 'agent-working' | 'incomplete';
  agent?: string;
  note?: string;
  since?: number;
  expires?: number;
  /** media: clips; design: layers */
  items: number;
  /** media: ingested assets; design: image and audio layers */
  assets: number;
  createdAt?: string;
}

export function describeSlot(root: string, slot: string): Info | null {
  const dir = slotDir(root, slot);
  if (!existsSync(dir)) return null;
  const kind = kindOfSlot(slot)!;
  const meta = readMeta(dir);
  const file = join(dir, kind === 'media' ? MEDIA_FILE : DESIGN_FILE);
  if (!meta || !existsSync(file)) return { slot, kind, dir, name: meta?.name ?? slot, state: 'incomplete', items: 0, assets: 0 };
  let doc: any = {};
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    /* mid-write or damaged: report the slot with what the metadata knows */
  }
  const lease = readLease(dir);
  const layers: any[] = Array.isArray(doc.layers) ? doc.layers : [];
  return {
    slot, kind, dir,
    name: String(doc.meta?.name ?? meta.name),
    state: lease ? 'agent-working' : 'idle',
    ...(lease ? { agent: lease.agent, ...(lease.note ? { note: lease.note } : {}), since: lease.since, expires: lease.expires } : {}),
    items: kind === 'media' ? (Array.isArray(doc.clips) ? doc.clips.length : 0) : layers.length,
    assets: kind === 'media' ? Object.keys(doc.assets ?? {}).length : layers.filter((l) => l?.type === 'image' || l?.type === 'audio').length,
    createdAt: meta.createdAt,
  };
}
export function listInfo(root: string, kind?: Kind): Info[] {
  const out: Info[] = [];
  for (const k of kind ? [kind] : KINDS)
    for (const s of slotNames(k)) {
      const i = describeSlot(root, s);
      if (i) out.push(i);
    }
  return out;
}

// ----- leases -----------------------------------------------------------------------------------------------------

export interface Lease {
  agent: string;
  note?: string;
  /** ms since epoch */
  since: number;
  expires: number;
  ttlS: number;
}
const leasePath = (dir: string) => join(dir, '.studio', 'agent.json');
const leaseLock = (dir: string) => join(dir, '.studio', 'lease.lock');

/** The live lease, or null when there is none, it expired, or the file is unreadable. */
export function readLease(dir: string, now = Date.now()): Lease | null {
  try {
    const l = JSON.parse(readFileSync(leasePath(dir), 'utf8'));
    if (typeof l?.agent !== 'string' || typeof l.expires !== 'number' || l.expires <= now) return null;
    return { agent: l.agent, ...(typeof l.note === 'string' ? { note: l.note } : {}), since: Number(l.since) || now, expires: l.expires, ttlS: Number(l.ttlS) || DEFAULT_TTL_S };
  } catch {
    return null;
  }
}

const AGENT_NAME = /^[\w.@:-]{1,40}$/;
export function checkAgentName(agent: string): string {
  if (!AGENT_NAME.test(agent))
    throw new WorkspaceError('INVALID_ARGS', `agent name "${agent}" must be 1 to 40 letters, digits or . _ @ : -`);
  return agent;
}

/**
 * Takes the workspace for `agent`, or renews its own lease. Another live holder refuses. Returns the lease.
 * `ttlS` and `note` replace the old values only when given.
 */
export function acquireLease(dir: string, agent: string, o: { ttlS?: number; note?: string } = {}): Lease {
  checkAgentName(agent);
  if (o.ttlS !== undefined && (!Number.isFinite(o.ttlS) || o.ttlS < 1 || o.ttlS > MAX_TTL_S))
    throw new WorkspaceError('INVALID_ARGS', `ttl must be 1 to ${MAX_TTL_S} seconds`);
  if (o.note !== undefined && o.note.length > 200) throw new WorkspaceError('INVALID_ARGS', 'note is at most 200 characters');
  return withLock(leaseLock(dir), 'the workspace lease', () => {
    const now = Date.now();
    const cur = readLease(dir, now);
    if (cur && cur.agent !== agent)
      throw new WorkspaceError(
        'WORKSPACE_BUSY',
        `${cur.agent} holds this workspace (until it finishes or ${Math.ceil((cur.expires - now) / 1000)} s pass without activity)`,
        'give each agent its own workspace (`studio ws open`); only use another agent’s workspace after it ends its work',
      );
    const ttlS = o.ttlS ?? cur?.ttlS ?? DEFAULT_TTL_S;
    const note = o.note ?? cur?.note;
    const lease: Lease = { agent, ...(note ? { note } : {}), since: cur?.since ?? now, expires: now + ttlS * 1000, ttlS };
    atomicWrite(leasePath(dir), JSON.stringify(lease) + '\n');
    return lease;
  });
}

/** Extends a live lease by its own length. `agent` given and different: leaves it alone. Cheap when there is none. */
export function touchLease(dir: string, agent?: string): void {
  const cur = readLease(dir);
  if (!cur || (agent && cur.agent !== agent)) return;
  withLock(leaseLock(dir), 'the workspace lease', () => {
    const c = readLease(dir);
    if (!c || (agent && c.agent !== agent)) return;
    atomicWrite(leasePath(dir), JSON.stringify({ ...c, expires: Date.now() + c.ttlS * 1000 }) + '\n');
  });
}

/** Releases the lease. Returns whether a live one existed. Releasing another agent's live lease needs `force`. */
export function endLease(dir: string, agent?: string, force = false): boolean {
  return withLock(leaseLock(dir), 'the workspace lease', () => {
    const cur = readLease(dir);
    if (cur && agent && cur.agent !== agent && !force)
      throw new WorkspaceError('WORKSPACE_BUSY', `${cur.agent} holds this workspace, not ${agent}`, 'pass --force to release it anyway');
    if (existsSync(leasePath(dir))) unlinkSync(leasePath(dir));
    return !!cur;
  });
}

/** For the editors: refuses a person's edit while an agent holds the workspace. */
export function assertAgentIdle(dir: string): void {
  const l = readLease(dir);
  if (l)
    throw new WorkspaceError(
      'AGENT_WORKING',
      `${l.agent} is working here${l.note ? ` (${l.note})` : ''}; editing opens again when it finishes`,
      'wait: the editor unlocks by itself',
    );
}

/** For the CLI: an agent that names itself may not write into a workspace another live agent holds. */
export function guardAgent(dir: string, agent?: string): void {
  const l = readLease(dir);
  if (l && agent && l.agent !== agent)
    throw new WorkspaceError('WORKSPACE_BUSY', `${l.agent} holds this workspace, so ${agent} may not write to it`, 'use your own workspace: `studio ws open`');
}

export const hasProject = (dir: string) => existsSync(join(dir, MEDIA_FILE)) || existsSync(join(dir, DESIGN_FILE));
