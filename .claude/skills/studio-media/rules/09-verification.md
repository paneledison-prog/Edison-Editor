# 09 Verification

You cannot see or hear a video directly. You verify through frames you view and numbers you measure. This file is how Studio gives you eyes and ears. Use it every time.

## Looking (frames)

- `studio inspect frame --at <t> [--at <t>…]` writes PNGs. Open and look at them.
- `studio inspect sheet --fps 1 --cols 6 --width 320` writes contact sheets, at most 24 tiles per sheet so details stay legible. Look at all of them for short pieces; for long pieces, sample with intent.
- **Always sample:** first frame, last frame, each cut ±2 frames, start, middle, and end of every overlay, every zoom peak, the busiest caption, and anywhere QC flagged an issue.
- Look for: wrong crop, black or frozen frames, text overflow or clipping, text over busy backgrounds, color shifts versus the source, rotation errors, stretched aspect, safe-zone violations, leaked private data, missing glyphs.
- For 9:16 and 1:1 exports, view at 50% size to approximate phone legibility.

## Listening (numbers)

`studio inspect loudness|silence|waveform` and `qc` report: integrated LUFS, loudness range, true peak, clipping samples, silent spans longer than 1.5 s that were not planned, music-to-voice level difference, mono compatibility (phase), join clicks (peak difference across each splice time).
You cannot judge timbre or naturalness. State that. Use before and after noise-floor numbers instead of adjectives.

## Technical QC (`studio inspect qc`)

| Check | Pass condition |
|---|---|
| Container | opens in ffprobe, `moov` at start for web targets |
| Streams | expected video and audio streams present |
| Resolution, fps | match the preset |
| Duration | equals the timeline end within 1 frame |
| Codec compatibility | H.264 High, yuv420p, AAC-LC, even dimensions (for H.264 targets) |
| Loudness | target ±1 LU, true peak under the limit |
| Black frames | none longer than 2 frames unless planned |
| Frozen frames | none unplanned (`freezedetect`) |
| A/V sync | audio and video durations within 1 frame; spot-check on a clap or beep marker when one exists |
| Captions | cps ≤ 20, ≤ 2 lines, ≤ 42 chars, inside safe zone |
| Joins | no click above threshold at splice points |
| File size | within the stated budget |

QC output is JSON with per-check `pass|fail|warn|skipped` and the measured value. A skipped check is reported as skipped, never as passed.

## Regression

- Keep golden frames for each Remotion template and each preset. Compare new renders with SSIM; flag if below 0.98 on frames that should not have changed.
- When you change an engine or preset, re-run the golden set and report the diffs.

## Honesty about what's unverified

Always end a report with "Not verified": things like how platform UIs overlay your captions, playback on specific devices, subjective audio quality, color on uncalibrated screens, and anything you did not sample.
