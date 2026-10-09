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
