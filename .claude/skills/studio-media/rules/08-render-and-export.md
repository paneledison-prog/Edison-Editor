# 08 Render and export

## Defaults for H.264 delivery

- Codec: H.264 High profile, `yuv420p`, even dimensions, CRF 18–21 (lower is larger and better), preset `medium` for finals, `veryfast` for previews.
- GOP about 2 seconds. `-movflags +faststart` so the file streams.
- Audio: AAC-LC, 48 kHz, 192 kbps stereo.
- Color tags for HD and screen content: explicitly tag `bt709` primaries, transfer, and matrix, and set the range. Untagged video is displayed inconsistently across players. Inspect a frame from the render against the source frame to catch shifts.
- Frame rate: keep source CFR if it is 24, 25, 30, 50, or 60. Don't convert 60 to 30 without saying so. Screen recordings at 60 fps encode larger; 30 fps is usually enough for UI demos.

## Encoders

`studio doctor` lists available encoders. Hardware encoders (`h264_nvenc`, `h264_videotoolbox`, `h264_vaapi`, `h264_qsv`) are much faster but usually give lower quality per bit than x264. Policy:
- Previews: hardware if available.
- Finals: x264 by default. Use hardware only if the user asks for speed, and say so in the report.
- Never silently switch encoders. If the chosen one is missing, fail with a clear message.

## Backends

- **FFmpeg path:** build one filtergraph for the whole export where possible. Avoid chaining many intermediate files; each one costs a generation of quality and time.
- **Remotion path:** render overlays or the whole piece. When mixing, render only the animated layers as alpha overlays and composite them in FFmpeg so the source video is encoded once.
- The router prints `backend: ffmpeg|remotion|hybrid` and the reason.

## Safe writes

- Render to `renders/.tmp/<name>.partial`, verify the file opens with ffprobe, then atomically rename. A killed render must never leave a file that looks finished.
- Long renders: segment-based, resumable. Record completed segments by hash.
- Refuse to overwrite an existing render without `--force`. Version names instead.

## GIF and other targets

- GIF: `palettegen` then `paletteuse`, ≤ 720 px wide, 12–15 fps, dither `bayer` or `sierra2_4a`, report file size. If it exceeds 8–10 MB, suggest MP4 or WebM for READMEs and web pages.
- Alpha overlays: ProRes 4444 (`yuva444p10le`) is large but reliable; VP9 WebM with alpha is smaller but less supported in editors.
- Stills: PNG for lossless frames, JPEG quality 90 for previews.

## Sidecars

Write `.srt` and `.vtt` for captions, a `report.md`, and the project snapshot used for the render (`render-<name>.project.json`) so any export can be reproduced.

## Always report

Duration, resolution, fps, codec, encoder used, file size, average bitrate, render time, backend, and whether any stream was copied instead of re-encoded.
