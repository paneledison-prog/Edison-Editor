import { ProjectStore, timelineDuration, type OpSpec, type Step } from '@studio/core';
import type { Invocation } from '../main.js';
import type { Success } from '../output.js';

export const store = (inv: Invocation) => new ProjectStore(inv.dir);

export const str = (inv: Invocation, k: string): string | undefined => {
  const v = inv.flags[k];
  return typeof v === 'string' ? v : undefined;
};
export const num = (inv: Invocation, k: string): number | undefined => {
  const v = inv.flags[k];
  return typeof v === 'number' ? v : undefined;
};

export function parseJson(label: string, text: string): any {
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error(`${label} is not valid JSON: ${(e as Error).message}`);
    (err as any).code = 'INVALID_ARGS';
    throw err;
  }
}

export function stepResult(step: Step, inv: Invocation): Success {
  const e = step.entry;
  return {
    data: {
      txn: e.id,
      kind: e.kind,
      dryRun: inv.dryRun || undefined,
      ops: e.ops.map((o: any) => ({
        id: o.id,
        type: o.type,
        ...(o.args?.id ? { target: o.args.id } : {}),
      })),
      timelineMs: timelineDuration(step.project),
      before: e.before,
      after: e.after,
    },
    artifacts: inv.dryRun ? [] : [{ kind: 'project', path: 'project.studio.json' }],
    opId: e.kind === 'apply' ? (e.ops[0] as any)?.id : undefined,
  };
}

export function runSpecs(inv: Invocation, specs: OpSpec[], label?: string): Success {
  const step = store(inv).apply(specs, { actor: inv.actor, label, dryRun: inv.dryRun });
  return stepResult(step, inv);
}
