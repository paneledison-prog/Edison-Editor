# 12 Plugins, expressions, scripts

Full reference: `docs/plugins.md`. This is what to do and what to check.

## Choose the smallest tool

| Task | Use |
|---|---|
| A text or shape animation that exists as a template | edit props (`tl set --patch`, `motion still` to look) |
| A new look that needs drawing code | a plugin `template` (`studio plugins new <id> --kind template`) |
| A picture filter on one clip (glow, grain, vignette) | `studio plugins list`, then `studio plugins apply --clip --effect` |
| A new picture filter | a plugin `effect`: a filter graph with typed params |
| The same sequence of edits again | a script (`studio script list`, `studio script run`) |
| A move that follows a formula (push-in, wiggle, pulse) | `studio expr eval` to check, then `studio expr bake` |

## Rules

- **Check before you trust.** After writing a plugin run `studio plugins check <id>`: an effect is run on a test pattern, a template renders a frame. Then look at a real frame with `studio motion still` or `studio render --still`. A passing check proves it runs, not that it looks right.
- **Size is a budget.** 64 KB per plugin, no dependencies, no binary assets. If you are about to embed an image or a library, stop and use a prop or a simpler effect. Report the size from `studio plugins list`.
- **Template code is a pure function of time.** `update(t)`: no timers, transitions, `Date`, or `Math.random` (use `lib.rand(seed, i)`). The page is offline; a template that loads from the network fails the render. Use `c.u` for sizes and `c.watch` for anything that must stay in the safe area.
- **Effects are validated parameters in a filter graph.** Never build a graph by pasting user text into it; declare a parameter with `min`/`max` or an enum list. Banned filters (`movie`, `sendcmd`, `subtitles`, `drawtext`, `geq`, ...) are refused on load.
- **Scripts change the project only through `api.studio([...])`.** That keeps every change an op that can be undone. Do not write to `project.studio.json` or the ops log from a script. A script file needs `export const meta` and a default export; anything else is ignored.
- **Bake, then look.** `expr bake` writes keyframes in one undoable step. Keep values inside the property's range (it refuses otherwise), then `render --still` at a few times and view them. The renderer animates `scale`, `x`, `y`, `rot`, `opacity` on media clips; anything else fails the render.
- **Trusted code.** Plugin page code and scripts run with the user's permissions. Do not run or write one that downloads, deletes, or executes things outside the project. Tell the user when you add one.

## Report

State the plugin id, kinds, and byte size; what `plugins check` ran; the frames you viewed; and anything not verified (audio, long renders, other canvas sizes).
