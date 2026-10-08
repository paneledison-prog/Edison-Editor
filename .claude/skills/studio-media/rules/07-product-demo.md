# 07 Product demo video

A product demo is a screen recording turned into a clear, short story. This pipeline is where Studio's pieces come together. It combines `02-video`, `03-audio`, `05-motion-graphics`, and `06-captions`.

## Inputs

- **Required:** a screen recording. Best: the display's native resolution (1440p or higher), 30 or 60 fps CFR.
- **Strongly recommended:** `events.jsonl` from the recorder: one JSON object per line, `{ "t": ms, "type": "move|click|key|scroll", "x": px, "y": px, "button": "left", "target": "optional label" }`, times relative to recording start, coordinates in recording pixels. Studio does not ship a recorder; it accepts this format from any tool, and `Context.md` documents it. `studio demo ingest` validates it and rejects events outside the recording.
- Optional: script text, VO audio, logo, brand palette, fonts, music.

Without `events.jsonl`, there is no cursor data. Say so and plan zooms from inspected frames and transcript timing instead of pretending to detect clicks. Pixel-based cursor tracking is not provided.

## Pipeline

1. **Ingest and normalize:** CFR copy if needed; record effective resolution.
2. **Privacy scan (before anything else):** extract frames at 1 fps, view them, and if OCR is installed, scan for emails, tokens, API keys, internal URLs, names, and notifications. List findings with timestamps. Offer blur or crop ops (`fx: blur-region`). **Never ship a demo without this pass.** State it as done or not done in the report.
3. **Structure:** build a beat list: hook (show the outcome in the first 5 s), context (optional, ≤ 10 s), 3–5 key actions, result, call to action. Default length 60–90 s for a feature demo; 15–30 s for a social cut.
4. **Cut:** remove dead time. Detect spans of no visible change using frame-difference activity. Candidates over 1.0 s are either cut or ramped to 4–8x with a speed badge. Loading spinners and typing can be sped up, results cannot.
5. **Zoom plan (auto-zoom):** see below.
6. **Overlays:** cursor highlight, click ring, callouts, a lower third if people are named, chapter cards for demos over 90 s.
7. **Frame:** window or device frame with padding, rounded corners (12–16 px at 1080p), one soft shadow, brand background. Keep the app UI legible: the recording must occupy at least 80% of canvas width in 16:9.
8. **Audio:** cleanup the VO, fit visuals to narration (adjust segment speed or hold frames; do not speed up speech beyond 1.1x), add music at about −20 dB under VO with ducking.
9. **Captions:** burned in for social variants, sidecar for web.
10. **Multi-aspect:** 16:9 master, then 9:16 and 1:1. Re-layout, don't just crop. See below.
11. **Render, inspect, QC** (`09-verification.md`), then the report.

## Auto-zoom algorithm (`studio demo autozoom`)

Input: clicks (and optionally key and scroll events). Output: scale and position keyframes on the screen clip, using shared easing names.

1. Cluster events: merge clicks within 1.2 s **and** within 25% of frame width into one target.
2. Target region: for each cluster, a box centered on the click centroid with width = 45–60% of the frame (zoom 1.7–2.2x). If a `target` bounding box exists in events, fit that box with 15% padding.
3. Timing: start zooming 400–600 ms **before** the first click in a cluster (the viewer must see where you are going), ease `expo.inOut` over 450–600 ms, hold until 800 ms after the last event in the cluster.
4. Between nearby clusters (distance < 40% of frame): **pan** at the current zoom instead of zooming out and in.
5. Zoom out to 1.0x when idle > 1.5 s or when the next target is far.
6. Constraints: at most one zoom change per 1.5 s; minimum hold 1.2 s; max scale 2.5x; clamp the crop inside the frame; low-pass filter the center path so it doesn't jitter.
7. **Sharpness check:** crop width in source pixels must be ≥ output width. If not, the zoom is soft; report effective resolution and either lower the max zoom or accept and say so.
8. Render path: `scale` (zoom, 1..8), `x`, `y` (focus point, fractions of the frame) keyframes on a media clip render as one FFmpeg `scale=eval=frame` + `crop` per clip, sampled from the keyframe easing. `crop` cannot change its own size per frame, so the scale filter does the zoom and the crop only pans.

Every auto-generated keyframe is a normal keyframe the human can edit in the UI. The command prints the zoom list with timestamps so you can verify against frames.

## Multi-aspect export

- **9:16:** do not center-crop a 16:9 screen recording. Either (a) place the recording at full width inside the vertical canvas over a brand background, with the zoom plan applied more aggressively (target 2–2.6x on action areas), or (b) crop to the active region with a tracked path. State which. Captions go in the lower safe area, callouts re-laid out via the template's `layout: "vertical"` prop.
- **1:1:** similar to 9:16 with less aggressive zoom.
- Keep text on-screen ≥ 28 px equivalent at 1080 wide so it stays legible on phones. Inspect frames at 50% size to check.

## Deliverables

`demo-<name>-16x9-v1.mp4`, `-9x16-v1.mp4`, `-1x1-v1.mp4`, `poster.png` (best frame, chosen from a contact sheet), `captions.srt` and `.vtt`, optional `readme.gif` (≤ 720 px wide, 12–15 fps, size reported), `project.studio.json`, `report.md`.

## Report additions for demos

List: beats, runtime per beat, number of zooms and their max scale, effective resolution at max zoom, sped-up spans, privacy scan result, loudness numbers, QC results, anything not verified.

## Commands (Phase 5)

`studio demo ingest <recording> --name N [--events F] [--vo F] [--music F] [--logo F]` ingests, validates events, and starts the privacy scan (1 fps contact sheets plus a text scan of event labels). **There is no OCR**, so someone must view the sheets. `studio demo autozoom --clip C --events F` writes ordinary scale/x/y keyframes. `studio demo build --name N --plan plan.json --privacy-reviewed` cuts still spans, ramps low-activity spans, adds overlays, intro/outro, VO cleanup, ducked music and captions, renders 16:9, 9:16 and 1:1 as separate layouts, runs QC on each, and writes `report.md`. Not implemented: window/device frame, chapter cards, visual re-timing to the narration. When the crop would have fewer source pixels than the output, autozoom zooms to 1.7x anyway and reports the zoom as soft.
