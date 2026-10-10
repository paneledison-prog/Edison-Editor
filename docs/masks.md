# Object Mask Tool (`studio mask ...`)

Select an object in a video by pointing at it, the way Premiere's Object Mask Tool does: points on the object, points on what must not be included, or a box. The promptable segmenter (Segment Anything 2.1 tiny, Apache-2.0, ONNX, CPU) finds exactly that object, whatever it is (a person, a phone, a bottle, a logo); Studio then follows it through the shot and decides the boundary against the picture's edges. It is the same machinery as `studio matte` (same entity, same `cutout`, same matte-limited effects, same undo): `mask add` is `matte add --engine sam` with clicks instead of strokes. No generative AI.

## Workflow
1. Look at a frame (`studio inspect frame`), pick points. Coordinates are fractions of the frame (or pixels with `--px`).
2. **Try it on one frame, nothing stored:** `studio mask pick --asset a_xx --at 0 --point "0.62,0.4" --neg "0.8,0.8" --box 0.1,0,0.85,1`. One picture: the frame and the segmenter's three candidates, with your points drawn; the JSON says which one `auto` takes and whether each keeps your points inside/outside. Correct the points until a candidate is the object.
3. `studio mask add --asset a_xx --at 0 --point ... --neg ... --box ...` builds it (frames are encoded once, then cached) and `studio mask preview mt_xxxx` shows contact sheets.
4. Where it drifts or leaks: `studio mask key mt_xxxx --at MS --point ... --neg ... --add`. The mask is followed from each marked frame to the next, from both sides.
5. Use it: `studio cutout --clip c_xx --matte mt_xxxx` (everything else transparent; `--invert` to remove just that object's area), or `studio fx add ... --matte mt_xxxx` to limit any effect to it.

`--pick auto|whole|best|first` chooses among the segmenter's three candidates (auto keeps your points where you asked, prefers the whole object, and penalises a candidate that spills far outside a box).

## Measured here (this machine: 4 CPU cores, no GPU; clips are the three real ones)
* **Speed:** encoding a frame 0.8 to 2.0 s (int8 encoder, 1024 x 1024 input; fp32 2.0 to 2.3 s, with no visible difference in the masks); a prompt on an encoded frame 50 to 100 ms. A 45-frame matte took 58 s the first time; encodings are cached under `.studio/cache/matte/sam-*` (about 8 MB per frame), so changing points costs only the decode and the follow.
* **Selection:** on clip c (854 x 480), one point on the antenna selects the antenna and the upper part of the phone alone (the part u2net dropped); a box with one point on the face and a point on the phone selects the man and his hand without the phone at the marked frame (view: `renders/matte-mt_crrj.png`); with several positive points in disjoint places and badly placed negatives the candidates were poor, so prefer a box plus one or two points.
* **Following:** the antenna mask followed cleanly through the 1.5 s. The man-without-phone mask held, but the lower phone leaked back into the mask in the last frames: mark a second frame with `--neg` on the phone (`mask key ... --add`).
* **Synthetic shot** (flat, textured blob on a panning background, fast motion): the first frame IoU 0.44, mean over 12 frames 0.69. The model is trained on natural pictures and does poorly on this kind of cartoon object; `tests/mask.test.ts` asserts only that the tool runs and the mask is as steady as the truth, not that it is accurate.

## Limits (not hidden)
* The segmenter's mask is predicted at a quarter of the resolution and is blocky and speckled near thin parts; Studio fills small holes and snaps the boundary to image edges in a thin band, which is not a hair-level matte. Hair, motion blur, glass and translucent edges are soft or wrong.
* SAM's own quality number is a hint: on clip c the candidate it rated highest was not the best one; use `mask pick` and look.
* Thin or low-contrast objects can need several points. Objects that leave and re-enter, or a second similar object next to the first, need marks at those frames.
* Following asks the segmenter on every frame with points moved by optical flow; where the flow is wrong the colour-and-flow method takes over for that frame (see `docs/cutouts.md`). A cut ends the following; each shot needs its own marked frame.
* Built, tested on three real clips and one synthetic shot only. Not built yet from the plan: the edge engine (full-resolution band matting and colour decontamination), flicker measurement and smoothing, remove-object by clean plate, multi-object algebra, automatic proposals, image masks, UI panel. Say "not built" for those.

## Setup
`studio models fetch sam2.1-tiny` (about 74 MB: int8 encoder 53 MB, fp32 prompt encoder and mask decoder 21 MB; sha256 pinned to a Hugging Face revision), `python3 -m pip install -r tools/requirements.txt` (onnxruntime, numpy, pillow). `studio doctor` lists the model state.

## The hair matting model (`--edge-model vitmatte`)
`studio matte edge mt_xxxx --edge-model vitmatte --hair` (or `mask add ... --edge-model vitmatte --hair`): after the matte is followed and steadied, the opacity in a band around its boundary is decided by ViTMatte (small, Distinctions-646, Apache-2.0, 104 MB, `studio models fetch vitmatte-small`), a trained matting model that takes the picture and a trimap (sure inside, sure outside, and an unknown band 1.5% of the width wide, 3% with `--hair`). Only the band is sent through the model, in one crop. The model's opacity is steadied over time again at the finished size, along the same motion. It is off by default: about 1.5 s a frame at 848 x 480 here (the 45-frame build of clip a took 2 min).
* **Measured on composites with known opacity** (hair-like strands over a background of similar brightness, same trimap for both, 640 x 360): error of the opacity in the edge band 0.165 for the guided filter, 0.038 for ViTMatte; the opacity recovered in the band (truth = 1.00) 0.80 against 1.00. 544 ms a frame at that size. These composites are clean and well lit, so this is a best case for the model, not a promise for real hair.
* **On the real clips** the difference is visible at a zoom of two to four and subtle at normal size: on clip a (short grey hair at the temple) the edge is softer and carries semi-transparent wisps where the guided filter's is crisper. There is no truth for real footage, so I cannot say which one is closer; judge the contact sheets and the cutout over your own background.
* **Limits:** the unknown band must contain the true edge (a trimap too narrow cannot be corrected by the model; `--hair` widens it); the model is slower and a little greener on dark hair against a light background than a plain mask; it does nothing for what the mask missed altogether.
