/** The project file shown in the skill's Context.md is a real, valid project: the documentation cannot drift from the schema. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectSchema } from '../packages/core/src/index.js';

describe('Context.md', () => {
  it('its project file example parses as a project', () => {
    const md = readFileSync(join(import.meta.dirname, '..', '.claude', 'skills', 'studio-media', 'Context.md'), 'utf8');
    const m = /## 4\. Project file \(abridged\)\n\n```json\n([\s\S]*?)```/.exec(md);
    expect(m).not.toBeNull();
    const r = ProjectSchema.safeParse(JSON.parse(m![1]!));
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues.slice(0, 5))).toBe(true);
  });
});
