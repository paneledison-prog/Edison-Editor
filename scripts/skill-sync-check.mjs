// Fails if helper/skill and .claude/skills/studio-media differ.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function walk(dir, out = []) {
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}
const a = 'helper/skill';
const b = '.claude/skills/studio-media';
const fa = walk(a).map((p) => relative(a, p));
const fb = walk(b).map((p) => relative(b, p));
const problems = [];
for (const f of new Set([...fa, ...fb])) {
  if (!fa.includes(f)) problems.push(`only in ${b}: ${f}`);
  else if (!fb.includes(f)) problems.push(`only in ${a}: ${f}`);
  else if (!readFileSync(join(a, f)).equals(readFileSync(join(b, f))))
    problems.push(`differs: ${f}`);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`skill copies identical (${fa.length} files)`);
