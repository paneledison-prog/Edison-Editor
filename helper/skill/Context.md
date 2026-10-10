# Context

## 1. What Studio is

A local-first media editing workspace whose operator is Claude Code. It provides tools (a CLI), a source of truth (a project file), eyes and ears (inspection commands), and a viewport (a UI). It does not generate media with AI models. It edits, transforms, assembles, and renders.

Primary users: a developer or creator who asks Claude Code, in plain language, for an edit ("cut the silences, add captions, make a 9:16 version"), and reviews the result in the UI.

Priorities, in order: **correctness → verifiability → lightweight → speed → polish.**

## 2. Architecture

```
project.studio.json  ◀─── ops (validated, logged, undoable) ◀─── CLI / UI / agent
        │
        ├──▶ router ──▶ ffmpeg backend    (cut, concat, scale, overlay, layer placement, effects, mattes, audio chain, burn-in)
        │          └──▶ motion renderer + FFmpeg ("hybrid": composition clips as alpha frames)
        │
        ├──▶ vision (packages/vision): flow, tracking, 3D solve, segmentation, consensus following, clean plates
        │      └─ models (local, CPU): SAM 2.1 tiny (select an object), u2net (saliency), ViTMatte (hair edges), Whisper
        ├──▶ plugins/ (templates, effects, scripts)  ·  expressions  ·  studio script run
        └──▶ UI (watches file)  ·  inspect (frames, sheets, loudness, QC)

design.studio.json ◀─── ops ◀─── studio design ... / design editor   (a separate editor and file: see docs/design.md)

workspaces/m1..m5 (media) and d1..d5 (design): each one of the above, one agent each, at the same time (docs/workspaces.md)
```

Analysis results (mattes, clean plates, trackers, subject lists, the segmenter's encodings) are derived data: cached under
`.studio/cache/`, keyed by the source and the definition, rebuilt when missing. Only definitions live in the project file.

Per-project directory:

```
my-project/
├─ project.studio.json        # source of truth
├─ ops.log.jsonl              # append-only: every op with id, time, actor (agent|ui), inverse
├─ assets/                    # originals, untouched
├─ .studio/cache/             # proxies, thumbnails, peaks, transcripts; matte/ (mattes, segmenter encodings), plate/ (clean plates), subjects/
├─ renders/                   # outputs, stills, preview ranges, contact sheets (matte-*, bg-*, subjects-*)
└─ brand/                     # palette.json, fonts/, logos/
```

## 3. Conventions

- **Time:** stored as integer **milliseconds** on the timeline. Frame snapping happens only at render and in the UI grid, using absolute time → frame (`round(ms * fps / 1000)`). Never accumulate durations by adding frame counts; always derive from absolute times to avoid drift.
- **Ids:** `a_` assets, `t_` tracks, `c_` clips, `k_` keyframes, `m_` markers, `f_` effect nodes, `mt_` mattes, `tk_` trackers. Short base32, stable. Derived, not in the project: `sub_` subject runs (`bg subjects`). A clip's `link` (e.g. `ly_3f9a2c`) groups the layers of one shot.
- **Coordinates:** canvas origin top-left, pixels at project resolution, rotation in degrees clockwise, anchor defaults to center. Marks on a picture (boxes, points, outlines for mattes and trackers) are fractions of the frame (0..1), or pixels with `--px`. Layer placement (`dx`, `dy`) is in project pixels; the anchor (`ax`, `ay`) is a fraction of the canvas.
- **Colors:** sRGB hex in project files. Image and video color-space handling is documented in `rules/04-image.md` and `rules/08-render-and-export.md`.
- **Hashing:** assets are identified by sha256 of content (large files: size + head/tail/sampled blocks, labeled `fast-hash` in the record so nobody assumes it is a full hash).

## 4. Project file (abridged)

```json
{
  "schema": 1,
  "meta": { "name": "Demo v2", "fps": 30, "width": 1920, "height": 1080, "background": "#000000" },
  "assets": {
    "a_k3f9": { "path": "assets/rec.mp4", "kind": "video", "hash": "sha256:9f2c4e1a7b3d5c8e0f6a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8c0d2e", "probe": { "durMs": 183400, "fps": 60, "w": 2560, "h": 1440, "audio": { "sr": 48000, "ch": 2 }, "rotation": 0, "vfr": false } }
  },
  "tracks": [
    { "id": "t_scrn", "type": "video",   "name": "Screen" },
    { "id": "t_e3k9", "type": "video",   "name": "element 3" },
    { "id": "t_a1v0", "type": "audio",   "name": "VO" },
    { "id": "t_m5c1", "type": "audio",   "name": "Music", "role": "music" },
    { "id": "t_g1fx", "type": "graphics","name": "Overlays" },
    { "id": "t_cap1", "type": "captions","name": "Captions" }
  ],
  "clips": [
    {
      "id": "c_0001", "track": "t_scrn", "asset": "a_k3f9",
      "start": 0, "dur": 8200, "srcIn": 12000,
      "transform": { "scale": 1, "x": 0.5, "y": 0.5 },
      "keyframes": {
        "scale": [
          { "id": "k_a001", "t": 1000, "v": 1.0, "ease": "expo.inOut" },
          { "id": "k_b002", "t": 1600, "v": 1.8, "ease": "expo.inOut" }
        ]
      },
      "fx": [
        { "type": "plugin", "id": "lumetri", "params": { "exposure": 0.3 }, "node": "f_k2m4" },
        { "type": "erase", "matte": { "id": "mt_p7q2" }, "node": "f_e8r1" }
      ],
      "link": "ly_3f9a2c", "label": "background (s3 erased)"
    },
    {
      "id": "c_0002", "track": "t_e3k9", "asset": "a_k3f9",
      "start": 0, "dur": 8200, "srcIn": 12000,
      "transform": { "dx": 220, "dy": 20, "size": 0.75, "rot": -8, "ax": 0.31, "ay": 0.62 },
      "keyframes": { "dx": [{ "id": "k_c003", "t": 0, "v": 0 }, { "id": "k_d004", "t": 1500, "v": 400, "ease": "expo.inOut" }] },
      "fx": [
        { "type": "plugin", "id": "lumetri", "params": { "exposure": 0.3 }, "node": "f_n4w8" },
        { "type": "cutout", "matte": { "id": "mt_p7q2", "feather": 1.5 }, "node": "f_c5t9" },
        { "type": "plugin", "id": "drop-shadow", "after": true, "node": "f_d3s6" }
      ],
      "link": "ly_3f9a2c", "label": "element s3 (navy, 14%)"
    },
    { "id": "c_0003", "track": "t_g1fx", "comp": "lower-third", "start": 2000, "dur": 3500,
      "props": { "title": "Ada Lovelace", "subtitle": "Founder", "accent": "token:accent" } }
  ],
  "mattes": {
    "mt_p7q2": { "asset": "a_k3f9", "from": 11800, "to": 20400, "engine": "sam",
      "keys": [{ "at": 12000, "seeds": { "mask": { "w": 480, "h": 270, "rle": [52011, 14, 466] } } }],
      "label": "layer: keep 3" }
  },
  "markers": [{ "id": "m_0001", "t": 5000, "label": "Click: Save" }],
  "exports": [{ "id": "yt", "preset": "youtube-1080p" }, { "id": "vert", "preset": "vertical-1080x1920", "reframe": "auto" }]
}
```

Easing names: `linear`, `hold`, `<family>.<in|out|inOut>` for `quad cubic quart quint sine expo circ back elastic bounce`, or `bezier(x1,y1,x2,y2)`. The same names are used by the UI easing popover and by both render backends.

**`transform` on media clips has two kinds of properties** (each can be a constant here or keyframed under `keyframes`):
* zoom into the picture, the frame stays filled: `scale` (1..8), `x`, `y` (the focus, fractions of the frame, default 0.5);
* place the clip's picture as a layer over what is below it: `dx`, `dy` (project pixels), `size` (0.02..8), `rot` (degrees
  clockwise), both about the anchor `ax`, `ay` (fractions of the canvas, default the centre); what the layer no longer covers is
  transparent and shows the tracks below. `opacity` 0..1. On a clip without layer properties `rot` turns the picture inside the
  frame about its centre.

**A clip's video chain, in order:** stabilize (on the source frames) → fit to the canvas → zoom and pan → `erase` (clean plate) →
LUT → plugin effects → `cutout` (transparent outside the matte) → plugin effects marked `after` (they see the cut-out's
transparency: drop shadow, glow) → pins → layer placement (`dx dy size rot ax ay`) → composited over the tracks below (later tracks
on top). Every effect is an entry on the clip, never baked into the source: `fx bypass` / `fx remove` / `project undo` take it back.

**Layers of a shot** (`studio bg layers`, docs/layers.md): each kept thing is a copy of the shot on its own track with a `cutout` by
its own matte (an element); the shot stays below with an `erase` of the kept things (the background, rebuilt from other frames);
all of them share a `link`. Clips with the same link move, trim and split together in time (`tl move`, `tl trim`, `tl split`);
`layer move` places one of them in the picture.

**Mattes** (`mattes`, docs/background-removal.md, docs/masks.md, docs/cutouts.md) are definitions: an asset, a source range, marked
frames (`keys`: a box, points and strokes, an outline, an exact run-length mask, or `absent`) or a `union` of other mattes, an
engine and edge settings. The matte video they produce is derived (`.studio/cache/matte/`).

## 5. Engines, roles, and license notes

Verify each license against your use before shipping. Record the verified result in `models/manifest.json` or `docs/licenses.md`.

| Engine | Role | Notes |
|---|---|---|
| FFmpeg / ffprobe | decode, encode, filters, analysis | LGPL or GPL depending on the build and enabled encoders (x264 and x265 are GPL). Check `ffmpeg -L` and your build flags. |
| sharp (libvips) | image resize, convert, composite, color ops | Low memory, streaming. Apache-2.0. libvips is LGPL. |
| whisper.cpp or faster-whisper | transcription, word timestamps | Models are MIT-style but verify the specific model. Report model size and language. |
| silero-vad | speech detection for silence cuts | Optional. Better than dB thresholds on noisy audio. |
| u2net / u2netp (ONNX, the models rembg ships, run by our own `tools/bgremove.py`) | image background removal; saliency for subjects and the `auto` matte engine | Apache-2.0 (upstream U-2-Net). Other rembg models vary in license; only these two are in `models/manifest.json`. |
| SAM 2.1 tiny (ONNX, `tools/segment.py`) | select an object by points or a box; proposals for following mattes and for `bg subjects` | Apache-2.0. About 74 MB; CPU; 1 to 2 s to encode a frame (cached), 50 to 100 ms a prompt. |
| ViTMatte small (ONNX, `tools/matting.py`) | opacity at hair and fine edges (`--edge-model vitmatte`) | Apache-2.0. 104 MB; about 1.5 s a frame at 848 x 480; off by default. |
| Real-ESRGAN ncnn-vulkan | 2x/4x upscaling | Needs a Vulkan-capable GPU or falls back to slow CPU; `doctor` reports which. |
| RNNoise (`arnndn`) or DeepFilterNet | speech denoise | `afftdn` is built into FFmpeg and needs no model. |
| Chromium via playwright-core | motion templates and burned-in captions | Replaces Remotion, whose license tiers were rejected. Apache-2.0 driver plus a system Chromium; see `docs/licenses.md`. |
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

**Op:** one validated, reversible change to the project. **Proxy:** low-res, short-GOP copy for scrubbing. **Peaks:** cached waveform min/max pairs. **QC:** automated checks run on a render. **Backend router:** picks FFmpeg alone, or the hybrid FFmpeg + motion renderer path, for a render. **Matte:** a gray video, how much of an object each pixel holds, followed through a shot from marked frames. **Consensus following:** each frame, the segmenter's masks that fit the object's predicted position, colours and motion are united; the rest (neighbours, things passing) are kept out. **Subject:** a thing found in a shot by `bg subjects`, numbered, with facts (size, colour, motion, salience) and its exact mask. **Element:** a layer that is one subject cut out of a shot. **Clean plate:** the background behind a removed thing, rebuilt from the frames that saw it (not generated). **Link:** clips that belong to one shot and move together in time. **Layer placement:** `dx dy size rot ax ay opacity` on a clip.
