# Design and animation editor

A separate editor for motion design: posters that move, animated UI, logo and title animations, explainers. It is **not** part of the media editor. They share the machine (Chromium, FFmpeg, the CLI and MCP surface, the two themes) and nothing else.

| | Media editor | Design editor |
|---|---|---|
| Works on | video, images, audio from files | layers you draw: frames, shapes, text, paths, images, audio |
| File | `project.studio.json` + `ops.log.jsonl` | `design.studio.json` + `design.ops.log.jsonl` |
| Package / app | `packages/core`, `apps/ui` | `packages/design`, `apps/design` |
| Start | `studio ui` | `studio design ui` |
| Commands | `studio tl ...`, `studio render`, ... | `studio design ...` |

Both can live in one folder without touching each other. To use a design in a video project: `studio design render --format mov` (transparent ProRes) or `webm`, then `studio ingest renders/<name>.mov`.

## The document

One scene (a size, a frame rate, a length in ms, a background or transparent) and a tree of layers.

* Layers: `frame` (clips its content by default), `group`, `rect`, `ellipse`, `star`, `path` (SVG path data), `text`, `image` (a file under `assets/`, or a small embedded image), `audio` (a file under `assets/`).
* Every layer has `x y w h`, `rotation` (degrees, about the centre), `scale`, `opacity`, `start`/`end` (the part of the scene it exists in), and optionally `fill` (solid, linear, radial), `stroke` (inside, center, outside), `cornerRadius`, `shadow`, `layerBlur`, `bgBlur`, `glass`, `blend`.
* Children are positioned inside their parent. The layer array is always kept in depth-first order and the last sibling is drawn on top, so equal designs are equal bytes.
* Ids are `l_xxxx` for layers and `k_xxxx` for keyframes (letters `i l o u` never appear).

## Animation

A keyframe is a value of a property at a time, with the easing to the next keyframe. Properties: `x y w h rotation opacity scale cornerRadius strokeWidth shadowX shadowY shadowBlur layerBlur trim charProgress volume` (numbers) and `fill stroke` (colours). `trim` draws a path on; `charProgress` types text out; `volume` shapes an audio layer.

Easings: `linear`, `hold`, `<family>.<in|out|inOut>` for `quad cubic quart quint sine expo circ back elastic bounce spring`, and `bezier(x1,y1,x2,y2)`. `spring.out` overshoots and settles exactly on the target.

Presets (`studio design presets`): `fade-in fade-out slide-in slide-out scale-in pop scale-out rotate-in blur-in bounce pulse wiggle draw-on typewriter color-shift`. A preset only writes keyframes, so they stay editable. Between the keyframes of a property the value is interpolated; before the first and after the last it holds.

## Editing in the page

`studio design ui` serves the editor on localhost. Tools: select (V), frame (F), text (T), rectangle (R), ellipse (O), star (S), pen (P, Enter to finish). There is no Image or Audio tool and no upload: images and audio are placed by your agent (`studio design asset`, `studio design add image`), and the page refuses a file dropped on it. While an agent is working in the design the page is view-only (see `docs/workspaces.md`); `studio design ui --hub` shows up to five designs as tabs. Drag to move; handles resize and rotate (Shift: proportional, 15 degree steps); layers snap to the scene and to each other (Alt: no snap); Ctrl+D duplicate, Ctrl+G group, Ctrl+Shift+G ungroup, Delete, Ctrl+Z / Ctrl+Shift+Z, arrows nudge (Shift: 10), Space plays, `,` `.` step a frame, Ctrl+scroll zooms.

* Design tab: layout, opacity, corner, fill, stroke, shadow, blurs, glass, text and shape options. A diamond beside a property keys it at the playhead.
* Animate tab: presets, layer timing, every keyframe with its time, value and easing.
* Timeline: layer bars (drag to retime, drag the ends to trim), keyframe diamonds (drag in time), a scrubbable ruler, play and loop.
* **Auto-keying:** once a property has keyframes, changing it at the playhead (dragging a layer, editing a number) records a keyframe there instead of changing the base value.
* Every edit is one op from the actor `ui`, applied on the page at once and then sent to the server. If an agent changed the design underneath, the page's edit is refused (409) and the page shows the agent's version. Agent edits appear in the open page as they happen.

## Export

`studio design render --format mp4|webm|mov|gif|png-seq|png [--alpha] [--scale N] [--range A:B] [--at MS] [--out PATH] [--force] [--concurrency N]`.

* MP4: H.264, yuv420p, `+faststart`, AAC if the design has audio layers. WebM: VP9 (alpha if the background is transparent or `--alpha`). MOV: ProRes 4444 with alpha. GIF: palette-based, at most 20 fps. PNG: one frame. PNG sequence: a folder, one file per frame.
* The export draws with the same renderer the page uses (`packages/design/src/render.ts`) in headless Chromium, which is offline: images are passed in as data URLs and fonts from `brand/`.
* Audio layers are mixed with their start, end, trim-in and volume curve.
* Same design, same frames: the export is a pure function of time, so concurrency does not change a pixel (tested).

## For agents

Every command is an MCP tool (`studio_design_*`). The most direct way to build a design is one atomic batch: `studio design apply ops.json` (`layer.add`, `layer.set`, `layer.move`, `layer.delete`, `layer.duplicate`, `kf.set`, `kf.delete`, `kf.clear`, `anim.put`, `anim.preset`, `scene.set`). A batch either applies fully or not at all, and `studio design undo` reverts it byte for byte. Look at the result: `studio design render --format png --at 1200`, then view the file.

## Limits, stated plainly

* No auto-layout, components or variants, boolean operations on shapes, masks, or 3D. Paths are SVG path data: the pen tool draws straight segments; curves come from path data (by agent or by hand), not from a bezier editor.
* Layer blur, shadow and background blur use the browser's own filters; `glass` is a blur with a light tint, not a refraction.
* Text uses the brand fonts (Inter) and system fallbacks; there is no font upload.
* Selection handles for a layer inside a rotated or scaled parent are approximate (moves are converted correctly; resizing assumes the parent is not skewed).
* No curve editor for keyframe values (the keyframe list has time, value and easing); no onion skin; no audio waveform; audio plays in the page only from the start of a play.
* Multi-user editing and comments: not built.
