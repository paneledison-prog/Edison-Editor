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
