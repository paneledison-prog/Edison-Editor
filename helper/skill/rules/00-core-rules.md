# 00 Core rules (non-negotiable)

1. **Originals are immutable.** Never write into `assets/`. Never transcode in place.
2. **One source of truth.** State lives in `project.studio.json`. If you find yourself keeping state elsewhere (a temp script, a note), move it into the project or delete it.
3. **Every change is an op.** Ops are validated, logged with actor, and reversible. A change that cannot be undone is a bug.
4. **Inspect before you claim.** A render is unverified until `studio inspect` ran on it. See `09-verification.md`.
5. **Measure, don't guess.** Probe fps, rotation, VFR, audio sample rate, channel layout, color range before editing. Wrong assumptions here cause most media bugs.
6. **Fail loudly.** Missing engine, missing model, unsupported codec: stop with a clear error. Never fall back silently to a lower-quality path. A fallback is allowed only if the output says it happened.
7. **No fake output.** No placeholder images, no silent audio standing in for a missing step, no mock transcripts.
8. **Determinism.** Same project and same inputs give the same output. Seed anything random. No wall-clock time in renders.
9. **Time is absolute.** Never accumulate frame counts. See `Context.md` §3.
10. **Streaming over loading.** Never read a whole media file into memory.
11. **State your limits.** Each tool that has known failure modes lists them in its own `--help` and in the rule file for its domain.
12. **Licenses recorded.** No model or engine is wired in until its license is noted.
13. **Be terse.** The user reads results, not narration.
14. **Media comes in through you.** The editors have no import, upload or file picker; the person asks you and you ingest. While you hold a workspace the person's editor is view-only: begin with `--agent`, end with `studio work end` (`rules/15-parallel-workspaces.md`).
