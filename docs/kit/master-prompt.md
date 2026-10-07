# Master Prompt: Claude Code Studio, Media Editor (Phase 1)

> Give this file to Claude Code in an empty repository that already contains the `helper/` folder.
> Before writing any code, read, in order: `helper/skill/Context.md`, `helper/skill/guidelines.md`, then every file in `helper/skill/rules/`.
> Then install the skill: copy `helper/skill/` to `.claude/skills/studio-media/` so it loads in every future session.

---

## 1. Mission

Build **Studio**: a lightweight, fast, local-first workspace whose primary operator is **Claude Code**, not a human with a mouse.

Studio is **not** a generative AI tool. It does not invent media. It gives a coding agent everything it needs to **edit** media that already exists, or media the agent builds from code: video, images, audio, and motion graphics, with real tools, real files, and real measurements.

A human can open the UI to watch, scrub, review, and make small manual changes. Every change, from either side, goes through the same project file and the same operations.

## 2. The truth contract (no cap, no hype)

These apply to the code you write and to every message you send me.

1. **Nothing is "done" until it ran.** If you did not execute it, say "not run".
2. **Report measurements, not adjectives.** Say "cold start 212 ms on this machine", not "blazing fast".
3. **State limits plainly.** If background removal fails on hair, or upscaling hallucinates detail, say so in the tool's output and in docs.
4. **No fake features.** If a capability needs a model, binary, or API key that is not installed, the command must fail with a clear, actionable error. It must never return placeholder output that looks real.
5. **Targets are targets.** Every performance number in this file is a budget to be measured. Report actual values, including misses.
6. **Licenses are part of the spec.** Every third-party engine and model gets its license recorded in `Context.md` before it is wired in.

## 3. Operating model

```
 Claude Code ──(bash)──▶ studio CLI ──▶ core (ops, schema, validation)
      ▲                      │                  │
      │                      ▼                  ▼
      │               engines: ffmpeg · sharp · whisper · rembg · esrgan · remotion
      │                      │
      │                      ▼
      └──── inspect (frames, contact sheets, loudness, QC) ◀── renders / previews
                                   ▲
                       UI (read + light edit) watches project file
```

- **Source of truth:** `project.studio.json` plus an append-only `ops.log.jsonl`. Originals are never modified.
- **Tools = a CLI.** Claude Code already has a shell. A CLI with strict JSON output is the cheapest, most debuggable tool surface. An MCP wrapper comes later and must be a thin layer over the same functions.
- **The agent must be able to see and hear its results.** Video is verified through extracted frames, contact sheets, and numeric audio analysis (see `rules/09-verification.md`). Without this loop the editor is blind, so building it is part of Phase 1.
- **Two render backends, one schema:**
  - **FFmpeg backend:** cuts, concat, crop, scale, overlay, audio chain, burn-in captions. Fast, no browser.
  - **Remotion backend:** anything with animated text, shapes, keyframed transforms, or custom easing.
  - A router in `core` picks the backend per project or per clip, and says which it chose and why.

## 4. Scope

| Domain | Capabilities | Engine |
|---|---|---|
| **Video** | trim, split, ripple delete, concat, speed, auto-cut silences, scene detection, captions and subtitles, b-roll suggestions, reframing and resizing for Reels, Shorts, TikTok, 16:9, 1:1, 4:5 | ffmpeg/ffprobe, whisper (word timestamps), silero-vad or ffmpeg `silencedetect` |
| **Image** | background removal, upscaling, batch resize and convert, color grading, thumbnail maker | sharp (libvips), rembg/ONNX, Real-ESRGAN (ncnn-vulkan), ffmpeg `lut3d` |
| **Audio** | noise removal, podcast cleanup chain, loudness normalization, ducking, voiceover (record-first), music and SFX library, transcription | ffmpeg filters, RNNoise or DeepFilterNet (optional), whisper, local SFX index |
| **Motion graphics** | text animation, lower thirds, intros, outros, callouts, device frames, kinetic text, driven by props JSON | Remotion (React, deterministic frames) |
| **Product demo video** | screen-recording ingest, cursor-aware auto-zoom, click highlights, callouts, device or window frames, captions, voiceover, music bed with ducking, multi-aspect export | all of the above, orchestrated by `studio demo` |

"B-roll suggestions" means the agent searches the **local asset library** (by transcript and tags) and proposes placements. It does not fetch stock footage from the internet unless I add a licensed provider later.

"Voiceover" means: import recorded audio, align it to the script, clean it, place it. Text-to-speech is allowed only through a local engine whose license is recorded, and any TTS output is labeled as synthetic in the project file.

## 5. Repository layout

```
studio/
├─ CLAUDE.md                     # 20 lines max: points at .claude/skills/studio-media
├─ .claude/skills/studio-media/  # copy of helper/skill
├─ packages/
│  ├─ core/        # schema (zod), ops, undo/redo, validation, backend router, hashing/cache
│  ├─ engines/     # ffmpeg, image, audio, transcribe, bgremove, upscale, remotion adapters
│  ├─ cli/         # `studio` command, JSON output contract
│  └─ inspect/     # frames, contact sheets, loudness, silence, black-frame, sync, QC report
├─ apps/
│  └─ ui/          # Vite + Preact + TypeScript; tokens.css is the only place colors live
├─ motion/         # Remotion project: compositions + templates driven by props JSON
├─ models/         # downloaded model files (git-ignored), manifest.json with sha256 + license
└─ tests/          # fixtures generated by ffmpeg (no large binaries in git)
```

Language: TypeScript on Node 20+, strict mode. Python only where a model forces it, and then only behind a CLI-invokable adapter with a pinned, documented environment.

## 6. The tool surface (CLI)

Every command: JSON on stdout, human logs on stderr, non-zero exit on failure, `--dry-run` for anything that writes, and idempotent via content-hash caching. The full contract is in `Context.md` §6.

```
studio doctor                          # checks ffmpeg, encoders (nvenc/videotoolbox/vaapi/qsv), node, models, disk
studio tools --json                    # machine-readable list of every command, args, and example
studio init <name>   |  studio ingest <paths…>
studio project show | validate | diff | log | undo | redo
studio tl <op>                         # add-track add-clip move trim split ripple-delete set keyframe marker
studio ops apply <ops.json>            # transactional batch of timeline ops
studio video   cut-silence | scenes | reframe | speed | broll
studio captions transcribe | build | style
studio audio   denoise | clean-podcast | normalize | duck | sfx
studio image   resize | batch | bgremove | upscale | grade | thumbnail | convert
studio motion  scaffold | still | render | templates
studio demo    ingest | autozoom | build
studio render  --preset <id> [--range a:b] [--preview] [--still t]
studio inspect frame | sheet | waveform | loudness | qc
studio ui                              # serve the UI, watch the project file
```

If a command is not implemented yet, it is **absent** from `studio tools`, not stubbed.

## 7. UI requirements

The UI is a viewport and a control surface, not the product's brain.

- **Layout:** top bar (project, undo/redo, export), left tool rail, asset browser (folders, file rows with size and type), central canvas with artboard, right inspector (transform, fill, stroke, grid, export), bottom timeline with transport (to start, play, loop, record) and zoom.
- **Timeline:** type-coded tracks with collapsible keyframe rows, a playhead, virtualized rendering, snapping toggles (grid, playhead, keyframes and layers), and an easing popover with a graph editor (linear, hold, quad through quint, sine, expo, circ, back, elastic, bounce, each with in/out/both, plus saved custom curves). Audio clips draw cached waveform peaks.
- **Live reload:** the UI watches the project file. When Claude Code edits, the UI updates within 200 ms without losing playhead or selection.
- **Honest preview:** the live preview is approximate (proxy media, DOM/canvas overlays). A visible "Approximate" indicator is shown. "Render preview" asks the real backend for a range and plays the result.
- **Manual edits** (drag, trim, split, nudge keyframes) write through the same ops as the CLI, so they appear in the log and in undo.
- **Design system:** exactly one token system, **light and dark themes only**. No third theme. Specified in `rules/11-ui-design-system.md`. No raw hex values outside `tokens.css`; a check script enforces this in CI.
- **Keyboard first:** Space, J/K/L, arrows (frame step), I/O, S (split), Delete, Cmd/Ctrl+Z, zoom, zoom-to-fit.

## 8. Performance budgets (measure, then report)

| Area | Budget |
|---|---|
| CLI cold start, non-media command | < 300 ms |
| UI first load | ≤ 250 KB gzipped JS for the shell; Remotion Player and graph editor are lazy chunks |
| UI idle | ~0% CPU when nothing is playing |
| Timeline | 500 clips scrolling and zooming at 60 fps via virtualization |
| UI memory | < 300 MB with a 2-hour project open |
| Ingest | proxy, thumbnails, and peaks generated once per content hash, in the background, resumable |
| Cut-only exports | stream copy when cuts land on keyframes; otherwise re-encode only the affected GOPs, and say which path ran |
| Rendering | detect hardware encoder at `doctor`; fall back to x264 and say so |

## 9. Build phases and exit criteria

Do not start a phase until the previous exit criteria are demonstrated with command output.

**P0 Foundation:** repo, strict TS, zod schema, ops with undo/redo and log, `doctor`, `ingest` (probe, hash, proxy, thumbs, peaks), `tools --json`, `tokens.css` with both themes, empty UI shell.
*Exit:* ingest a fixture, apply 10 ops, undo 10, project equals the original byte for byte.

**P1 Render and inspect:** FFmpeg backend, presets, `inspect` (frame, sheet, loudness, silence, black frames, QC), read-only timeline UI with live reload.
*Exit:* agent builds a 3-clip timeline, renders it, extracts a contact sheet, and detects a deliberately planted black frame and a planted loudness error.

**P2 Video and audio tools:** cut-silence, scenes, reframe, speed, denoise, clean-podcast, normalize, duck, sfx index.
*Exit:* a 10-minute talking-head fixture with planted pauses is cut; QC shows loudness within ±1 LU of target and no clicks at joins.

**P3 Image tools:** resize, batch, bgremove, upscale, grade, thumbnail.
*Exit:* 200-image batch resize runs with bounded memory; bgremove output composited on a contrasting background is inspected via `inspect frame` and judged by the agent with reasons.

**P4 Captions and motion:** whisper transcription with word timestamps, caption styles, Remotion templates (lower third, title, intro, outro, kinetic text, callout), alpha-channel overlay export.
*Exit:* captions land within one frame of word starts on a fixture with known timings; a lower third is changed by editing props JSON only.

**P5 Product demo pipeline:** `demo ingest`, `autozoom`, `build`.
*Exit:* see acceptance test A.

**P6 Manual UI edits:** drag, trim, split, keyframe nudging, easing editor, all through ops.
*Exit:* manual edit and agent edit interleaved, undo works across both.

**P7 (optional) MCP wrapper** over `core` functions.

## 10. Acceptance tests

**A. Product demo.** Input: a 3-minute 1080p or 1440p screen recording (with or without `events.jsonl`), a script text, optional VO file, a logo PNG, a brand palette.
Output, from one agent session:
1. A 60 to 90 second 16:9 demo, plus a 9:16 cut and a 1:1 cut.
2. Dead air removed, auto-zoom on clicks with eased motion, callouts, a lower third, captions, an intro and outro from templates.
3. VO cleaned, music ducked under speech.
4. `studio inspect qc` passes: integrated loudness −14 ±1 LUFS, true peak ≤ −1.5 dBTP, no black frames over 2 frames, caption text inside the safe zone, audio/video sync drift under 1 frame, no clipping.
5. A written report listing what was done, measured values, and anything not verified.

**B. Resilience.** Kill a render halfway. Re-run. It resumes or restarts cleanly with no corrupt output left behind.

**C. Hostile input.** Variable frame rate phone footage, rotated video with rotation metadata, 48 kHz and 44.1 kHz audio mixed, a file with no audio. All are ingested correctly or rejected with a precise reason.

## 11. Rules for you while building

- Small, verifiable steps. After each, run it and show the output.
- Prefer boring, well-known tools to clever new code. Wrap them; don't rewrite them.
- No dependency without a one-line justification, its size, and its license in `Context.md`.
- Never hold a whole media file in memory. Stream or shell out.
- Never modify originals. All outputs go to `renders/` or `.studio/cache/`.
- Destructive operations (delete asset, clear cache) require an explicit flag.
- Every bug found by a test becomes a fixture or a test.
- Keep `CLAUDE.md` under 20 lines. Put detail in the skill.

## 12. Out of scope for Phase 1

Generative video or image models, cloud rendering, multi-user collaboration, plugin marketplace, 3D, color-managed HDR workflows, live streaming. These come later or never. Do not scaffold them.

## 13. First actions

1. Read the helper files. Summarize back to me in 10 lines what you understood and what is ambiguous.
2. Run `ffmpeg -version`, `ffprobe -version`, `node -v`, and report which encoders are available.
3. Propose the P0 task list with estimated risk per item. Wait for my "go".
