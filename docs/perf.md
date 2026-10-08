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

## Settings window

A modal with Appearance, Project and Connector tabs (9 tests in real Chromium plus the `project.set` op: focus trap and Escape, arrow-key tabs, theme persistence with storage blocked, saving the project settings as one `ui` op that Undo reverses byte for byte, the Connector tab's exact command and clipboard copy, and a real MCP handshake from the server). The Connector tab proves only that `studio mcp` starts; whether Claude Code is connected cannot be seen from the page, and the page never runs `claude`. UI shell bundle: 15.45 KB to 18.4 KB gzipped (budget 250 KB); the baseline was raised for the dialog.

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
- Keyframes and transforms on media clips: not implemented in any backend.
- Translation: not implemented.
- Phase 6: touch input, multi-select, dragging keyframes in the timeline (they are nudged from the inspector), and two browser tabs editing at once.

- Phase 7: only the tools capability is implemented (no resources, prompts, progress notifications, or cancellation); long renders block their call until done. Tested against the official SDK client only, not against Claude Code or other MCP clients.
- Settings: `claude mcp add` was not run against a real Claude Code; the command is the documented form and its target (`studio mcp`) was checked with the MCP SDK client. The Connector command assumes a macOS or Linux shell (Windows quoting differs).
