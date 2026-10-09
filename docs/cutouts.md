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
Colour histograms from the marks and the box give each pixel a likelihood; an edge-aware smoothing (conjugate gradients) settles the boundary on image edges. For the next frame the matte is carried over by dense optical flow, the confident inside and outside are kept, and only a band around the edge is decided again from the colours learned so far (vetted against the keyframe's, so a mistake cannot teach the wrong colours). Colours the object never had, such as something passing in front, are treated as not the object. 
**Engine (`--engine auto|colour|u2net|u2netp`, default `auto`).** Colours alone cannot separate a person from a background of similar colours (wood vs skin, a dark sweater vs a dark wall), so by default a saliency model (u2net, Apache-2.0, run by `tools/bgremove.py`) guides the cut-out and your marks decide *which* object: at a marked frame the parts of the model's mask that lie on the marked object are the subject (other salient things are dropped), its boundary is snapped to the picture's edges in a thin band, and your strokes still win (a `--fg` stroke is inside, a `--bg` stroke is outside, and a stroke on something the model skipped, such as a thin antenna, is kept and carried along). For each following frame the model's mask is used only while it agrees with where optical flow says the object went (IoU of at least 0.6); a sizeable piece of picture in colours the object never had (something passing in front) is cut out of it again; when the model loses the object the colour-and-flow method takes over for that frame. If the model cannot run or does not find the marked object, `auto` uses marks and colours alone and says so in `stats.engineNote`; `u2net`/`u2netp` fail instead of falling back; `colour` never runs the model. The model's masks are cached per source (`.studio/cache/matte/prior-*`), so changing marks does not run it again (about 0.5 s per frame on CPU at 480 px, once). `--prior` on a marked frame still adds the model's guess as extra colour evidence.

## Measured (tests/segment.test.ts, tests/matte.test.ts; rendered footage with a known matte)
* One frame from a box and a dot: IoU 0.99. 60 frames from that one frame: 0.980 mean, 0.975 worst through the CLI; 2% noise and double speed the same.
* A bar crossing in front: worst frame 0.86, recovered by itself; one more marked frame at the worst frame: 0.81 -> 0.96.
* Cutout render: 100% black outside the object, 99.7% original pixels inside. An effect limited to the matte changed the outside by 0.9 level. Cutout on a stabilized clip: IoU 0.98 with the object in the steadied picture.
* Speed: about 0.05 to 0.12 s per frame at 480 px (varies with machine load).

## Limits
* Colour and flow based. If the object's colours match the background (the test "similar colours": IoU 0.52 from one dot, 0.68 from four strokes), draw a rough `--outline` (0.91 with points 1.5 px off). Marks on a thin stroke are weighted as decisions, but a region the marks do not cover and the colours cannot judge is decided by smoothness.
* Things passing in front need marks of their own; the object reappearing far from where it left is only re-acquired within a few band widths.
* Edges are soft alpha from a band, not a hair-level matte; no despill or colour decontamination.
* The model engine is a saliency model made for single prominent objects (people, animals, products). It misses thin or low-contrast parts (an antenna, a pale phone against a bright wall), softens hair, and ignores motion blur; mark what it skips with `--fg` strokes. It does not make hair-level mattes: edges are a thin snapped band, not alpha with despill.
* The model-guided path was tuned on the three clips below and on synthetic shots (where it is used only if it agrees); other footage may need `--engine colour`, an `--outline`, or more marked frames.
* A matte follows at most 700 frames in one build.

## Real footage (three film/TV clips with people, tested through the CLI)
* **Box, dots and strokes on a person against a similarly coloured background** (a man in a blue shirt in front of brown wood paneling) gave a poor first matte: wood was taken as skin and the neck and lower face had holes, because the wood strokes taught the model colours the skin also has. A rough `--outline` of the man (about 25 px accuracy at 854 px wide) gave a clean first frame: face, hands, shirt, and the bottle in front correctly excluded.
* **Following** through the clip kept the man, but the matte leaked into a carved wood post beside his hand (the same colour as skin). The second marked frame with background strokes on the post was clean at that frame; the report said so (following from frame 0 reached the marked frame with IoU 0.91, and back with 0.91) and the leak between the marks remained. So: usable as a draft, not as a finished matte; hair edges are soft and rough.
* **Cuts:** one clip has two hard cuts. The first run followed the matte across a cut and produced nonsense (a bald man's matte placed on a girl). Matte building now detects cuts, never follows across one, leaves a shot with no marked frame empty and says so (`checkThese`), so each shot needs its own marked frame.
* **A dark sweater against a dark background** (clip c) came out loose even with an outline: part of the dark wall at the left was included and a patch of the phone was lost. Not fixed.
* A cutout rendered over a green project background looked right overall (man on green, edges soft, a few green holes and some wood fragments near the hair).

### After the model-guided engine (same three clips, same marks, checked by eye on contact sheets and rendered over green)
* **Clip c** (man on the phone, dark sweater against a dark wall): the first frame no longer takes the dark wall; face, sweater, hand and phone body are cut out and stay clean through the 1.5 s. The phone's pale upper part and antenna were dropped by the model; two `--fg` strokes along them bring it back, but that part is ragged and a few dark fragments of the wall remain beside it. Not perfect.
* **Clip a** (man with two fingers on his chin): clean silhouette including both hands and the shirt; the wooden post and bar that leaked before are gone. Following from frame 0 reaches the second marked frame with IoU 1.0 both ways (with the model engine the marked frame and the followed frame come from the same model mask, so this number says little; the contact sheet is the check). The "abc FUNNY" channel logo, sitting against his sleeve, is partly kept.
* **Clip b** (three shots): each shot cut out from its own marked frame; the bald man, the girl with glasses and the bald man again came out clean at the marked and the following frames viewed. A few specks of white shirt at the edge of the first shot.
* Time: a 45-frame, 480 px build took about 42 s the first time (model run, cached afterwards), a rebuild with the cache about 1 s per 45 frames for following.
* Synthetic footage: with the model engine, a shot of a plain object behind a crossing bar showed the model joining the bar to the object (worst IoU 0.62); the "foreign colour" cut-out and the agreement gate bring it to 0.83 (colour-only: 0.81).
