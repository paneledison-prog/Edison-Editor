# Cut-outs (Roto Brush / Magic Mask style) for the agent

No green screen, no generative AI. The agent looks at a frame, says where the object is, Studio cuts it out of that frame and follows it through the shot.

## Workflow
1. `studio inspect frame` to see a frame; pick coordinates (fractions of the frame, or pixels with `--px`).
2. `studio matte add --asset A --at MS --box x,y,w,h --fg "x,y"` (also `--bg`, `--fg-fill`, `--bg-fill`, `--outline "x,y;x,y;..." --band`, or `--seeds JSON`).
3. `studio matte preview MT --at MS,MS,...` and look: each frame shows the matte outlined (marks drawn on marked frames) and the cut-out on a checkerboard.
4. Where it drifts: `studio matte key MT --at MS ... [--add]`. The matte is followed from every marked frame to the next, from both sides, so a few marks fix long stretches. `studio matte show MT` lists frames to check and how well following agrees with the marks.
5. Use it: `studio cutout --clip C --matte MT [--invert --feather PX --choke PX]` (transparent outside), or limit any effect: `studio fx add --clip C --effect E --matte MT`.

The marks are ops in the project (undoable). The matte video is derived and cached in `.studio/cache/matte/`; `studio matte export` copies it out (gray FFV1).

## How it works
Colour histograms from the marks and the box give each pixel a likelihood; an edge-aware smoothing (conjugate gradients) settles the boundary on image edges. For the next frame the matte is carried over by dense optical flow, the confident inside and outside are kept, and only a band around the edge is decided again from the colours learned so far (vetted against the keyframe's, so a mistake cannot teach the wrong colours). Colours the object never had, such as something passing in front, are treated as not the object. An optional `--prior u2net|u2netp` adds a saliency model's guess as extra evidence (needs the python models); marks alone work without it.

## Measured (tests/segment.test.ts, tests/matte.test.ts; rendered footage with a known matte)
* One frame from a box and a dot: IoU 0.99. 60 frames from that one frame: 0.980 mean, 0.975 worst through the CLI; 2% noise and double speed the same.
* A bar crossing in front: worst frame 0.86, recovered by itself; one more marked frame at the worst frame: 0.81 -> 0.96.
* Cutout render: 100% black outside the object, 99.7% original pixels inside. An effect limited to the matte changed the outside by 0.9 level. Cutout on a stabilized clip: IoU 0.98 with the object in the steadied picture.
* Speed: about 0.05 to 0.12 s per frame at 480 px (varies with machine load).

## Limits
* Colour and flow based. If the object's colours match the background (the test "similar colours": IoU 0.52 from one dot, 0.68 from four strokes), draw a rough `--outline` (0.91 with points 1.5 px off). Marks on a thin stroke are weighted as decisions, but a region the marks do not cover and the colours cannot judge is decided by smoothness.
* Things passing in front need marks of their own; the object reappearing far from where it left is only re-acquired within a few band widths.
* Edges are soft alpha from a band, not a hair-level matte; no despill or colour decontamination.
* Tested on synthetic footage only; not on real people or hair. The model prior was not run here.
* A matte follows at most 700 frames in one build.
