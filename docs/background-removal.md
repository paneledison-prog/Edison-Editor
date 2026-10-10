# Removing a video's background (`studio bg ...`)

Keep the people or things you choose, take everything else out of every frame. Three commands, run by the agent; no green screen, no generative AI (nothing is invented: what is kept is the original pixels, the rest is transparent).

```
studio bg subjects --asset a_xx                 # what is in the shot, numbered (look at the two sheets it writes)
studio bg remove --run sub_xxxx --keep 3 --clip c_xx   # keep subject 3, take out the rest (a cutout effect on the clip)
studio bg check mt_xxxx                         # the frames most likely to be wrong, on one sheet
```

## 1. `bg subjects`: what is in the shot
At a few moments (one in each shot when the clip has cuts; otherwise its start, middle and end; or `--at MS,MS`), the segmenter (Segment Anything 2.1 tiny) is asked "what is here?" on a 9 x 6 grid of points, and again on every place that moves against the background (found by optical flow against a robust fit of the camera's own motion), so that a small person far away is found too. Its masks are cleaned into one list: duplicates, weak, tiny and whole-frame masks go; a mask lying inside a larger one is listed as a part of it (`partOf`).

For every subject the JSON says what an agent needs to choose without guessing:

| field | meaning |
|---|---|
| `id` | `s3`: what `--keep 3` names |
| `at` | the moment it was found at (ms of the asset) |
| `areaPct`, `bbox`, `point` | how big, where (fractions of the frame), and a point inside it |
| `colour`, `shape` | the nearest plain colour name and tall / wide / compact: "the navy jacket", "the pink dress" |
| `salience` | how much a saliency model (u2net) thinks it is the picture's subject, 0..1 |
| `moves` | still against the background, or moving and how fast (% of the width per second) |
| `touchesEdge` | which frame edges it touches (a thing cut by the frame, or the background itself) |
| `quality` | the segmenter's own estimate of its mask (a hint, not a measurement) |

Two pictures: `renders/subjects-<run>.png` (every moment, each thing tinted, outlined and numbered; parts numbered in yellow) and `renders/subjects-<run>-each.png` (each thing cut out alone on a checkerboard: this is where you see that a mask holds only a face, or a person and the chair together). The listed things are the most interesting first (moving, salient, large), 12 per moment by default (`--max`).

## 2. `bg remove`: keep what you name
* `--keep 3` keeps one thing. `--keep 3,7` keeps two, each followed on its own and then united. `--keep 3+15` says 3 and 15 are the same thing: two parts of it found at the same moment, or the same person found in two moments or two shots (each one becomes a marked frame of one matte).
* `--remove 5` names things that must go even where they touch what is kept (dots on them are marked as not the object).
* `--visible-from MS` / `--visible-until MS`: the kept things are not in the picture before / after that time (they come out from behind something, or leave). Following stops there instead of sticking to what hides them.
* `--clip c_xx` puts a `cutout` effect on the clip (non-destructive: `fx bypass` brings the background back, `project undo` takes it all back). Without it only the matte is made.
* `--auto` (no run needed): finds the subjects and keeps the most prominent one (salient, large, moving), and says what it chose and what else there was.
* The edge flags of `mask add` apply: `--hair`, `--edge-model vitmatte`, `--feather`, `--choke`, `--smooth`, `--edge-width`.

The marked frame of each kept thing is that subject's own mask, exactly as `bg subjects` found it (stored in the project, run-length coded, so nothing asks the segmenter again and gets something else); gaps between chosen parts are closed where the segmenter's masks fit them. Then it is followed through the shot:

**Following by consensus of proposals** (`packages/vision/src/consensus.ts`). Asking the segmenter "where is the object?" with a box and points on a frame where the object touches something similar (another person, a bow, a coat of the same navy) gives back the two joined, and the leak then grows frame after frame. So on every frame the segmenter is asked many small questions (14 points spread over where the object's motion put it, three candidate masks each, and the box), and each candidate is judged:
* **position:** it is the object's only if it lies almost entirely (93%) where the previous matte, carried by the optical flow, says the object is, with a margin for what the flow got wrong;
* **colour:** a candidate in colours the object's palette at the marked frame never had is something else;
* **motion (layered):** the object's motion and the background's are fitted (robust affine fits of the flow on the middle of the object and on a ring far from it); for each candidate the previous frame is sampled where each motion says its pixels came from, and the one that explains its pixels better says whether it moves with the object or with the background. A still neighbour of the very same colours is told apart this way.

The accepted candidates are united (their edges are the segmenter's edges); the middle of the prediction fills their gaps unless a candidate there is plainly something else; pieces that stick out of the object and are in colours it never had, or move with the background, are cut off; then the band at the boundary is decided again from the picture (the colour-and-flow step), specks are removed, the matte is steadied over time along the motion, and the edge is made at the picture's size (guided filter, or ViTMatte with `--edge-model vitmatte`) with the old background taken out of the edge colours.

**Hidden and gone.** The object's velocity is remembered. When, two frames in a row, everything where the motion put it stands still with the background, the object did not stop dead: something is in front of it, and the matte is empty there (and stays empty until it is found again or the next marked frame). A frame whose matte does not look like the marked object is not shown either. Both are listed in `checkThese`.

**Report.** `result.quality` sums up how every frame was made: `consensusPct` (frames decided by consensus), `fallbackFrames` (none of the segmenter's masks fitted, so the matte was carried by motion alone: look at them), `framesWithNeighboursKeptOut` (frames where something touching the object was kept out: good to know where to look), `specksRemoved`, `framesWithIslands`, `worstAreaChangePct`. `needsALook` names the frames most likely to be wrong, and `preview` is a sheet of them.

## 3. `bg check`: look before you render
`studio bg check mt_xxxx` lists, per frame, how it was decided (`key`, `consensus`, `best`, `prediction`, `hidden`), what was kept out and what was cleaned, and writes `renders/bg-check-<id>.png` with the frames most likely to be wrong (carried by motion alone, in pieces, hidden, or changing area suddenly). Fix what you see:
* a neighbour joined the object: `studio mask key mt_x --at MS --neg "x,y" --add`
* the object is hidden or not yet in: `studio mask key mt_x --at MS --absent` (or `bg remove ... --visible-from MS`)
* a part is missing: `studio mask key mt_x --at MS --point "x,y" --add`
* the edge is rough: `studio matte edge mt_x --hair` or `--edge-model vitmatte`

## Measured
**Ground-truth benchmark** (the only way to know how right a matte is): a real person (cut from clip a with u2net, so its opacity is known exactly) moves across real footage (clip d, with other people standing in it) for 70 frames at 864 x 480, travelling, turning +-9 degrees, changing size by +-12% and with motion blur (5 sub-frames). He passes in front of and touches two women, a pink bow and a table. Scored against the composited truth over all 70 frames:

| | IoU mean | IoU worst | stray area (of the object) | islands per frame | error flicker |
|---|---|---|---|---|---|
| before (box and point, `mask add`, the segmenter asked with a box each frame) | 0.781 | 0.481 | 9.0% | 2.84 | 0.0119 |
| consensus by position only | 0.713 | 0.456 | 9.4% | 2.21 | 0.0114 |
| + colour and flow-residual motion | 0.819 | 0.643 | 2.8% | 0.93 | 0.0111 |
| + carving what sticks out | 0.923 | 0.753 | 0.06% | 0.21 | 0.0089 |
| + never-seen colours, layered-motion test (final, same marks) | **0.948** | **0.864** | **0.02%** | 0.21 | **0.0074** |
| `bg subjects` then `bg remove --keep 3` (no marks at all) | 0.944 | 0.870 | 0.01% | 0.19 | 0.0073 |

Before, the matte took in the women one after the other as he passed them (IoU falling steadily to 0.48); after, what is left is skin-coloured pieces of them where his edge touches theirs (worst frames 0.86) and the straight edge of the cut-out person at the bottom of the frame, which is an artefact of how the benchmark was made. Scripts: `bench/` in the session scratchpad (not in the repo: the clips are film clips).

**Synthetic shot** (`tests/bg.test.ts`, a textured blob moving fast over a panning background, 16 frames): `bg subjects` finds it as moving, `bg remove --keep` gives IoU 0.986 mean, 0.978 worst (the box-and-point `mask add` on the same kind of shot: 0.69).

**Real clips** (no truth: judged on contact sheets and over green):
* **a** (man moving both hands at his chin): clean through the clip, hands included.
* **b** (three shots: a bald man, a girl, the bald man again; fast head movements): kept with `--keep 3+16+26` (one subject per shot), clean in every shot; one dark strip of the doorway beside the girl's hair at 1900 ms.
* **c** (dark sweater against a dark wall, a phone): man, hand and phone (`--keep 6+7+8`) clean in every frame looked at. The marked frame first had holes between the hand and the phone (the three subjects' masks did not meet); the segmenter's masks that fit the chosen ones now close such gaps at the marked frame (never taking anything away), and it is clean.
* **d** (a boy, 0.7% of the frame, walking out from behind a man in a navy coat of the same colour as his jacket): found by his motion (`bg subjects` lists him as moving, 14% of the width per second; before the motion search he was not listed at all). Followed cleanly from 1500 ms on. Before he comes out the matte is empty at 1200 and 1300 ms by itself (his motion stops dead where he went: he is behind something); at 1400 to 1530 ms a sliver of the coat's edge is still taken. Before this work the matte sat on the coat for the whole half second.

**Time** (4 CPU cores, no GPU): `bg subjects` 27 to 38 s for three moments. `bg remove`: every frame is encoded once by the segmenter (1 to 2 s a frame, cached), then about 1.1 s a frame for the proposals and 0.3 s for the consensus: 70 frames took 3 min with the encodings cached, a 90-frame three-shot clip 5.6 min the first time. A second thing kept on the same clip reuses the encodings.

## Limits (said, not hidden)
* Two things of the same colours that move together cannot be told apart by anything here (the consensus keeps what it was given, as `tests/consensus.test.ts` checks); mark them.
* An object that stops moving behind something is not called hidden (only a dead stop of a moving object is); it is followed onto what hides it. Use `--absent` / `--visible-from`.
* An object that comes back after being hidden is not found again by itself: mark it where it is back.
* Edges: the segmenter's masks are predicted at 256 x 256 and refined at the picture's size; hair and motion blur are soft (ViTMatte helps with hair: docs/masks.md).
* Slow: a few seconds a frame on CPU. Long clips: at most 700 frames per matte.
* Tuned on one benchmark and four real clips. Other footage may need marks.
