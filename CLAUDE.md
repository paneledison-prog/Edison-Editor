# Studio

Local-first media editor operated by Claude Code. Edits real media through the `studio` CLI; no generative AI.

Before any media, render, UI or token task, load the skill: `.claude/skills/studio-media/SKILL.md`
(then `Context.md`, `guidelines.md`, and the matching `rules/*.md`).

Build plan and phase exit criteria: `docs/kit/master-prompt.md`.

Core rules:

- State lives only in `project.studio.json`; every change is an op (validated, logged, undoable).
- The design and animation editor is separate: `design.studio.json`, `studio design ...`, `apps/design`, `packages/design` (`docs/design.md`). Never mix the two files.
- Parallel work: up to 5 media workspaces (`m1..m5`) and 5 design workspaces (`d1..d5`) via `studio ws open`, one agent or subagent each, every command with `--project <its folder> --agent <its slot>` (`docs/workspaces.md`). While an agent holds a workspace the editor is view-only for the person.
- Media is added by the agent (`studio ingest`, `studio design asset`), never from the editors: they have no import, upload or file picker.
- Originals are immutable. Outputs go to `renders/` or `.studio/cache/`.
- Nothing is done until it ran. Report measurements; say "not run" or "not verified" otherwise.
- No color literals outside `apps/ui/src/tokens.css`. Two themes only: light, dark.
- New dependency: add size + license to `docs/licenses.md` in the same commit.
- `helper/skill` and `.claude/skills/studio-media` must stay identical (`pnpm skill:check`).

Commands: `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm tokens:check`, `pnpm ui:build`, `pnpm design:build`, `pnpm bundle:check`, `pnpm studio <cmd>`.
