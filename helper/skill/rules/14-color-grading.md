# 14 Colour grading and look (the built-in `color` plugin)

Reference: `docs/color.md`. A grade is a stack of nodes on a clip; you work it with `studio color ...`.

## Working

1. **Measure first.** `studio color analyze --clip C --at MS` (notes in plain words) and `studio color scopes --clip C --at MS`; view the sheet. Do this on a representative frame, then at least one dark and one bright moment.
2. **Correct before you stylize.** Order: exposure and contrast (`lumetri`), balance (temperature, tint; or `primary` for lift/gamma/gain), colour fixes (`hue-sat`, `qualifier`, `window`), then the look (`tritone`, `film-look`, `glow`, `vignette`, `grain`). LUTs run first, so use `studio color lut` for a camera conversion and nodes for the rest.
3. **Start from `auto`, then judge.** `studio color auto` is a measured starting point and reports before and after; if it warns it made the frame worse, undo it and grade by hand. `studio color match --ref` brings one shot toward another (per-channel mean and spread only: skin tones and specific colours still need eyes).
4. **One idea per node.** Name nothing, just keep the stack readable: `studio color stack` shows it. Use `bypass` to compare, `set` to adjust, `save` / `apply` to reuse across clips.
5. **Look at the result** with `studio render --still MS` (or `studio color still` for an image) and view it next to the original. Check skin, a neutral grey, the darkest and brightest areas. Re-run `analyze`: clipping should not go up.
6. **Heavy effects are labelled** (`studio color effects`): `denoise-strong` and `slowmo` cost seconds per second of video. Use them on short, specific clips, and say so.

## Rules

- Do not claim AI features: there is no Magic Mask, Roto Brush, depth map, face refinement or relight, and windows and qualifiers do not track.
- Colour nodes drop transparency; put `keyer` and `drop-shadow` last.
- `slowmo` only helps when the clip speed is below 1 (`studio video speed`).
- Numbers from `analyze` are on encoded values of a 160x90 copy: they guide, they do not replace looking at the frame.

## Report

The nodes you set (effect and key parameters), the before and after numbers from `analyze` (median luma, spread, clipping, cast), the frames you viewed, and what you did not check (other moments of the clip, skin tones, a calibrated display, long renders).
