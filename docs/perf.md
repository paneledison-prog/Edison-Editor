# Performance log

Numbers are measurements on one machine, not guarantees. Budgets are from Master Prompt §8. Misses are listed as misses.

**Machine:** Intel Xeon @ 2.30 GHz, 4 cores, 15 GB RAM, no GPU, Linux, Node 22.22.0, ffmpeg 6.1.1 (Ubuntu build, GPL), headless Chromium (software rendering).

## Phase 1

| Area                                                            | Budget              | Measured                                                                                                                | Result                                                                                |
| --------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| CLI cold start, `studio tools`                                  | < 300 ms            | median 34 ms, max 46 ms (15 runs, idle). Bare `node -e 0` is 19 ms. Under the parallel test suite it reads 50 to 75 ms. | within budget                                                                         |
| UI shell JS (gzip)                                              | ≤ 250 KB            | 11.2 KB. Baseline raised from 8.3 KB because the live timeline, SSE hook, and inspector were added.                     | within budget                                                                         |
| UI idle CPU, static shell                                       | ~0%                 | main thread busy 0.013% over 3 s                                                                                        | within budget                                                                         |
| UI idle CPU, live timeline, SSE connection open                 | ~0%                 | main thread busy 0.017% over 3 s                                                                                        | within budget                                                                         |
| Live reload, file written to UI updated                         | ≤ 200 ms            | median 54 ms, max 55 ms (5 changes, 3 runs)                                                                             | within budget                                                                         |
| Timeline, 500 clips, scroll across whole timeline               | 60 fps              | median frame 16.7 ms, p95 17.9 ms, worst 25.3 ms (240 frames). Peak 46 clip nodes in the DOM.                           | within budget; headless Chromium is rAF-capped at 60 fps, so headroom is not measured |
| Timeline, 500 clips zoomed out 6 steps                          | bounded DOM         | 126 of 500 clips drawn                                                                                                  | within budget                                                                         |
| Render, 9 s, 3 clips, 640x360 into 1920x1080, two-pass loudness | none set            | 6.3 s render time (0.7x of runtime), 4.3 MB, 3.9 Mb/s                                                                   | no budget; recorded                                                                   |
| Render, same timeline as GIF (`gif-small`)                      | 8 to 10 MB guidance | 640x360, 1.8 MB for 6 s                                                                                                 | under the guidance                                                                    |

## Phase 2

Fixture: 10 minutes, 640x360 at 30 fps, synthetic speech-like audio (harmonic tone with a 3.7 Hz syllable envelope) over a pink-noise floor at about -63 dBFS RMS. 53 silences (51 planted pauses of 1.5 to 3.0 s between sentences, plus a leading and a trailing silence), 136 micro-gaps of 0.25 s inside sentences that must survive. Ground truth is written by the generator.

| Area                                                                                                 | Measured                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `video cut-silence` analysis, 10 min (loudness pass for the noise floor plus 20 ms RMS silence scan) | 7.1 s the first time; the second run reuses the cached analysis                                                                                 |
| Planted silences found                                                                               | 53 of 53, 0 false silences inside speech, 0 micro-gaps cut                                                                                      |
| Edge error against the planted truth                                                                 | worst 36 ms (detector resolution is one 20 ms window)                                                                                           |
| Removed                                                                                              | 114.8 s of 600 s (19.1%); the 40% guard did not trigger                                                                                         |
| Render of the 485 s result, 640 px wide, x264 veryfast, two-pass loudnorm                            | 60.5 s (8x realtime)                                                                                                                            |
| `inspect qc` on that render (loudness, black, frozen, clipping, 51 join click checks)                | 18.7 s                                                                                                                                          |
| Output loudness                                                                                      | -14.0 LUFS (target -14, tolerance 1), LRA 0.5 LU (the fixture has constant level), true peak -4.7 dBTP                                          |
| Join clicks                                                                                          | 0 of 51                                                                                                                                         |
| Silences of 0.9 s or more left in the output                                                         | 0 (the original had 53)                                                                                                                         |
| Ducking, measured with steep filters that isolate each component                                     | music down 15.7 dB at a hand-set threshold; 16.9 dB from `audio duck` with a 15 dB target; back to within 1.5 dB of the free level after speech |
| Denoise (afftdn nr 20, nf -45 plus 80 Hz high-pass) on a white-noise floor                           | -44.9 to -58.7 dBFS                                                                                                                             |
| Scene detection on three hard-cut scenes                                                             | cuts at 2000 and 4000 ms, exact                                                                                                                 |
| Speed 2x                                                                                             | SSIM against the right source frame 0.960, against the wrong frame 0.817                                                                        |

Methodology notes from this phase: a 2-pole band-pass is not enough to isolate a component of a mix for measuring ducking, because leakage from the louder component sets a floor (it hid the true reduction at -46 dB); the tests use cascaded low-pass and high-pass filters. FFmpeg's `silencedetect` restarts on any single sample above the threshold, so a pause in noisy audio shows up as fragments; the cut tools use 20 ms RMS windows instead.

## Phase 3

Machine as above (4 cores, no GPU). Image engine: sharp 0.35.5 on libvips 8.18.7.

| Area                                                                         | Measured                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Batch resize, 200 JPEGs of 2000x1500 (329 MB) to 1280 px WebP                | 13.6 to 14.6 s alone (about 14 images/s, 3 workers); 28.1 s when the whole test suite was running in parallel                                                                                                 |
| Peak memory of that batch                                                    | 256 to 261 MB. For 50 images: 247 to 256 MB. Four times the images cost no extra memory                                                                                                                       |
| Output                                                                       | 82 MB, 24.9% of the input                                                                                                                                                                                     |
| Resume                                                                       | rerun reused all 200; after changing one input, exactly 1 was redone                                                                                                                                          |
| Kill with SIGKILL after 12 of 80 finished                                    | all 12 finished outputs decode; the rerun reused 12 and made 68; a planted stale `.partial` was removed and reported                                                                                          |
| Encode time for one 1600 px image from a 2000x1500 JPEG                      | PNG 0.11 s, WebP 0.31 s, JPEG 0.44 s, AVIF 15.9 s. AVIF was the smallest (346 KB against 545 KB JPEG and 720 KB WebP) and about 50 times slower, so a 200-image AVIF batch would take roughly 18 minutes here |
| Background removal, 512x512 portrait, u2net on CPU                           | 300 to 370 ms for inference; 1.3 s end to end including Python start-up and loading the 176 MB model                                                                                                          |
| Upscale 4x, 128x128 crop, Real-ESRGAN on a software Vulkan device (llvmpipe) | 16.5 s; the pre-flight estimate predicted 17.1 s (3% off). Fixed cost about 4.8 s, then about 750 s per input megapixel: a 1 megapixel image would take about 12 minutes here                                 |
| Thumbnail with cutout from a 1280x720 frame                                  | about 1.1 s, 160 KB                                                                                                                                                                                           |
| Startup, median of 7                                                         | `studio tools` 35 to 42 ms, `project show` 52 to 63 ms, `models list` 59 to 80 ms. Commands that do not use images do not load sharp                                                                          |

Checks of the measurements themselves: the alpha statistics were first wrong in three ways and were caught by comparing with an independent numpy computation (sharp's `stats()` ignores chained operations, `trim` runs at the input stage, and `threshold` runs before `negate`). The tests now compare reported numbers with Python's.

## Phase 4

Machine as above (4 cores, no GPU). Chromium 141 headless, software rendering (`--disable-gpu`), 2 pages in parallel (half the cores). faster-whisper 1.2.1, CPU, int8.

| Area                                                                                            | Measured                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Motion frames, lower third 1920x1080, 120 frames                                                | 6.0 s (20 fps) after switching capture from `page.screenshot` (about 100 ms per frame) to `Page.captureScreenshot` with `optimizeForSpeed` (about 44 ms per frame); the first version took 11.8 s (10 fps), a cold first browser start added about 10 s once                                                                                                      |
| Same, 640x360, 45 frames                                                                        | 2.2 s (20.7 fps); the cached rerun took 76 ms                                                                                                                                                                                                                                                                                                                     |
| One `motion still`                                                                              | about 1.5 s including browser start                                                                                                                                                                                                                                                                                                                               |
| Caption overlay, 960x540, 341 frames (mostly empty)                                             | 7.7 s (44 fps)                                                                                                                                                                                                                                                                                                                                                    |
| ProRes 4444 encode of the 1080p lower third (120 frames)                                        | about 10 s on 4 cores; 8.8 MB                                                                                                                                                                                                                                                                                                                                     |
| Hybrid render, 13.5 s of 960x960 video plus a caption clip                                      | 14.8 s end to end the first time (7.7 s of it rendering the overlay), 7 s of FFmpeg                                                                                                                                                                                                                                                                               |
| Determinism                                                                                     | a 60-frame lower third rendered twice from a cold cache gave identical SHA-256 for all 60 frames                                                                                                                                                                                                                                                                  |
| Transcription, 13.6 s synthetic speech                                                          | whisper-tiny.en 2.1 s (real-time factor 0.15), whisper-small 7.7 to 9.5 s (0.57 to 0.70), whisper-medium 26.7 s (1.97); model load is included                                                                                                                                                                                                                    |
| Word-start accuracy against known truth (flite speech, whisper-small)                           | 13 of 13 words matched; start error median 40 ms, mean 84 ms, max 338 ms; 5 of 13 within one frame (34 ms). Two words were 330 ms early. Every other word was within 111 ms. **Recognizer word timings are not frame-accurate.** A first run with the default VAD padding (400 ms) was much worse (mean 201 ms, max 635 ms), so the adapter pads speech by 100 ms |
| Caption timing with known word starts (cue builder plus render, 13 word-by-word cues at 30 fps) | first visible frame minus word-start frame was 0 or -1 for all 13 (captions start one frame early on purpose); last visible frame was within one frame of the cue end for all 13                                                                                                                                                                                  |

Also from the first ASR runs: whisper-medium was later than the truth by a mean of 167 ms (a median of +169 ms), while whisper-small was slightly early. Different models place word starts differently, so a caption timing claim needs a measurement on the model actually used.

## Phase 5 (removed)

The product-demo pipeline (`studio demo ingest`, `autozoom`, `build`) was built, run on a synthetic recording, and then **removed at the owner's request**. What stays is general: scale/x/y keyframes rendered as one FFmpeg scale+crop (the frame at scale 2 matched a reference center crop, mean pixel difference 1.8 of 255; `crop` evaluates `iw` once, so the scaled size is written into the expression), the `blur-region` fx, the cursor-highlight and speed-badge templates, and the loudnorm fix below.

Defect found by the removed pipeline and kept fixed: loudnorm's linear mode silently falls back to dynamic when the measured loudness range exceeds its LRA target (-15.6 LUFS instead of -14); the pass-2 LRA target is now the measured value plus 1.

## Phase 6

Browser tests with real pointer input in headless Chromium (9 tests, run 3 times in a row, all passed): drag, edge trim (the source in-point follows the head), a drag that would overlap stops at the neighbour, Escape cancels, split, delete and ripple delete, keyframe arrows and the easing editor, a 409 for an edit made against an old revision, `--read-only`, and 12 concurrent CLI writers (all 12 landed under the new lock). The exit test interleaves UI and agent edits (ui move, agent trim, ui split, agent marker) and then undoes them alternately from the page and from the CLI: the project file came back byte for byte, and redo replayed all four.

UI shell bundle: 11.2 KB to 15.8 KB gzipped (budget 250 KB); the baseline was raised for the write path, snapping and trim logic, and the easing editor.

## Phase 7

`studio mcp` exposes 59 tools (every command except `ui` and `mcp`), each one running the same CLI as a child process, so a call has the CLI's validation, ops, undo, JSON, and exit codes. 4 tests drive it over real stdio (initialize with version negotiation, ping, list, calls that create a project and add a clip, an invalid call that returns the CLI's own error code, undo through the tool, protocol errors, 6 calls in flight, clean exit on stdin close, nothing but protocol messages on stdout). The official SDK client (1.32.1, scratch install) connected, listed 61 tools (before the demo commands were removed), and made successful and failing calls.

Per-call cost is one process start (about 50 ms) plus the command itself.

## Phase 8: caption timing on real speech

Clip: `tests/jfk.flac` from the OpenAI Whisper repository (11 s, a short excerpt of a 1961 US presidential speech); downloaded by the test into the git-ignored fixtures, never committed. There is **no ground truth** for word starts on real speech, so these are proxies, not accuracy: how far three models disagree with each other, and how far the largest model's start is from the nearest loudness onset (10 ms log-RMS rise within 250 ms, which is a weak proxy: words that begin with soft consonants have late onsets).

| Measure (22 words found by all three models)                       | Result                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------ |
| Disagreement between tiny.en, small and medium on one word's start | median 200 ms, max 1090 ms; 1 of 22 within one frame (34 ms) |
| whisper-medium start vs nearest loudness onset                     | median 90 ms, max 240 ms; 4 of 22 within one frame           |

Reading: on real speech the three models place the same word start up to a second apart, and typically 200 ms. The earlier result on synthetic speech (whisper-small median 40 ms) does not carry over. Caption cue starts and the karaoke highlight on real speech should be treated as accurate to about a quarter of a second, not a frame. Nothing in the code was changed from this, since there is no truth to tune against; use medium for finals and view frames at cue starts.

## Phase 8: thumbnail text

The thumbnail headline is now set by the motion renderer (`thumbnail-headline` template, largest font that fits the box and 3 lines, fitted in one browser page), not sharp's text engine; sharp still composites. The existing thumbnail tests pass unchanged, and a new one checks the longest allowed headline (5 long words) stays on at most 3 lines inside the margins at 1280x720 and 1080x1920. A thumbnail now starts a headless Chromium (about 1.5 s) where sharp text did not.

## Phase 8: canvas preview

`GET /api/frame?t=MS&w=PX` on `studio ui` returns one PNG of the timeline at that time (preview size, 160 to 960 px wide) through the same compiler as a render, so cuts, speed, zoom, blur and overlays are all in it; composition clips are drawn from a motion still for that instant. It uses the original media (not a proxy) and has no audio. Frames are cached by project revision, time and width; requests are served one at a time. Measured: the first frame of a project with a title card took 2.9 s (browser start for the overlay plus ffmpeg), a cached one is a file read. The page debounces 180 ms, keeps the old image until the new one is ready, and drops answers to superseded requests. Tested in real Chromium: the title card is in the frame at 4 s and absent at 8 s, the preview follows 12 quick key presses to exactly the final position, and a CLI edit refreshes it. There is no playback, no play button, and no audio.

UI shell bundle: 18.4 KB to 18.8 KB gzipped (budget 250 KB).

## Settings window

A modal with Appearance, Project and Connector tabs (9 tests in real Chromium plus the `project.set` op: focus trap and Escape, arrow-key tabs, theme persistence with storage blocked, saving the project settings as one `ui` op that Undo reverses byte for byte, the Connector tab's exact command and clipboard copy, and a real MCP handshake from the server). The Connector tab proves only that `studio mcp` starts; whether Claude Code is connected cannot be seen from the page, and the page never runs `claude`. UI shell bundle: 15.45 KB to 18.4 KB gzipped (budget 250 KB); the baseline was raised for the dialog.

## Phase 9: plugins, expressions, scripts, rotation and opacity, graph editor

Measured on this container (2 vCPU class, no GPU), single runs unless a count is given.

| What | Measurement |
|---|---|
| Plugin source shipped | glow 2,369 B (4 effects), shapes 6,145 B, light-fx 11,884 B (3 templates), logo-reveal 4,668 B: 25,066 B in total, against a 65,536 B budget per plugin |
| `plugins check` | glow (4 effects run on a test pattern) 0.56 s; shapes 2.6 s, light-fx 2.5 s (3 templates), logo-reveal 1.2 s, each including a headless Chromium start |
| Render, 6 s of the 1280x720 Sintel edit with 4 overlays | plain 13.9 s; opacity keyframes 12.9 s; opacity + rotation keyframes 14.5 s. The differences are inside run-to-run noise, so no cost from either is claimed |
| Demo with all five plugin templates and glow + vignette on the clip, 12 s at 1280x720 | 16.0 s render (plugin frames were already cached by an earlier failed render, which also shows the cache working) |
| Plugin frames cache | keyed by the plugin's content hash, so editing a plugin invalidates only its own frames |
| UI shell | 18.82 KB to 20.80 KB gzip (+10.5%, budget 250 KB). The graph editor itself is a separate lazy chunk of 1.34 KB gzip, fetched the first time "Show graph" is pressed. The shell grew by the toggle, the loader, and the graph styles; the baseline was updated for that reason only |

Verified by test (`tests/p9.test.ts`, 15 tests; `tests/p6.test.ts` graph editor): the expression evaluator (precedence, determinism, refusal of property access, unknown names, nesting and length limits), plugin refusal cases (banned filter, missing `[in]`/`[out]`, undeclared parameter, bad character, escaping path, 70 KB plugin, extra manifest field), parameter ranges in the message, scaffold of each plugin kind then `check`, a broken filter graph and a throwing template both fail `check` with exit 4, a plugin template added as a clip and its props validated, a plugin cannot replace a built-in template, a plugin effect changes the rendered frame and is undone by `project undo`, `expr bake` writes keyframes in one undoable step and refuses out-of-range values, scripts run only through `studio` commands and unmarked files are never imported, the renderer refuses network loads (with a control run: with the block removed the same plugin loads from a local server and the test fails), opacity scales picture brightness over the canvas background, rotation keeps the frame size and clears the corners, and dragging a graph handle is one undoable UI op.

Looked at by eye: frames of the demo (shape layer, saber, particles, lens flare, logo reveal, glow and vignette over real footage), and a rotation frame. These are the only evidence for how they look.

Not verified in phase 9:
- The shipped light effects are 2D canvas drawings, not simulations; none was compared with the commercial tools they are named after, and none should be expected to match them.
- No 3D (Element 3D style) exists. Extruded or tilted text via CSS 3D is possible as a template; not built.
- Layers: tracks stack and overlay in order, but there are no blend modes, groups, masks, or parenting. Plugin effects are per clip; none reads another clip or the audio.
- Text animators beyond the existing `title` stagger and `kinetic-text`: not built.
- Scripts and plugin page code are trusted local code, not sandboxed; the loader checks stop mistakes, not a hostile plugin.
- `opacity` and `rot` keyframes on the audio of a clip, on composition clips, and with `--reframe blur`/`center-crop` combined with rotation were not tested.
- The graph editor was tested with a mouse drag on one handle; keyboard use of handles, touch, and several handles at once were not. It has no add-keyframe or handle-curve (bezier) editing.
- Windows: the shipped scripts and plugin paths were not run there.

## Design editor

Measured on this container (4 cores, no GPU), single runs.

| What | Measurement |
|---|---|
| Editor bundle | 164.8 KB JS + 18.2 KB CSS raw; 54.1 KB gzip in total, measured by a test (budget 250 KB). It includes the op engine (zod), so edits apply on the page before they are sent |
| Export, 1920x1080, 150 frames, 40 layers (shapes, text, shadows, presets) to MP4 | 1 page 7.8 s (19.2 fps); 2 pages 5.6 s (26.8 fps); 4 pages 4.5 s (33.1 fps); 392 KB file |
| Export, 1280x720 button scene (4 layers), 90 frames | 2.7 s (32.9 fps) with 2 pages |
| Still PNG | about 2.3 s, almost all of it starting Chromium |
| Browser tests | 13 scenarios in 18.7 s, including an MP4 export started from the page |

Verified by test (`tests/design.test.ts`, `design-cli.test.ts`, `design-ui.test.ts`): a 300-operation random edit sequence undoes to the original bytes at every step; presets, delete, duplicate, move and keyframe ops invert exactly; a failing batch changes nothing; stills have the right pixels at chosen points and are byte-identical across runs; every frame of a PNG sequence is identical at 1 and 3 pages; MP4 size, rate, codec and duration; the animation moves (pixels checked at 0 and 1.2 s); MOV is ProRes 4444 with alpha, WebM has alpha mode, PNG corners are transparent, MP4 refuses alpha; an image layer draws its file and a missing file is an error; an audio layer is mixed and its volume curve silences the first 500 ms (measured with the loudness tool); the editor draws, creates, moves, resizes, edits numbers, applies presets, auto-keys, shows agent edits live, renames, hides, reorders, deletes, duplicates, groups, edits text, plays, exports, and refuses edits when read-only.

Not verified: other browsers than Chromium; touch input; scenes longer than 5 s or larger than 1080p; more than about 40 layers on a slow machine (the page redraws every layer on each change); text in scripts Inter does not cover; audio playback inside the page (the export mixes it, the page only starts it); the look of `glass` against busy backgrounds.

## Colour plugin

Per-effect cost: 24 frames at 1280x720 on this container, one run each, the FFmpeg process start included (about 60 ms of it). `lumetri` 524 ms, `primary` 207, `zones` 268, `curves` 135, `hue-sat` 257, `qualifier` 1121, `window` 681, `tritone` 206, `colorspace` 65, `channel-mixer` 174, `chromatic` 158, `gaussian-blur` 106, `sharpen` 120, `lens-blur` 516, `motion-blur` 92, `denoise` 129, `denoise-strong` 13296 (heavy), `light-rays` 999, `light-sweep` 440, `drop-shadow` 528, `wave-warp` 302, `turbulent-displace` 447, `glitch` 357, `optics` 145, `stabilize` 562, `slowmo` 2641 (heavy), `keyer` 615, `film-look` 626. The plugin is 38 KB of a 64 KB budget.

Verified by `tests/color.test.ts` (15 tests, 104 s): every effect with every parameter at its minimum, maximum and each enum value, on a picture with and without alpha (about 340 runs, none failed); parameters are refused with their range before any render; neutral settings change no pixel by more than 3 levels; exposure, temperature, saturation, gain, lift, curve inversion, hue-sat and the qualifier act only where they should (checked on SMPTE bars); the window grades inside only; tritone maps black and white to its colours; the keyer clears a green screen and keeps the subject; drop shadow lands under the shape; blur softens an edge and sharpen does not; a LUT file changes a render and a missing or outside file is refused; `slowmo` asks FFmpeg to interpolate before the retime and is flagged heavy; node add, set, move, bypass, remove and undo; `analyze`, `auto` (median luma moved toward 0.45, crushed blacks fell), `match` (distance fell), scopes (a 960x600 sheet), gallery save and apply, `still` on an image.

A bug the tests found: the first `tritone` did nothing (the blend layers were the wrong way round); a second, in the first `auto`, crushed a dark frame (contrast was computed before the exposure change); both fixed.

Not verified: skin-tone fidelity, any camera log material, 10-bit or HDR sources, a calibrated display, real renders of long clips with several heavy effects, GPU encoders.

## Not measured

- UI memory with a 2-hour project open (budget < 300 MB).
- Ingest of a 10-minute 1080p fixture, a 100-cut render, a 200-image batch (`pnpm bench` does not exist yet).
- Timeline scroll on a real GPU-backed browser.
- Hardware encoders: none usable on this machine (`studio doctor` test-encodes them).
- Phase 2 on real speech, real room noise, or real music: every audio result above is from synthetic signals.
- Denoise quality by ear. Only noise-floor numbers are measured.
- Phase 3 on a GPU: Real-ESRGAN was only run on a software Vulkan device.
- Background removal on hair, fur, glass, and other hard cases; only one portrait was inspected.
- Batches larger than 200 images, or images above 12 megapixels.
- Phase 4 on real speech: word-start accuracy was measured only on synthetic flite speech (isolated words, no overlapping speakers, no noise, no accents).
- Caption legibility against busy video; the tests use a black background.
- Non-Latin scripts and right-to-left captions (Inter covers Latin, Greek, and Cyrillic; glyph coverage is not checked, so missing glyphs would fall back silently).
- Motion rendering on a GPU, and templates at 4K.
- Keyframes on media clips other than `scale`, `x`, `y`, `rot`, `opacity`; transforms other than those, and any keyframes on audio.
- Translation: not implemented.
- Phase 6: touch input, multi-select, dragging keyframes in the timeline (they are nudged from the inspector), and two browser tabs editing at once.

- Phase 7: only the tools capability is implemented (no resources, prompts, progress notifications, or cancellation); long renders block their call until done. Tested against the official SDK client only, not against Claude Code or other MCP clients.
- Settings: `claude mcp add` was not run against a real Claude Code; the command is the documented form and its target (`studio mcp`) was checked with the MCP SDK client. The Connector command assumes a macOS or Linux shell (Windows quoting differs).

## Parallel workspaces and the job governor

Details and the table of tests: `docs/workspaces.md`. Measured on 4 cores and 16 GB, five 1280x720 design exports to MP4 started together:

| Limit on heavy commands at once | Wall time | Peak memory (sum of resident sizes; overstates shared pages) |
|---|---|---|
| none | 11.2 s | 5.6 GB |
| 2 (default on 4 cores) | 16.5 s | 2.5 GB |
| 1 | 24.3 s | 1.4 GB |

Five media workspaces each ingesting, adding a clip and rendering 640x360 (clips of 2 to 6 s) at a limit of 2: 2.5 s wall, never more than 2 renders at once. These clips are short; the saving that matters is memory and not being killed, and it costs wall time on a fast machine.

UI bundles after this change: media shell 20.80 KB to 21.65 KB gzipped (+4.1%: workspace tabs, the agent-working state, the drop guard; budget 250 KB, baseline updated); design editor 54.1 KB to 55.2 KB gzipped in total (budget 250 KB).
