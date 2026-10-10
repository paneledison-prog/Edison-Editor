# Transitions (`studio tl transition`)

How a clip comes in or goes out: a dissolve, a dip through a colour, a wipe, a push, a slide. Set by the agent; every change is an
op (validated, logged, undoable).

```
studio tl transition --between c_a,c_b --kind dissolve --dur 600          # between two clips at a cut
studio tl transition --clip c_b --in push --dir left --dur 500             # the same, named by the clip coming in
studio tl transition --clip c_b --in wipe --dir right --feather 40         # a soft-edged wipe, left to right
studio tl transition --clip c_b --in dip --color #ffffff --dur 800         # through white
studio tl transition --clip c_title --in dissolve --dur 300                # a layer fading in over what is below it
studio tl transition --clip c_last --out dip --dur 1000                    # the end, to black
studio tl transition --clip c_b --remove                                   # gone (project undo brings it back)
studio render --still MS / --range A:B --preview                           # look at it
```

## What it does
* **Between two clips.** A clip's `--in` where it follows another clip on the same track with no gap is a transition between the
  two, **centred on the cut**: for its duration both are on screen, the clip before playing on past its out point and this one
  starting before its in point, **each from its own file**. Nothing is frozen to fill: where a file has less to spare, the
  transition moves off centre to use what the other has, or is shortened, and the command says so (`warnings`, and
  `mediaToSpareMs` in the answer). Leave media around a cut (trim a little) for a full transition.
* **One clip alone.** `--in` on a clip with no clip right before it, and `--out`, act on that clip only, over whatever is below it:
  a title, a cut-out element or a picture-in-picture fades, wipes or slides in and out over the tracks below. A clip's `--out`
  where the next clip has an `--in` is not used (that cut has its transition).
* The **audio is not touched**: the clips keep their own sound and their own cut (use `audio` fades for sound).
* The answer says which clips it is between, the `window` it runs in on the timeline, and what each clip had to spare.

| kind | between two clips | one clip alone |
|---|---|---|
| `dissolve` (`fade`) | the incoming clip fades in over the outgoing one | fades in from / out to what is below |
| `dip` | the outgoing clip turns to `--color` (first half), the incoming one comes out of it (second half) | from / to the colour |
| `wipe` | an edge moving the way of `--dir` uncovers the incoming clip; `--feather` px softens it | uncovers / covers the clip |
| `push` | the incoming clip pushes the outgoing one off screen, the way of `--dir` | slides in / out |
| `slide` | the incoming clip slides in over the outgoing one, which stays | slides in / out |

`--dur` ms (default 500); `--ease` any easing name (default linear for dissolve and dip, `sine.inOut` for the rest); `--dir` left,
right, up, down (default left): the way the edge or the picture moves.

## How it renders
Each transition is a change over time to one clip's own finished picture, after its placement (`docs/layers.md`): its opacity
(dissolve), a moving mask (wipe), a colour mixed in with its own transparency kept (dip), or where it sits on screen (push, slide).
So it works the same on a full-frame clip and on a cut-out element. For a transition between two clips, the render lengthens the
outgoing clip after its out point and starts the incoming one before its in point (their effects, keyframes and mattes follow), and
the incoming clip is drawn over the outgoing one.

## Measured
`tests/transitions.test.ts` (a red clip then a blue one, 320 x 180 at 25 fps, cut at 1000 ms, transitions of 400 ms, linear):
* dissolve, centred on the cut (800 to 1200 ms): share of the blue clip 0.00 at 760 ms, 0.25 at 900, 0.50 at 1000, 0.75 at 1100,
  1.00 at 1240;
* dip to black: black at the cut; at 900 ms the red at half, at 1100 ms the blue at half;
* wipe right, push left, slide up: the edge, or the incoming clip's edge, at the middle of the frame at the cut;
* past its out point the outgoing clip is its own file: 0.0 levels from its file at 1000 ms, 4.5 from its last frame before the
  cut; a preview range through the transition gives at the cut the frame a still gives (5.6 levels, the video's compression;
  4.2 on a plain frame; the frames before and after it 30 and 7.5);
* no media before the incoming clip's in point: the dissolve runs from the cut on (1000 to 1400 ms) and says why;
* a green clip on an upper track fades in over the red (half and half at 600 ms) and out over the blue;
* the full render is as long as the timeline, picture and sound (2.000 s each).

The user's clips a, b, c, d (848 x 480, 1140 x 480, 854 x 480, 864 x 480, with sound) in a row in an 864 x 480 project, with a
dissolve, a push left, a wipe right with a 40 px feather (500 ms each) and a dip to black at the end, rendered whole (5.7 s,
picture and sound 5.700 s each, 4.0 s to render), looked at on a sheet of 5 moments per transition. Away from the transitions the
picture is the same as with plain cuts (1.1 levels on average, 2.0 at worst: the video's compression).

A cut-out element of the benchmark shot (`docs/layers.md`: the person moved and turned over the rebuilt background) dissolving in
over 600 ms and wiping out to the right with a 30 px feather: half way into the dissolve he is at 0.497 opacity where he was
opaque, and nothing outside him changes (0.013 at most, at his edge); during the wipe the part of him the edge has passed is gone
and the rest is whole; the background is untouched where he is not.

Fixed while testing: a clip whose in point falls between two frames of its file was started on the next frame (its first frame
was taken as its in point), so the incoming clip of a transition was a frame late (27.7 levels off right after a dissolve); every
clip now shows at each moment the frame its file has at that moment. A still or preview range starting inside a transition drew
the incoming clip under the outgoing one (both were cut to start together); clips keep their timeline order.

## Limits
* Kinds: dissolve, dip, wipe (straight edge), push, slide. No iris, zoom, morph or 3D transitions.
* Transitions are between clips on the same track that meet with no gap; across tracks, use `--in` / `--out` on the upper clip.
* A composition clip (a title template) animates itself; transitions are for media clips.
* The audio is not crossfaded by a video transition.
