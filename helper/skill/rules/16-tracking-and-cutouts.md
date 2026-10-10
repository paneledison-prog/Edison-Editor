# Tracking, stabilization, pins, 3D cameras and cut-outs

Read `docs/tracking.md` and `docs/cutouts.md`. These are agent-only tools: the person cannot add them from the editor, and cannot edit while you hold the workspace.

Rules
* Effects (`stabilize`, `pin`, `cutout`, plugin effects) are entries on the clip. Never bake them into the source. Change with `studio fx set`, compare with `studio fx bypass`, undo with `studio project undo`.
* Always look: `studio track preview`, `studio matte preview`, `studio render --still`. Report numbers from commands (`lost`, `reprojectionRmsPx`, `agreementAtMarkedFrames`, `checkThese`), and say "not run" for anything you did not run.
* Stabilize shaky footage: `studio stabilize --clip C`; if a big moving subject fights it, give `--box` on the background. Check the `plan` (zoom, correctionKept); raise `--max-zoom` if the correction was cut back.
* Pin: give a tracker or a box/quad of the plane at a reference frame; check with `track preview` that the region stays on the plane before trusting the pin.
* 3D: `studio track solve` needs a camera that moves through space. If it refuses, use a homography tracker. Give `--focal-deg --fix-focal` when the lens is known.
* Cut-outs: mark, preview, mark more where it drifts. The default engine (`--engine auto`) lets the u2net model guide the cut-out of people and other prominent objects; your marks pick the object, and a `--fg` stroke keeps a part the model skipped (antenna, pale thin parts). `--engine colour` is marks and colours only. For similar colours without the model draw `--outline`. Read `stats.engine` / `engineNote` in the matte data. Things passing in front need their own marks (`--bg-fill`).
* Heavy commands (track, solve, matte, stabilize, pin, cutout) go through the job governor; use `--project` and `--agent` as in rule 15.
* Limits to state in a report: synthetic-footage evidence only, planar camera model for stabilization, focal estimate can be a few percent off, mattes are soft-band alpha.

## Removing a video's background (`studio bg`) — the default for "remove the background" / "keep only the person"
Read `docs/background-removal.md`.
* `studio bg subjects --asset a_xx` first, then LOOK at both sheets it writes (`renders/subjects-<run>.png` numbered, `...-each.png` each thing alone). Choose by what you see, not by the JSON alone: a mask may hold only a face (`partOf`), or two things joined. Use the facts to decide (`moves`, `salience`, `areaPct`, `colour`, `touchesEdge`).
* `studio bg remove --run sub_x --keep N --clip c_xx`. Several things: `--keep 3,7`. The same thing in two shots or moments, or two parts of one thing: `--keep 3+15`. Things that must go even where they touch what is kept: `--remove 5`. Not in the picture before/after a time: `--visible-from MS` / `--visible-until MS`. A clip with cuts needs a subject in every shot (the run lists one moment per shot).
* Read `result.quality` and `needsALook`, look at `preview`, then `studio bg check mt_x` before rendering. Fix with `mask key ... --neg/--point --add`, `--absent`, `matte edge --hair`. Render a still over a coloured track below to see the edges.
* Report the numbers (`consensusPct`, `fallbackFrames`, frames looked at) and say which frames you did not look at.

## Object Mask Tool (`studio mask`)
* To cut out or remove one specific object (a person, a phone, a bottle, a logo), select it by pointing: `studio mask pick --asset a_xx --at MS --point "x,y" --neg "x,y" --box x,y,w,h` shows the segmenter's three candidates on one frame and stores nothing; then `studio mask add` with the same marks, `studio mask preview`, and `studio mask key ... --add` where it drifts or includes the wrong thing. Prefer a box plus one or two points; several far-apart positive points confuse the model.
* Use the result like any matte: `studio cutout --clip c_xx --matte mt_xxxx [--invert]`, or `fx ... --matte`.
* Look at every result: the candidate the model rates highest is not always right, hair and thin parts are soft, the model is weak on flat synthetic or cartoon objects. Details and measured numbers: `docs/masks.md`.
* To take an object out of a video: select it (`mask pick`, `mask add`; look at `mask preview` over the whole range, cut the range to where it is visible, add `mask key ... --neg` where it latches onto a neighbour), then `studio erase --clip c_xx --matte mt_xxxx` and look at `studio erase preview`. It rebuilds the background from other frames of the shot (real pixels, nothing invented); read `plate.neverVisiblePct`: what no frame shows is only smeared in. For hair and fine edges: `studio matte edge mt_xxxx --edge-model vitmatte --hair` (needs `studio models fetch vitmatte-small`). Details and measured numbers: `docs/masks.md`.
* If a matte sits on the wrong thing before the object shows up or while it is hidden (a neighbour of the same colour), look at `checkThese` and `mask preview`, then mark the time where it is not there: `studio mask key mt_xxxx --at MS --absent` (close to where it disappears or appears), and mark it again (`--point --box --neg`) where it is back.
