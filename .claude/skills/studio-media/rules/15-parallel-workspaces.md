# 15 Parallel workspaces (up to 5 media, up to 5 design, one agent each)

Reference: `docs/workspaces.md`. Use this when there are **two or more independent jobs** (five clips to edit, five images to grade, five posters to animate) or when the person asks for work "at the same time". One job: ignore this file and work in the project as usual.

## The limits

- At most **5 media** workspaces (`m1..m5`, image, video, audio) and **5 design** workspaces (`d1..d5`) in use. More than five jobs: do them in waves of five.
- **One agent per workspace.** Never put two agents in one folder, and never touch a folder that is not yours.
- **The person does not add media.** The editors have no import, upload or file picker. You ingest every file yourself (`studio ingest`, `studio design asset`). If the person says "add this clip", you do it.
- **The person does not edit while you work.** While you hold a workspace its editor is view-only for them; it opens by itself when you end or go quiet for 120 s.

## Protocol for the main agent

1. `studio ws list`: how many slots are free. Close workspaces the person has finished with (`studio ws close <slot>`: the folder is archived, nothing is deleted); ask first if unsure.
2. `studio ws open --kind media|design --count N --name "<what>" [--width --height --fps]`. It prints each workspace's folder and the flags to use. All or nothing.
3. Start the editor once so the person can watch, in the background: `studio ui --hub --root <root>` (media) or `studio design ui --hub --root <root>` (design). Give the person the URL.
4. **Start all subagents in one message** (they run in parallel), one per workspace, each with the brief below.
5. When they return: `studio ws list` shows every workspace idle; check each result yourself (`studio inspect qc` on videos, `studio design render --format png` and look at the frame for designs). Do not repeat a subagent's claim you have not checked.
6. Report per workspace: what was made, where, what was measured, what was not checked. Leave the workspaces open: the person may now tweak them in the editor. Close them when they are done or before the next batch.

## Brief for each subagent (fill in the braces)

> You work in ONE Studio workspace: slot `{slot}`, folder `{dir}`. Other agents are working in the other workspaces right now.
> - Every `studio` command carries `--project {dir} --agent {slot}` (over MCP: the `project` and `agent` arguments). Never use another folder.
> - First `studio work begin --agent {slot} --note "{what you are doing, short}" --project {dir}`. Last `studio work end --agent {slot} --project {dir}`, also if you fail.
> - Add media yourself with `studio ingest <file>` (or `studio design asset <file>`). The person cannot.
> - Heavy commands (render, export, stills) may wait for a free machine slot. That is expected: do not retry, do not run ffmpeg by hand.
> - If a command fails with `WORKSPACE_BUSY`, stop: you are in someone else's workspace.
> - Do not run `studio ws close`.
> - Read `.claude/skills/studio-media/SKILL.md` and the rule files for your task. Verify before you report: render and look, `studio inspect qc`.
> - Report: files made (paths), measured numbers, anything you did not check. Say "not run" for what you did not run.
> Task: {the job}

## Failure handling

- `WORKSPACE_LIMIT` (exit 5): all slots are in use. `studio ws list`, close finished ones or work in waves.
- `WORKSPACE_BUSY` (exit 5): another agent holds that workspace. Do not use `--force`; find out which agent and why.
- A subagent that died leaves its lease until it expires (120 s of silence). `studio work end --agent <name> --force --project <dir>` ends it at once; check the workspace (`studio project validate` / `studio design validate`) before continuing in it.
- A render that waits is not hung: `studio ws list` and the job governor keep `STUDIO_MAX_JOBS` (2 on a 4-core machine) heavy commands running at once. Do not raise it to go faster unless the machine has the memory: five unlimited exports measured 5.6 GB, two at a time 2.5 GB.

## Not verified

Say so if it matters: a full session of one Claude Code driving five subagents through this protocol was not run in testing (the tests drive the same commands from concurrent processes), and the editors were tested in Chromium only.
