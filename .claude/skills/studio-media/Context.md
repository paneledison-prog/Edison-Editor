# Context

## 1. What Studio is

A local-first media editing workspace whose operator is Claude Code. It provides tools (a CLI), a source of truth (a project file), eyes and ears (inspection commands), and a viewport (a UI). It does not generate media with AI models. It edits, transforms, assembles, and renders.

Primary users: a developer or creator who asks Claude Code, in plain language, for an edit ("cut the silences, add captions, make a 9:16 version"), and reviews the result in the UI.

Priorities, in order: **correctness → verifiability → lightweight → speed → polish.**

## 2. Architecture

```
project.studio.json  ◀─── ops (validated, logged, undoable) ◀─── CLI / UI / agent
        │
        ├──▶ router ──▶ ffmpeg backend    (cut, concat, crop, scale, overlay, audio chain, burn-in)
        │          └──▶ remotion backend  (animated text/shapes, keyframes, custom easing, templates)
        │
        └──▶ UI (watches file)  ·  inspect (frames, sheets, loudness, QC)
```

Per-project directory:

```
my-project/
├─ project.studio.json        # source of truth
├─ ops.log.jsonl              # append-only: every op with id, time, actor (agent|ui), inverse
├─ assets/                    # originals, untouched
├─ .studio/cache/<sha256>/    # proxies, thumbnails, waveform peaks, transcripts, analysis
├─ renders/                   # outputs and preview ranges
└─ brand/                     # palette.json, fonts/, logos/
```

## 3. Conventions

- **Time:** stored as integer **milliseconds** on the timeline. Frame snapping happens only at render and in the UI grid, using absolute time → frame (`round(ms * fps / 1000)`). Never accumulate durations by adding frame counts; always derive from absolute times to avoid drift.
- **Ids:** `a_` assets, `t_` tracks, `c_` clips, `k_` keyframes, `m_` markers. Short base32, stable.
- **Coordinates:** canvas origin top-left, pixels at project resolution, rotation in degrees clockwise, anchor defaults to center.
- **Colors:** sRGB hex in project files. Image and video color-space handling is documented in `rules/04-image.md` and `rules/08-render-and-export.md`.
- **Hashing:** assets are identified by sha256 of content (large files: size + head/tail/sampled blocks, labeled `fast-hash` in the record so nobody assumes it is a full hash).

## 4. Project file (abridged)

```json
{
  "schema": 1,
  "meta": { "name": "Demo v2", "fps": 30, "width": 1920, "height": 1080, "background": "#000000" },
  "assets": {
    "a_k3f9": { "path": "assets/rec.mp4", "kind": "video", "hash": "sha256:…", "probe": { "durMs": 183400, "fps": 60, "w": 2560, "h": 1440, "audio": { "sr": 48000, "ch": 2 }, "rotation": 0, "vfr": false } }
  },
  "tracks": [
    { "id": "t_v1", "type": "video",   "name": "Screen" },
    { "id": "t_a1", "type": "audio",   "name": "VO" },
    { "id": "t_a2", "type": "audio",   "name": "Music", "role": "music" },
    { "id": "t_g1", "type": "graphics","name": "Overlays" },
    { "id": "t_c1", "type": "captions","name": "Captions" }
  ],
  "clips": [
    {
      "id": "c_01", "track": "t_v1", "asset": "a_k3f9",
      "start": 0, "dur": 8200, "srcIn": 12000,
      "transform": { "x": 0, "y": 0, "scale": 1, "rot": 0, "opacity": 1 },
      "keyframes": {
        "scale": [
          { "id": "k_a", "t": 1000, "v": 1.0, "ease": "expo.inOut" },
          { "id": "k_b", "t": 1600, "v": 1.8, "ease": "expo.inOut" }
        ]
      },
      "fx": [{ "type": "crop", "x": 480, "y": 220, "w": 1280, "h": 720 }]
    },
    { "id": "c_02", "track": "t_g1", "comp": "lower-third", "start": 2000, "dur": 3500,
      "props": { "title": "Ada Lovelace", "subtitle": "Founder", "accent": "token:accent" } }
  ],
  "markers": [{ "id": "m_1", "t": 5000, "label": "Click: Save" }],
  "exports": [{ "id": "yt", "preset": "youtube-1080p" }, { "id": "vert", "preset": "vertical-1080x1920", "reframe": "auto" }]
}
```

Easing names: `linear`, `hold`, `<family>.<in|out|inOut>` for `quad cubic quart quint sine expo circ back elastic bounce`, or `bezier(x1,y1,x2,y2)`. The same names are used by the UI easing popover and by both render backends.

## 5. Engines, roles, and license notes

Verify each license against your use before shipping. Record the verified result in `models/manifest.json` or `docs/licenses.md`.

| Engine | Role | Notes |
|---|---|---|
| FFmpeg / ffprobe | decode, encode, filters, analysis | LGPL or GPL depending on the build and enabled encoders (x264 and x265 are GPL). Check `ffmpeg -L` and your build flags. |
| sharp (libvips) | image resize, convert, composite, color ops | Low memory, streaming. Apache-2.0. libvips is LGPL. |
| whisper.cpp or faster-whisper | transcription, word timestamps | Models are MIT-style but verify the specific model. Report model size and language. |
| silero-vad | speech detection for silence cuts | Optional. Better than dB thresholds on noisy audio. |
| rembg (ONNX) | background removal | **Models vary in license.** Some are non-commercial. Record which model is used. |
| Real-ESRGAN ncnn-vulkan | 2x/4x upscaling | Needs a Vulkan-capable GPU or falls back to slow CPU; `doctor` reports which. |
| RNNoise (`arnndn`) or DeepFilterNet | speech denoise | `afftdn` is built into FFmpeg and needs no model. |
| Remotion | code-driven motion graphics | **Remotion has its own license**: free for individuals and small companies, paid for larger ones. Confirm before commercial use and record the result. |
| Vite + Preact + TS | UI | ~4 KB framework core. No UI kit. Components are ours, styled only with tokens. |

## 6. CLI output contract

Success:
```json
{ "ok": true, "command": "video.cut-silence", "data": { "removedMs": 41200, "cuts": 37 },
  "artifacts": [{ "kind": "project", "path": "project.studio.json" }],
  "warnings": ["noise floor −31 dBFS; threshold raised to −28 dB"],
  "timingMs": 1840, "opId": "op_00af" }
```
Failure:
```json
{ "ok": false, "command": "image.upscale", "error": { "code": "ENGINE_MISSING",
  "message": "realesrgan-ncnn-vulkan not found", "fix": "run `studio doctor --install-hint realesrgan`" } }
```

Exit codes: 0 ok, 1 runtime error, 2 invalid input, 3 missing engine or model, 4 validation failed, 5 would overwrite (needs `--force`).

Rules: stdout is only the JSON object. Progress and logs go to stderr. Output is stable and sorted so diffs are meaningful.

## 7. Presets (defaults; verify before shipping to a platform)

Platform specs change. These are defaults to start from. Run `studio render --preset <id> --explain` to see exact encoder args. Before publishing, check the platform's current documentation.

| id | Canvas | fps | Video | Audio |
|---|---|---|---|---|
| `youtube-1080p` | 1920×1080 | source or 30 | H.264 High, CRF 18–20, yuv420p, `+faststart` | AAC 192k, −14 LUFS |
| `youtube-4k` | 3840×2160 | source or 30 | H.264 or HEVC, higher CRF budget | AAC 256k, −14 LUFS |
| `vertical-1080x1920` | 1080×1920 | 30 | H.264, CRF 19–21 | AAC 192k, −14 LUFS |
| `square-1080` | 1080×1080 | 30 | H.264 | AAC 192k |
| `portrait-4x5` | 1080×1350 | 30 | H.264 | AAC 192k |
| `overlay-alpha` | any | any | ProRes 4444 (`yuva444p10le`) or VP9 WebM alpha | none or PCM |
| `gif-small` | ≤ 720 w | 12–15 | palettegen + paletteuse | none |

Vertical safe zone default (conservative, keep text and key UI inside): leave about 12% at the top, 22% at the bottom, 8% at the sides. Platform UI overlays differ and change.

## 8. Glossary

**Op:** one validated, reversible change to the project. **Proxy:** low-res, short-GOP copy for scrubbing. **Peaks:** cached waveform min/max pairs. **QC:** automated checks run on a render. **Backend router:** picks FFmpeg or Remotion for a render.
