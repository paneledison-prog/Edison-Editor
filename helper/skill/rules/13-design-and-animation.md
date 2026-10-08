# 13 Design and animation (the separate design editor)

Reference: `docs/design.md`. The design editor is its own app and file: `design.studio.json`, `studio design ...`, `studio design ui`. It never reads or writes `project.studio.json`. If the task is "make an animated poster, title, logo animation, UI animation, explainer scene", use it; if it is "edit this video / image / audio file", use the media editor.

## Working

- **Build with one atomic batch.** `studio design apply ops.json` with `layer.add` ops (give each layer an explicit id like `l_hero`... ids may use only digits and the letters `a-h j k m n p-t v-z`, 4+ characters after `l_`), then `anim.preset` for the common moves and `kf.set` for exact ones. All or nothing, one undo.
- **Look at it.** After building or changing, render a frame: `studio design render --format png --at <ms> --out renders/x.png` and view it. Do this at the start, a middle moment, and the end of every animation. A passing command proves the file is valid, not that it looks right.
- **Layer order:** later siblings are in front. Children belong to a `frame` or `group` and are positioned inside it.
- **Animation:** a keyframe is a value at a time with an easing to the next one. Use `expo.out` or `spring.out` for entrances, `quad.in` / `expo.in` for exits, `sine.inOut` for loops. Keep entrances 300 to 700 ms. Start the first move at 0 (or a small stagger of 40 to 80 ms per element), leave the end state on screen long enough to read (0.3 s per word).
- **Text:** fonts come from `brand/` (Inter). Check long strings fit their box with a rendered frame; text does not shrink to fit.
- **Transparency:** for an overlay to put on a video, set the background `transparent` (or pass `--alpha`) and export `mov` (ProRes 4444) or `webm`. MP4 and the GIF default have no real alpha (MP4 refuses it).
- **Audio:** an `audio` layer comes from a file under `assets/` (`studio design asset <file>`). Shape it with `volume` keyframes. Only MP4, WebM and MOV carry audio.
- **Assets:** `studio design asset <file...>` copies images and audio into `assets/`; reference them as `assets/<name>`. Never point a layer outside the project. The person cannot add images or audio from the editor (no Image or Audio tool, no upload): you place them.
- **The person edits after you, not while you work.** Pass `--agent <name>` on your writes (or `studio work begin`) so the design editor is view-only for them while you build, and `studio work end` when done. Several designs at once: `rules/15-parallel-workspaces.md`.

## Check before you report

- `studio design validate`, then the rendered frames above. For a video export report frames, size, duration from the render result, and that you viewed frames.
- Say what was not checked: the look in a player other than the one you used, audio levels (measure with `studio inspect loudness`), very long scenes.
- Do not claim features the editor lacks: auto-layout, boolean shapes, masks, 3D, bezier path editing, comments.
