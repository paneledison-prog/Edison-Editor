# 01 Project and ops

## Ops

An op is `{ id, type, args, actor, ts, inverse }`. Types include: `asset.add`, `track.add`, `track.set`, `clip.add`, `clip.move`, `clip.trim`, `clip.split`, `clip.delete`, `clip.ripple-delete`, `clip.set`, `kf.set`, `kf.delete`, `marker.add`, `export.set`.

- Apply batches with `studio ops apply ops.json`. A batch is **atomic**: all ops validate and apply, or none do.
- `studio project diff <opId>` shows exactly what changed. Use it before reporting.
- `studio project undo [n]` reverts by inverse ops and logs the undo; it never rewrites history.
- UI edits and agent edits share one log. If the log shows a UI edit you did not make, **preserve it** unless the user asked you to revert it.

## Validation (must hold after every op)

- No overlapping clips on the same non-layered track (video/audio/captions); overlaps are allowed only on `graphics` tracks.
- `srcIn + dur` ≤ asset duration (video, audio). Images and comps have no source bound.
- Keyframe times inside clip duration, strictly increasing per property.
- Every referenced asset, comp, and token exists.
- Timeline duration equals the end of the last clip. Never store it separately.
- Rotation metadata and VFR flags from ingest are respected in transforms.

## Editing habits

- Prefer **ripple-delete** over move-and-trim for removing content. It keeps sync across tracks.
- Link audio and video of the same source with a `link` group id so trims stay in sync.
- When cutting, cut video and audio at the same absolute time, then adjust audio joins with a short crossfade.
- Put every piece of on-screen text on a `graphics` or `captions` track, never baked into source video.
- Use markers for anything you will want to find again: clicks, chapters, retakes, QC failures.

## Naming

Tracks: `Screen`, `Camera`, `VO`, `Music`, `SFX`, `Overlays`, `Captions`. Exports: `<project>-<preset>-v<N>.<ext>`. Never name a file `final`. Use versions.
