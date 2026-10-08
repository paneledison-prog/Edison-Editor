# Studio

Local-first media editor operated by Claude Code. Edits real media through the `studio` CLI; no generative AI.

Before any media, render, UI or token task, load the skill: `.claude/skills/studio-media/SKILL.md`
(then `Context.md`, `guidelines.md`, and the matching `rules/*.md`).

Build plan and phase exit criteria: `docs/kit/master-prompt.md`.

Core rules:

- State lives only in `project.studio.json`; every change is an op (validated, logged, undoable).
- The design and animation editor is separate: `design.studio.json`, `studio design ...`, `apps/design`, `packages/design` (`docs/design.md`). Never mix the two files.
- Originals are immutable. Outputs go to `renders/` or `.studio/cache/`.
- Nothing is done until it ran. Report measurements; say "not run" or "not verified" otherwise.
- No color literals outside `apps/ui/src/tokens.css`. Two themes only: light, dark.
- New dependency: add size + license to `docs/licenses.md` in the same commit.
- `helper/skill` and `.claude/skills/studio-media` must stay identical (`pnpm skill:check`).

Commands: `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm tokens:check`, `pnpm ui:build`, `pnpm design:build`, `pnpm bundle:check`, `pnpm studio <cmd>`.
