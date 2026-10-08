/**
 * `studio ws ...` opens, lists and closes workspaces (up to five per editor); `studio work ...` is the agent's lease on
 * the workspace it is in. Both are plain files under the root folder: see packages/workspace.
 */
import { rmSync } from 'node:fs';
import {
  acquireLease, claimSlots, closeSlot, endLease, hasProject, listInfo, readLease, rootFrom, slotDir, writeMeta,
  SLOT_LIMIT, type Kind,
} from '@studio/workspace';
import { CliError } from '../args.js';
import type { Handler, Invocation } from '../main.js';
import { must, num, str } from './shared.js';

/** `--root`, else $STUDIO_ROOT, else the project folder (or the folder a workspace sits in when run inside one). */
export const rootOf = (inv: Invocation): string => rootFrom(str(inv, 'root') ?? process.env['STUDIO_ROOT'] ?? inv.dir);

const uiHint = (kind: Kind, root: string) =>
  kind === 'media' ? `studio ui --hub --root ${root}` : `studio design ui --hub --root ${root}`;

export const open: Handler = async (inv) => {
  const root = rootOf(inv);
  const kind = (str(inv, 'kind') ?? 'media') as Kind;
  const count = num(inv, 'count') ?? 1;
  const base = str(inv, 'name');
  const slots = claimSlots(root, kind, count, str(inv, 'slot'));
  const made: { slot: string; name: string; dir: string }[] = [];
  try {
    for (const [i, slot] of slots.entries()) {
      const dir = slotDir(root, slot);
      const name = base ? (count > 1 ? `${base} ${i + 1}` : base) : `${kind === 'media' ? 'Edit' : 'Design'} ${slot}`;
      const give = (k: string, v: number | string | undefined) => (v === undefined ? [] : [`--${k}`, String(v)]);
      if (kind === 'media')
        await must(dir, ['init', name, ...give('width', num(inv, 'width')), ...give('height', num(inv, 'height')), ...give('fps', num(inv, 'fps')), ...give('background', str(inv, 'background'))], inv.log);
      else
        await must(dir, ['design', 'new', name, ...give('width', num(inv, 'width')), ...give('height', num(inv, 'height')), ...give('fps', num(inv, 'fps')), ...give('duration', num(inv, 'duration')), ...give('background', str(inv, 'background'))], inv.log);
      writeMeta(dir, { slot, kind, name, createdAt: new Date().toISOString() });
      made.push({ slot, name, dir });
    }
  } catch (e) {
    // all or nothing: give back the slots this call took, with whatever was made in them (nothing of the user's is there yet)
    for (const s of slots) rmSync(slotDir(root, s), { recursive: true, force: true });
    throw e;
  }
  const used = listInfo(root, kind).length;
  return {
    data: {
      kind,
      root,
      workspaces: made.map((m) => ({
        ...m,
        /** every command for this workspace carries these two flags, so parallel agents never touch each other's files */
        flags: `--project ${m.dir} --agent ${m.slot}`,
      })),
      inUse: used,
      free: SLOT_LIMIT - used,
      limit: SLOT_LIMIT,
      ui: uiHint(kind, root),
    },
    artifacts: made.map((m) => ({ kind: 'workspace', path: m.dir })),
  };
};

export const list: Handler = async (inv) => {
  const root = rootOf(inv);
  const kind = str(inv, 'kind') as Kind | undefined;
  const all = listInfo(root, kind);
  const per = (k: Kind) => ({ used: all.filter((w) => w.kind === k).length, free: SLOT_LIMIT - listInfo(root, k).length });
  return {
    data: {
      root,
      limit: SLOT_LIMIT,
      ...(kind ? { [kind]: per(kind) } : { media: per('media'), design: per('design') }),
      workspaces: all.map((w) => ({
        slot: w.slot, kind: w.kind, name: w.name, dir: w.dir, state: w.state,
        ...(w.agent ? { agent: w.agent, ...(w.note ? { note: w.note } : {}), expiresInS: Math.max(0, Math.round((w.expires! - Date.now()) / 1000)) } : {}),
        items: w.items, assets: w.assets,
      })),
    },
  };
};

export const close: Handler = async (inv) => {
  const slot = inv.positionals[0];
  if (!slot) throw new CliError('INVALID_ARGS', 'missing the slot to close', 2, 'studio ws close m1');
  const archived = closeSlot(rootOf(inv), slot, inv.force);
  return { data: { slot, archivedTo: archived, note: 'the folder was moved, not deleted: the project, assets and renders are all in it' } };
};

// ----- the agent's lease ------------------------------------------------------------------------------------------

const need = (inv: Invocation): string => {
  if (!hasProject(inv.dir)) throw new CliError('NOT_FOUND', `no Studio project or design in ${inv.dir}`, 2, 'pass --project <workspace folder>');
  return inv.dir;
};
const view = (inv: Invocation) => {
  const l = readLease(inv.dir);
  return l ? { ...l, expiresInS: Math.max(0, Math.round((l.expires - Date.now()) / 1000)) } : null;
};

export const begin: Handler = async (inv) => {
  const agent = str(inv, 'agent');
  if (!agent) throw new CliError('INVALID_ARGS', 'missing --agent', 2, 'name yourself, e.g. --agent m1-agent');
  const dir = need(inv);
  acquireLease(dir, agent, { ttlS: num(inv, 'ttl'), note: str(inv, 'note') });
  return { data: { lease: view(inv), editorLocked: true, note: 'every write you make with --agent keeps this alive; `studio work end` frees the editor at once' } };
};

export const end: Handler = async (inv) => {
  const released = endLease(need(inv), str(inv, 'agent'), inv.force);
  return { data: { released, editorLocked: false } };
};

export const status: Handler = async (inv) => {
  const dir = need(inv);
  void dir;
  const lease = view(inv);
  return { data: { lease, editorLocked: !!lease } };
};
