# Tracking, stabilization, pins and 3D cameras

Everything here is for the agent (`studio ...`); the person sees the result in the editor. Effects are entries on the clip (`studio fx list`), never written into the source, and any of them can be changed, switched off (`fx bypass`) or removed later, each in one undoable step.

## Commands
| Command | What it does |
|---|---|
| `studio track add --asset A [--box x,y,w,h \| --quad ...] [--at MS] [--model homography\|affine\|similarity\|translation\|plane3d]` | Follow a flat region through a video. Stores one homography per analysed frame in `.studio/cache/track/` (derived, rebuilt when missing). |
| `studio track preview TK` | PNG contact sheet with the region outlined (yellow reference, green followed, red lost). Look at it. |
| `studio track show / list / set / build / remove` | Numbers, edit and re-analyse, delete (refused while used). |
| `studio stabilize --clip C [--smooth S] [--lock] [--max-zoom Z]` | Track the camera, smooth the path (or hold the first frame), warp every frame, enlarge just enough to hide the borders. |
| `studio pin --clip C --asset IMG (--tracker TK \| --box \| --quad)` | Corner pin: an image or video follows the plane's four corners. |
| `studio track solve --asset A [--out renders/camera.json] [--preview]` | 3D camera tracking: pose per frame, focal length, point cloud. |
| `studio track add --model plane3d ...` | Follow a flat surface through the solved camera (works when the surface is occluded or leaves the frame). |

Order inside a clip: stabilize first (source frames), then LUTs and effects in stack order, then cutout, then pins.

## How well it works (measured, tests/track.test.ts, camera3d.test.ts, sfm*.test.ts)
Synthetic footage with a known camera only.
* Planar tracker: 0.004 px rms on clean footage; 0.025 px with an object crossing; 0.07 px with 2% noise.
* Stabilize: shake (rms change of motion per frame) 2.49 -> 0.04 px, the known smooth path 0.03; lock holds frames within 0.0 px of the first; no borders. With real depth (parallax) 3.48 -> 0.47 px.
* Pin: edges 0.50 px mean / 1.0 px worst against the true quad on a perspective camera; 0.42 / 0.55 px with plane3d and an occluder.
* 3D solve: camera position within 0.31% of the path, rotation within 0.08 degrees (after the one free similarity); reprojection rms 0.5 px; focal length 0.2% to 4% off (the weakest number; give `--focal-deg --fix-focal` if the lens is known).
* Speed (this machine, 4 cores): tracking about 0.03 s/frame at 480 px; solve 60 frames about 5 s.

## Limits
* Not tested on real handheld footage. Rolling shutter, motion blur, lens distortion and moving subjects covering most of the frame are not modelled.
* Stabilize uses one homography per frame: exact for a flat scene or a rotating camera, approximate with parallax. Footage with a large moving subject should be tracked with `--box` on the background.
* A camera that only pans has no depth: `track solve` / `plane3d` refuse it (use a homography tracker).
* `plane3d` quads are accurate while any of the surface is visible; once it is out of the picture they are extrapolated (13 px off at 640 wide in the test).
* Pins draw over whatever is in front (no occlusion), are rendered at canvas size, and cannot be used on a clip with zoom/pan keyframes.
* Long clips: expression tables are cut into 360-frame pieces and passed to FFmpeg as a script file (tested to 450 frames); tracking holds at most 4000 frames before the reference frame in memory.
* Frame previews do not build trackers; run `studio track build TK` first (renders build them).

## Real footage (three short film/TV clips, 1.4 to 3 s, 848 to 1140 px wide)
What happened when these were run, not what is hoped:
* **Camera shake:** the clips have almost none. On two of them the tracked camera path moved 0.5 and 8 px; `stabilize` changed nothing useful (background-region shake 0.157 to 0.220 px and 0.115 to 0.178 px at 160 px wide, which is measurement noise), so there was nothing to fix. This is not evidence that stabilization works on real shake; it was verified on synthetic shake only.
* **A moving subject filling the frame fools the default.** On the third clip the face fills the frame; the default whole-frame stabilize followed the face (path moved 3.6% of the width, zoom 1.25, background moved more than before). `--box` on the background (here the left strip) gave a steady background with zoom 1.11. `stabilize` now warns when the tracked path moves more than 2% of the width without `--box`.
* **Cuts:** the third clip contains two hard cuts (1800 and 2933 ms). Tracking across a cut is meaningless; `track add`/`build` now report cuts and say to track each shot separately. (Found by this footage; before, the cuts only showed up as two "lost" frames.)
* **3D solve:** refused on all three, correctly ("the camera does not move enough"): static or near-static cameras have no parallax.
* **Pin on a low-texture wood panel** (a static camera): the tracker lost 8 of 43 frames and the pin skewed in the later frames. The tool warned about the lost frames. Pins need a region with texture that stays visible.
