import { CliError } from '../args.js';
import type { Handler } from '../main.js';

export const list: Handler = async () => {
  const E = await import('@studio/engines');
  const m = E.loadManifest().models;
  const rows = E.modelStatus().map((s) => ({
    ...s,
    source: m[s.name]!.url,
    licenseSource: m[s.name]!.licenseSource,
    notes: m[s.name]!.notes,
  }));
  return {
    data: { models: rows, directory: E.modelsDir() },
    warnings: rows
      .filter((r) => !r.present)
      .map((r) => `${r.name} is not installed: studio models fetch ${r.name}`),
  };
};

export const fetch: Handler = async (inv) => {
  const E = await import('@studio/engines');
  const names = inv.flags['all'] ? Object.keys(E.loadManifest().models) : inv.positionals;
  if (!names.length)
    throw new CliError(
      'INVALID_ARGS',
      'name a model, or pass --all',
      2,
      'studio models list shows the names',
    );
  if (inv.dryRun) return { data: { wouldFetch: names } };
  const out = [];
  for (const n of names) out.push(await E.fetchModel(n, { force: inv.force, log: inv.log }));
  return {
    data: { fetched: out },
    warnings: out
      .filter((o) => o.downloaded)
      .map(
        (o) => `${o.name}: downloaded, sha256 verified against the manifest, license ${o.license}`,
      ),
  };
};
