# Plugins, expressions and scripts

Studio is extended by three small things. None needs an install step, a package manager, or the network.

| You want to add | Write a | It becomes |
|---|---|---|
| a motion template (animated text, shapes, particles, light) | plugin `template` | `studio motion ...` and `tl add-clip --comp <id>` |
| a video effect (glow, grain, a colour trick) | plugin `effect` | `studio plugins apply --effect <id>`, an ordinary `fx` on a clip |
| repeatable automation | `script` (in a plugin, in `studio-scripts/`, or in the project's `scripts/`) | `studio script run <name>` |
| animation from a formula | an expression | `studio expr bake`, or `lib.expr(...)` inside a template |

Everything a plugin adds is also an MCP tool for Claude Code, because the MCP server is generated from the command list.

## Size is a budget, not a hope

* A plugin folder may hold at most **64 KB**. A bigger one is refused with the size, not loaded.
* No `node_modules`, no dependencies, no binary assets. Images go in as props (a `data:` URL).
* Shipped today: `glow` 2.4 KB, `shapes` 6.1 KB, `light-fx` 11.9 KB, `logo-reveal` 4.7 KB (about 25 KB together).
* Plugin code runs only when something uses it. An effect costs one filter graph in the render; a template costs one
  Chromium render, cached by content hash (the plugin's hash is part of the cache key).

## Where plugins live

`<studio>/plugins/<id>/` (shipped) and `<project>/plugins/<id>/` (yours). The folder name must equal the plugin id. A plugin cannot
replace a built-in template, and two plugins cannot claim the same id; the second is reported by `studio plugins list` under `problems`.

```
studio plugins new my-glow --kind effect      # or: template, script
studio plugins check my-glow                  # validates, runs the effect on a test pattern / renders a frame
studio plugins apply --clip c_01 --effect my-glow --params '{"amount":0.6}'
```

## plugin.json

```json
{
  "api": 1, "id": "my-plugin", "name": "My plugin", "version": "1.0.0",
  "summary": "one line", "license": "MIT",
  "page": "page.js",
  "templates": [ { "id": "my-title", "summary": "...", "kind": "overlay", "defaultDurMs": 3000, "props": { ... } } ],
  "effects":   [ { "id": "my-glow", "summary": "...", "params": { ... }, "graph": "[in]...[out]" } ],
  "scripts":   [ { "name": "my-script", "summary": "...", "file": "my-script.mjs" } ]
}
```

Unknown fields are errors. `studio plugins list` prints every loaded plugin with its props and parameters.

### Templates

`props` use the same types as the built-in templates (`string number color ease boolean enum box list`), with the same
limits and the same defaults. Colours accept `token:<name>` from `brand/palette.json` or `#RRGGBB(AA)`. Unknown or ill-typed props fail the render.
Include `entranceMs`, `exitMs`, `ease`, `exitEase` if you use `lib.life`.

`page.js` registers a drawing function. It runs in the motion renderer's headless Chromium, once per render:

```js
register('my-title', (c, lib) => {
  const el = lib.h('div', { left: '0', top: '0', width: c.W + 'px', height: c.H + 'px',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: c.p.color, font: `700 ${88 * c.u}px "${c.family}"` }, c.p.text, c.root);
  return { update(t) { el.style.opacity = String(lib.life(c, t).a); } };   // t in ms
});
```

* `c`: `root, W, H, u` (1 at 1080 px on the short side: size things with it), `fps, durMs, p` (resolved props), `family` (brand font), `safe` (safe-area margins), `watch(el, label, 'safe'|'frame')` (warn if the element leaves the area), `warn(msg)`.
* `lib`: `h` (make an absolutely positioned element), `px`, `fit`, `life(c,t)` (`{inP,outP,a}` from the entrance/exit props), `ease(name)(x)`, `ramp(t, start, dur, ease)`, `noise(x, seed)`, `rand(seed, i)`, `expr(src)` (see below), `canvas(c)` (a full-frame 2D canvas).
* **`update(t)` must be a pure function of `t`.** No timers, no CSS transitions, no `Math.random`, no `Date`. The renderer calls it once per frame and screenshots; a plugin that breaks this renders differently each run, and the cache would be wrong. Use `lib.rand(seed, i)` for anything random.
* The page has no network access to rely on; do not fetch.

### Effects

`graph` is an FFmpeg filter graph that reads `[in]` and writes `[out]`. `{name}` is replaced by a **validated** parameter (numbers within `min..max`, enum values from the list, booleans as 0/1), so a parameter can never inject filter syntax. Other labels are renamed per clip so two clips never collide.
The loader refuses a graph that has a character outside a small safe set, no `[in]` or `[out]`, an undeclared `{param}`, or any filter that reads files or runs code (`movie`, `amovie`, `sendcmd`, `subtitles`, `drawtext`, `lut3d`, `geq`, `frei0r`, `ladspa`, `lv2`, ...).
`studio plugins check` really runs the graph on a test pattern. The effect is applied after the clip's own scale/crop/zoom/blur and before its position on the timeline.

`alpha` says what the effect does with a picture that has transparency (on a cut-out element, after its cutout: `docs/layers.md`):

| `alpha` | the effect | on a cut-out element |
|---|---|---|
| `keep` (default) | changes colours pixel by pixel (grades, looks, grain, vignette) | acts inside the element's shape; same picture before or after the cutout |
| `spread` | moves or mixes pixels (blur, warp, glitch, sharpen, denoise) | run on the premultiplied picture and on the opacity the same way: the edge softens or moves with the element, nothing hidden comes in |
| `light` | adds light (glow, bloom, rays) | what it adds on transparent parts becomes opacity, so it falls on what is below |
| `own` | makes its transparency from the one it gets (drop shadow); the graph ends in a format with alpha | used as it is |
| `key` | makes transparency from colours (keyer) | multiplied with the element's |
| `frame` | follows the whole picture's motion (one-pass stabilizer) | refused: the element's matte would not move with it |

Without `alpha`, a graph that ends in a format with alpha (`format=yuva420p[out]`, `rgba`, ...) counts as `own`, any other as `keep`.
A graph may end with lines after the one that writes `[out]` (a `nullsink` for an unused branch): the line that writes `[out]`
is moved last, since the steps after an effect continue from the clip's last line.

### Scripts

A script is an ES module (`.mjs`) that declares `meta` and a default export. A file without both is **not** a script and is never imported (so `studio script list` cannot run a build script that happens to sit in the folder).

```js
export const meta = { summary: 'Marks a clip', args: { clip: { type: 'string', required: true, desc: 'clip id' } } };
export default async function run(api) {            // api.args, api.project (fresh read), api.studio(argv), api.expr(src, vars), api.log
  await api.studio(['tl', 'marker', '--t', '0', '--label', api.args.clip]);
  return { done: true };
}
```

A script changes the project **only** through `api.studio([...])`, which runs a real `studio` command, so every change is validated, logged, and undoable. Unknown or missing arguments fail before anything runs.
Scripts are local code you chose to run, with your user's permissions, like any shell script; Studio does not sandbox them. Shipped: `zoom-punch`, `wiggle-zoom`, `intro-outro` (in `studio-scripts/`).

## Expressions

A formula such as `1 + 0.2 * smooth(0, 1, p) + 0.01 * wiggle(3, 1)`. It is parsed and evaluated by Studio's own small evaluator: no `eval`, no property access, no loops, no I/O, at most 400 characters and 24 levels of nesting. The same input always gives the same number.

* Variables: `t` (seconds), `f` (frame), `dur` (seconds), `p` (progress 0..1), `pi tau e`.
* Functions: `sin cos tan abs sqrt floor ceil round min max pow mod clamp lerp smooth step pingpong noise wiggle`, and every easing as `<family>_<in|out|inOut>(x)` (e.g. `expo_out(p)`, `cubic_inOut(p)`).
* `wiggle(freq, amp, seed)` is smooth seeded noise; `1/0` is 0, never infinity.

```
studio expr eval --expr "1 + 0.2 * expo_out(p)" --at 0,0.5,1      # check it first
studio expr bake --clip c_01 --prop scale --expr "clamp(1 + 0.2 * p + 0.006 * wiggle(2.5, 1), 1, 8)" --from 0 --to 4000 --step 200
```

`bake` samples the formula (at most 240 keyframes, at least 40 ms apart) and writes keyframes in **one undoable step**, so what you see on the timeline and in the graph editor is exactly what renders. A value outside the property's range is refused with the range.

## What the renderer animates on media clips

`scale` (1 to 8), `x`, `y` (focus, 0 to 1), `rot` (degrees, clockwise, corners transparent), `opacity` (0 to 1). Any other keyframed property fails the render with the list above rather than being ignored.

## Limits, stated plainly

* Plugin page code and scripts are trusted local code. The checks above stop mistakes (a bad graph, an unsafe filter, a runaway formula), not a hostile plugin. Do not install plugins you have not read.
* The shipped light plugins (particles, saber, lens flare) are 2D canvas effects, not physical simulations; there is no 3D engine and none is planned, as it would break the size budget. Extruded or tilted text could be a template using CSS 3D transforms; it is not built.
* A plugin effect is a picture filter for one clip. It cannot read another clip or the audio.
