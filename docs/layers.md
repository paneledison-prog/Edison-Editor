# Layers: every element of a shot movable on its own (`studio bg layers`, `studio layer ...`)

A **layer** is a video clip on its own track. Tracks later in the list are on top. A layer's picture can be placed over what is
below it: moved, sized, turned about an anchor and faded, at one value for the whole clip or with keyframes. A **shot split into
layers** is one element per kept thing (a person, a phone, a bottle) plus the background:

```
studio bg subjects --asset a_xx                        # what is in the shot, numbered: look at the two sheets
studio bg layers --run sub_xxxx --keep 3,7 --clip c_xx # 3 and 7 become elements; the shot stays below as the background
studio layer list                                      # what is where, top first; which layers belong together (link)
studio layer move --clip c_e1 --dx 220 --dy 20 --size 0.75 --rot -8
studio layer move --clip c_e1 --t 0 --dx 0             # keyframes: from here ...
studio layer move --clip c_e1 --t 1500 --dx 400 --ease expo.inOut   # ... to there
studio fx add --clip c_e1 --effect drop-shadow --after-cutout       # an effect on that element only, seeing its edges
studio fx add --clip c_xx --effect gaussian-blur --params '{"radius":6}'   # the background only
studio layer hide --clip c_xx                          # no background: the elements over the tracks below
studio render --still 1200 --out check                 # look at it
```

## What `bg layers` builds
* **Elements:** for each group in `--keep` (comma separated; `3+15` joins subjects into one thing), a copy of the shot on a new
  track above it: same start, duration, source in-point, effects (each under a new id, with their keyframes) and motion, plus a
  `cutout` by that thing's own matte (followed through the shot by consensus of proposals: `docs/background-removal.md`). Its
  anchor (`ax`, `ay`) is put on the thing, where it was found, so sizing and turning happen about it.
* **Background:** the shot itself, with an `erase` effect of all kept things (a clean plate, `docs/masks.md`): where an element
  was, the background as other frames of the shot saw it. Moving an element away shows that, not a copy of the element.
  `--no-erase` skips it (cheaper; then moving an element shows the original behind it).
* **Link:** every layer of the shot gets the same `link`. Linked clips move, trim and split together in time (`tl move`,
  `tl trim`, `tl split`); after a split the right halves share a link of their own (`<link>@<ms>`). Placing a layer in the
  picture (`layer move`) does not touch the others.

Everything is ops: `project undo` takes `bg layers` back in one step.

## Placing a layer (`studio layer move`)
| property | meaning | range |
|---|---|---|
| `dx`, `dy` | move right / down, in project pixels | -20000..20000 |
| `size` | scale about the anchor (1 = as it is) | 0.02..8 |
| `rot` | turn about the anchor, degrees clockwise | -3600..3600 |
| `opacity` | 0 (gone) .. 1 | 0..1 |
| `ax`, `ay` | the anchor, fractions of the canvas (default 0.5, 0.5) | -2..3 |

Without `--t` the values hold for the whole clip. With `--t MS` (from the clip's start) they are keyframes; easings as everywhere
(`--ease expo.inOut`, `hold`, `bezier(...)`). A constant cannot be set over keyframes of the same property: the command says so
(`layer reset --prop dx` removes them). `layer reset` puts the placement back (the anchor stays); `layer hide` / `show` hide the
layer's track; `layer front` / `back` put it on a new top or bottom track.

How it renders: after the clip's own chain (scale to the canvas, zoom and pan, erase, effects, cutout, effects after the cutout,
pins), the finished picture is given a transparent margin and warped once per frame by its placement (FFmpeg `perspective`, in
the picture's own 4:2:0 format), then cut back to the canvas; what it no longer covers is transparent and shows the tracks below.
The existing `scale`, `x`, `y` (zoom into the picture, the frame stays filled) still work and come first. On a clip with any layer
property, `rot` turns about the anchor after the cutout instead of inside the frame.

## Effects on elements
`studio fx add --clip <element> --effect E` puts an effect on that element only, and says where it went (`placed`):
* **After the cutout** (seeing the element's transparency), by default for effects that move or mix pixels, add light or cast a
  shadow. Each works as its kind needs (`alpha` in the effect's declaration, `docs/plugins.md`):
  * blur, lens blur, motion blur, sharpen, denoise, chromatic, optics, wave warp, turbulence, glitch (`spread`): run on the
    premultiplied picture and on the opacity the same way, so the edge softens or moves with the element and nothing the
    cutout hid comes in;
  * glow, bloom, light rays (`light`): what they add where the element is transparent becomes opacity: the light falls on what
    is below;
  * drop shadow (`own`): falls on what is below;
  * keyer (`key`): its transparency is multiplied with the element's.
* **Before the cutout**, by default for colour effects (grades, looks, LUTs, grain, vignette): the same picture as after it, cheaper.
  The element's edge colours are cleaned and what the cutout hides is filled with the element's own colours before any effect
  runs, so a grade reaches the whole element, its outermost pixels included.
* `--after-cutout` / `--before-cutout` override (on `fx add` and `fx set`); a blur or warp forced before the cutout moves pixels
  inside the element's fixed shape and pulls in the old background at its edge, and light or a shadow forced before it is cut
  away: the command warns.
* Not on an element: the one-pass `stabilize` effect (it would move the picture but not its matte; refused, `studio stabilize
  --clip` steadies the matte with the picture). `slowmo` interpolates the element's matte and edge colours with the picture.
* Effects on the background clip act on the background only.

## Measured
* **Placement, on rendered pixels** (`tests/layers.test.ts`, 320 x 180): a move by whole pixels is exact (0 levels difference
  from the picture moved by hand; the uncovered area is exactly the clip below); a keyframed move from 0 to 100 px over 1 s is
  exactly 50 px at 0.5 s; a quarter turn about the centre: brightness 0.50 levels from the picture turned by hand, colour 4.4
  (colour is kept at half resolution, 4:2:0, and is resampled at colour edges); half size about an anchor: 5 levels at the points
  checked.
* **A shot split into layers** (`tests/layers.test.ts`, a textured object over a panning background, 24 frames): the element moved
  150 px; where it was, the picture is 2.5 levels from the true background (70 levels from the object that was there); where it
  went, 6.1 levels from the object's own pixels. A drop shadow after the cutout darkens what is below by 111 levels where it falls.
* **Ground-truth benchmark** (a real person moving over real footage with people in it, 70 frames 864 x 480,
  `docs/background-removal.md`): the background rebuilt behind him is 19.4 levels from the true background on average where he
  was (24.7 with the previous plate, which took each pixel from whichever of 24 frames agreed most and made a striped patchwork of
  the women behind him). Now each pixel comes from the nearest frame that saw it and seams are blended; the women behind him are
  rebuilt whole, in a pose from a few frames away (that is most of the remaining difference: they move). Built in 30 s instead of
  94 s.
* `bg layers` on that benchmark: 1.5 min (matte cached, background plate built).
* **Every effect on a split shot** (the benchmark: the person moved 220 px, made 0.75 and turned -8 degrees over the rebuilt
  background; 21 effects, each on the element before its cutout, after it, and on the background; stills at 864 x 480, against
  the same frame without the effect):
  * switched off (`fx bypass`), every one of the 61 renders is identical to the picture without it (0 levels);
  * on the element, before or after the cutout, nothing changes more than 40 px away from it; before the cutout nothing changes
    outside it at all; after it the change reaches exactly as far as the effect does: chromatic 5 px, wave warp and turbulence
    8, gaussian blur 11, bloom 16, glow 21, light rays 25, drop shadow 31, glitch 32, optics 40;
  * a gaussian blur after the cutout, against the exact result (the element's premultiplied picture and its opacity each
    blurred, laid over the background): opacity within 0.010, premultiplied colour 2.7 levels apart in the soft edge (the
    blur filter is not exactly Gaussian); none of the hidden background in it;
  * a colour effect (grain, vignette, keyer, lumetri) gives the same picture before and after the cutout (0 levels); an exposure
    change reaches the element's outermost pixel ring fully (before: 69% of it, an outline of ungraded colour);
  * each still 0.8 to 1.1 s (denoise-strong after the cutout 2.8 s: it runs twice, on the picture and on the opacity).
* **Over time** (24 frames, the same shot): with motion blur, glitch, glow or a drop shadow on the element, and with the element
  travelling 300 px and turning 20 degrees while it glows and casts a shadow, the picture away from it equals the background
  alone in every frame (0.6 levels on average: video compression). Slow motion on the element (speed 0.5, `slowmo`): its shape
  now changes on every frame with the interpolated picture (before, every other frame, so the cut lagged the picture by half a
  frame's motion); 12.6 s for the 24 frames.
* **Stills and preview ranges match the full render** for effects that change with time (light sweep, glitch, waves): a still
  at 500, 900 and 1700 ms is as far from the full render's frame as with no effect at all (2.7 to 2.9 levels, the video's
  compression). Before, such an effect started over at the start of the still or range.
* **Hidden background never reaches the element** (`tests/effects-layers.test.ts`: a grey square cut out of magenta or of green,
  over blue): the two differ by 1.5 levels on average around the edge with no effect, 0.6 with a blur after the cutout. The
  edge colours: where the matte is opaque the picture is kept as it is; where it is partly transparent the estimated object
  colour is used, pulled towards the colour just inside the edge the more transparent the pixel is. On the benchmark against the
  true edge colours this is no worse than before (29.2 levels in the edge band either way, dominated by where the matte puts
  the edge); on the square it halves the leftover tint of the hidden colour (4.3 levels apart against 7.0).

**Found and fixed by these tests:** a matte padded to the output's shape (letterbox, pillarbox) was 6% opaque in the bars
(FFmpeg pads grey with TV-range black, 16): a moved element drew faint lines of its frame's edge over the picture, and a strong
effect on it showed as a ghost there (now 0); `light-rays` on an element before its cutout failed to render (its graph does not
end on its output line); glow, bloom and rays after the cutout gave no light around the element; a keyer after the cutout
brought the hidden background back (34% of the pixels near the element changed) and one before it was undone by the cutout;
blurs and warps after the cutout pulled the hidden background into the edge and could not soften or move it; time-driven effects
restarted at the start of a still or range; `slowmo` streams ended a frame or two early (the clip froze at its end).

## Limits (said, not hidden)
* What no frame of the shot ever shows behind an element is spread in from around it and counted (`background.neverVisiblePct`).
  People or things behind an element that move are rebuilt from a nearby moment, so their pose can differ a little at the seam
  (seen on the benchmark as a doubled edge of a pink bow).
* The anchor is fixed where the thing was found; a thing that walks across the shot leaves it behind (keyframe `ax`, `ay`).
* Elements are cut at the matte's quality (`bg check`); a part missing from the matte is missing from the element and stays in
  the background (erased with the rest only if it was in the matte).
* Composition clips (titles) move through their own props, not as layers.
* Effects after the cutout that move pixels run twice (picture and opacity): about 1.1 to 1.5 times the cost; `slowmo` on an
  element interpolates the picture, the matte and the edge colours (about 4 times `slowmo` alone). A still has no neighbouring
  frames: motion blur and slow motion show only over a range.
* Colour is stored at half resolution (4:2:0): at a hard edge between saturated colours the outermost pixel takes some of its
  neighbour's colour.
* The last frame of a preview range with `slowmo` holds (nothing after the range is read).
* Rendering cost: one warp per frame per moved layer (cheap), the clean plate once per shot (about 0.4 s a frame at 864 x 480).
