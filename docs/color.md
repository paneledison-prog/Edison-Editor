# Colour and look (built-in plugin)

Ships with Studio as the plugin `color` (`plugins/color`, 38 KB). Nothing to install: it loads with the other shipped plugins and its effects work on video clips and on images (an image on the timeline, or `studio color still`). It is one more plugin on the same plugin system as user plugins, so everything in `docs/plugins.md` applies; what makes it built in is that it is in the checkout and cannot be shadowed.

## Nodes

A grade is the clip's stack of **nodes**: each node is one effect with its parameters (the clip's `fx` array). Nodes run in order; LUTs run first. A node can be switched off (`bypass`) without losing its settings, moved, edited and removed, and each of those is a validated, logged, undoable op. Colour nodes work in 8-bit RGB (planar) and drop transparency; put the keyer last.

## Effects (`studio color effects`, ranges and costs included)

| Group | Effects |
|---|---|
| Correction | `lumetri` (exposure, contrast, highlights, shadows, whites, blacks, temperature, tint, saturation, vibrance, sharpen), `primary` (Lift, Gamma, Gain, Offset: master and per channel), `zones` (HDR-style: deep shadows, shadows, mids, lights, speculars in stops), `curves` (master, red, green, blue point curves), `hue-sat` (hue, saturation, intensity for one colour family), `channel-mixer`, `colorspace` (Rec.601 / 709 / 2020) |
| Isolating | `qualifier` (hue, saturation, value ranges with soft edges, then hue shift, saturation, gamma, warmth), `window` (ellipse to rounded rectangle, feather, invert; grade, warm, blur inside) |
| Look | `tritone`, `film-look` (halation, bloom, faded blacks, warmth, saturation, grain), `chromatic`, plus `glow`, `bloom`, `grain`, `vignette` from the `glow` plugin |
| Detail | `gaussian-blur`, `sharpen`, `lens-blur` (approximation), `motion-blur` (frame blend), `denoise` (fast), `denoise-strong` (non-local means, slow) |
| Light | `light-rays`, `light-sweep`; templates `particles`, `saber`, `lens-flare` from `light-fx` |
| Distortion | `wave-warp`, `turbulent-displace`, `glitch`, `optics` (lens distortion), `stabilize` (single pass) |
| Compositing | `keyer` (green or blue screen with spill suppression and edge softening), `drop-shadow` |
| Time | `slowmo` (frame interpolation before the clip is slowed: only useful below speed 1) |
| First-class | `lut` (a `.cube` or `.3dl` file inside the project) |

## For agents: `studio color ...`

| Command | What it does |
|---|---|
| `effects [--query W]` | every effect with parameter types, ranges, defaults and cost |
| `stack --clip C` | the nodes with their parameters (defaults filled in) |
| `add --clip C --effect ID [--params JSON] [--at N]`, `set --node N --params JSON [--replace]`, `remove`, `move --to`, `bypass [--off]` | edit the stack |
| `lut --clip C --file luts/x.cube` | add a LUT |
| `analyze (--clip C --at MS \| --file F)` | luma percentiles, clipping, per-channel mean and spread, midtone cast, saturation, in plain notes |
| `scopes (--clip C --at MS \| --file F)` | one sheet: waveform, RGB parade, vectorscope, histogram (and each as its own PNG) |
| `auto --clip C [--at MS] [--report-only]` | measures a frame and adds a `lumetri` node for exposure, contrast, end points, white balance; reports before and after, and warns if it made the frame worse |
| `match --clip C --ref C2\|FILE [--strength 0..1]` | per-channel gain and offset (a `primary` node) toward a reference; reports the distance before and after |
| `save --clip C --name N`, `gallery`, `apply --name N --clips a,b [--replace]` | keep a grade in `grades/N.json` and put it on other clips |
| `still --file F --nodes JSON` | run nodes on an image and write a PNG |

Measurements are of the rendered frame (every layer and node), downscaled to 160x90, on encoded values (not linear light). `auto` and `match` are starting points computed from one frame: look at the result and adjust the nodes.

## Speed and stability

* Every effect is a bounded FFmpeg filter graph: no per-pixel scripting except at 192x108 for masks (scaled up), so cost does not grow with resolution the way a full-frame expression would.
* Measured per effect (24 frames at 1280x720, this container, one run, FFmpeg process included): most are 65 to 700 ms; `qualifier` 1.1 s, `light-rays` 1.0 s, `slowmo` 2.6 s, `denoise-strong` 13.3 s. Heavy effects are labelled and a render warns when one is used.
* Stability is tested, not assumed: the test suite runs every effect with every parameter at its minimum, maximum and each enum value, on a picture with and without alpha (about 340 runs, none may fail), checks parameters are validated before any render, and checks neutral settings leave the picture unchanged. A bad parameter is refused with its allowed range; a failing graph is a render error with FFmpeg's reason, never a crash of the app or the editor.

## Not built

* **AI tools:** Magic Mask, Roto Brush, Depth Map, Face Refinement, Relight, AI noise reduction. Studio has no AI models for these. `studio image bgremove` (U2-Net) cuts out a still image subject; there is nothing like it for moving video.
* **Tracking:** windows and qualifiers are static for the whole clip.
* **Colour Warper** (the grid) and freeform Hue vs Hue / Hue vs Sat / Lum vs Sat curves: `hue-sat` does the same job one colour family at a time, with fixed family widths.
* **Camera log and RAW:** no vendor transforms ship. `colorspace` handles Rec.601/709/2020; bring your own `.cube` LUT for a camera's log curve.
* **Displacement Map from a second layer**, **Motion Tile**, **two-pass Warp Stabilizer**: not built (`stabilize` is single pass).
* **Lens blur** is an approximation (a focus area, brightened highlights, blur outside), not a depth-based bokeh. `light-rays`, `light-sweep`, `glow` and `film-look` are look effects, not simulations of any commercial plugin.
* Scopes and `auto` are measured on encoded values, not linear light or a calibrated display.
