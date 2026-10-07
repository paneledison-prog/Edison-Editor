# 02 Video

## Ingest checks (always)

`studio ingest` must record: duration, fps (average and r_frame_rate), **VFR yes/no**, resolution, **rotation** (display matrix), pixel format, color range/primaries/transfer, audio layout and sample rate, and whether there is audio at all.

- **VFR** (common in phone and screen recordings): convert to CFR at ingest into a working copy (`-vsync cfr` / `fps` filter) and record that the project uses the CFR copy. Editing VFR directly causes drift against audio.
- **Rotation:** apply it explicitly. Do not assume the tool auto-rotates.
- **Odd dimensions:** x264 needs even width and height for yuv420p. Scale to even.
- **HDR or 10-bit sources:** report it. Tone-mapping is not automatic. Say "HDR source, tone-mapped with X" or "kept as is".

## Proxies

Short-GOP, low-res proxies make scrubbing fast: 720p, H.264, keyframe every ~15 frames, AAC. Generated once per content hash, in the background. The UI uses proxies. **Final renders always use originals.**

## Trim, split, concat

- Cuts on keyframes can use stream copy (`-c copy`), which is fast and lossless but only frame-accurate at keyframes. Otherwise re-encode. Report which path ran.
- Frame-accurate cut: seek before input for speed (`-ss` before `-i`) and trim after with `trim`/`atrim` filters when accuracy matters.
- Concat of clips with identical codec parameters can use the concat demuxer. Mixed parameters require the concat filter and a re-encode.

## Auto-cut silences

Prefer, in order: (1) VAD (silero) for noisy audio, (2) `silencedetect` with a threshold relative to the measured noise floor.

Defaults: threshold = noise floor + 8 dB (clean rooms about −35 dB, noisy about −28 dB); minimum silence 0.4 s; keep 100 ms padding before and after speech; 15 ms audio crossfade at joins.
Rules:
- Run `studio inspect silence` first and look at the list of detected spans. Show total removed time.
- Never remove silence shorter than 0.4 s unless asked (it kills natural rhythm).
- Keep pauses before punchlines or after questions. If a transcript exists, do not cut within a sentence's internal pauses shorter than 0.7 s.
- If more than 40% of runtime would be removed, stop and confirm. It usually means the threshold is wrong.

## Scene detection

`studio video scenes` uses FFmpeg's scene score (default threshold 0.3, tune per content). Screen recordings produce false positives on scrolling and animations; prefer cursor events or transcript sections for those. Output is a marker list, not automatic cuts.

## Speed changes

`setpts` for video and chained `atempo` (each between 0.5 and 2.0) for audio. For speed above 8x, drop audio. For waiting sections in demos, mute audio and add a speed badge.

## Reframing (16:9 → 9:16, 1:1, 4:5)

Three methods; choose and say which:
1. **Center crop:** only if the subject is centered. Check with frames.
2. **Tracked crop:** crop window follows a subject or the cursor. Smooth the path (low-pass or spline), clamp velocity, and keep headroom. Needs detection data. If none is available, use keyframes you set from inspected frames.
3. **Fit + background:** the 16:9 video scaled to fit width, over a blurred or branded background. Legible and honest for screen content.

Never stretch. Never crop away text the viewer needs; inspect the cropped frames.
Source smaller than target: say the effective resolution, do not silently upscale.

## B-roll suggestions

Search the **local library** by transcript match and tags. Return up to 3 candidates per slot with the reason (keyword match, scene tag), a proposed placement time, and a suggested duration. Never insert without approval unless the user said "auto". Never pretend stock footage was found if the library is empty; say the library has no match.

## Transitions

Hard cuts by default. Crossfade 8–12 frames for time jumps. Avoid wipes and gimmicks unless the brand asks. One transition style per piece.

## Known limits (state them when relevant)

- Stabilization (vidstab) needs a two-pass analysis and crops edges.
- Frame interpolation is not provided. Slowing footage below 50% shows judder.
- Object removal and rotoscoping are not provided.
