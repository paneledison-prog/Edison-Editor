# 11 UI design system

One system. One token file. **Two themes only: `light` and `dark`.** No third theme, no high-contrast variant, no per-feature palettes.

## Direction

Studio is a dense, calm, tool-first interface. Layout follows the professional timeline editors it takes cues from: top bar, left tool rail, asset browser, central canvas, right inspector, bottom timeline with transport. The interface stays quiet so the media is the loudest thing on screen.

- **Purple** is the identity: selection, keyframes, focus, active tool.
- **One strong action color** (lime in dark, solid purple in light) is reserved for the single primary action in a view, usually "Export" or "Render preview". It never appears twice in one view.
- Track colors encode media type. They are the only multi-hue element.
- Structure comes from surface steps and 1 px borders, not shadows or gradients.

## Source of truth: `apps/ui/src/tokens.css`

Components use `var(--token)` only. **No hex, `rgb()`, or `hsl()` literal appears anywhere else.** A CI script (`pnpm tokens:check`) enforces it.

```css
:root {
  /* shared, theme-independent */
  --space-0: 0;     --space-1: 4px;  --space-2: 8px;  --space-3: 12px;
  --space-4: 16px;  --space-5: 20px; --space-6: 24px; --space-8: 32px;

  --radius-sm: 4px;   /* clips, chips, keyframe handles */
  --radius-md: 8px;   /* buttons, inputs */
  --radius-lg: 12px;  /* panels, popovers, dialogs */
  --radius-full: 999px;

  --font-ui: "Geist", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --text-xs: 11px;  --text-sm: 12px; --text-md: 13px; --text-lg: 14px; --text-xl: 16px; --text-2xl: 20px;
  --leading-tight: 1.25; --leading-normal: 1.45;
  --weight-regular: 400; --weight-medium: 500; --weight-semibold: 600;

  --control-sm: 24px; --control-md: 28px; --control-lg: 32px;
  --track-h: 40px; --track-h-collapsed: 28px; --ruler-h: 24px;
  --rail-w: 48px; --panel-w: 280px; --inspector-w: 280px;

  --dur-fast: 100ms; --dur-base: 160ms; --dur-slow: 240ms;
  --ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);

  --z-timeline: 10; --z-popover: 100; --z-dialog: 200; --z-toast: 300;
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --color-bg-canvas: #141416;      /* behind the artboard */
  --color-bg-surface: #1c1c1f;     /* panels */
  --color-bg-raised: #26262a;      /* inputs, popovers */
  --color-bg-hover: #2f2f34;
  --color-border: #34343a;
  --color-border-strong: #4a4a52;
  --color-text-primary: #ececef;
  --color-text-secondary: #b4b4bc;
  --color-text-muted: #8d8d96;
  --color-accent: #9b6bff;
  --color-accent-subtle: rgb(155 107 255 / 0.18);
  --color-action: #c6f94f;
  --color-on-action: #14150a;
  --color-danger: #ff6b6b;
  --color-success: #5bd38a;
  --color-warning: #f5b94a;
  --color-playhead: #ececef;

  --track-video-bg: #7c4deb;    --track-video-fg: #ffffff;
  --track-audio-bg: #6fb2f2;    --track-audio-fg: #0a1928;
  --track-image-bg: #3fc5a8;    --track-image-fg: #05231d;
  --track-graphics-bg: #f2c230; --track-graphics-fg: #251c00;
  --track-captions-bg: #f08ab4; --track-captions-fg: #2a0a18;
  --track-comp-bg: #ff8a4c;     --track-comp-fg: #2b1100;
  --track-effect-bg: #a3a3ad;   --track-effect-fg: #111113;

  --shadow-popover: 0 8px 24px rgb(0 0 0 / 0.45);
}

:root[data-theme="light"] {
  color-scheme: light;
  --color-bg-canvas: #ededf0;
  --color-bg-surface: #ffffff;
  --color-bg-raised: #f5f5f7;
  --color-bg-hover: #eaeaee;
  --color-border: #dadae0;
  --color-border-strong: #bdbdc7;
  --color-text-primary: #17171a;
  --color-text-secondary: #4a4a55;
  --color-text-muted: #6b6b76;
  --color-accent: #6d3af2;
  --color-accent-subtle: rgb(109 58 242 / 0.12);
  --color-action: #6d3af2;
  --color-on-action: #ffffff;
  --color-danger: #c62828;
  --color-success: #1b7f46;
  --color-warning: #8a5a00;
  --color-playhead: #17171a;

  --track-video-bg: #6d3af2;    --track-video-fg: #ffffff;
  --track-audio-bg: #8ec5ff;    --track-audio-fg: #0b2540;
  --track-image-bg: #6fd9bf;    --track-image-fg: #06302a;
  --track-graphics-bg: #ffd25e; --track-graphics-fg: #3a2a00;
  --track-captions-bg: #ffa9cb; --track-captions-fg: #3a0f22;
  --track-comp-bg: #ffb07a;     --track-comp-fg: #3b1a05;
  --track-effect-bg: #c9c9d1;   --track-effect-fg: #1a1a1e;

  --shadow-popover: 0 8px 24px rgb(20 20 30 / 0.16);
}

@media (prefers-reduced-motion: reduce) {
  :root { --dur-fast: 0ms; --dur-base: 0ms; --dur-slow: 0ms; }
}
```

The values above are a starting point chosen by eye. **Verify them with the script before trusting them.** If a pair fails, change the value, not the threshold.

## Theme behavior

- Selector: `:root[data-theme="dark"|"light"]`. Default from `prefers-color-scheme`. A user toggle persists the choice (localStorage is fine in the real app).
- A tiny inline script in `<head>` sets `data-theme` before first paint, so there is no flash.
- Switching themes changes nothing but token values. Layout, spacing, and type are identical.
- Media content (video frames, images, the artboard fill) is never themed.

## `pnpm tokens:check` must verify

1. No color literal (`#`, `rgb(`, `hsl(`, `oklch(`) outside `tokens.css`.
2. Every `--color-*` and `--track-*` token exists in **both** themes, with the same names.
3. No selector other than `light` and `dark` defines theme tokens.
4. Contrast: `text-primary`, `text-secondary`, `text-muted` on `bg-surface`, `bg-raised`, `bg-canvas` ≥ 4.5:1. `on-action` on `action` ≥ 4.5:1. Each `track-*-fg` on its `track-*-bg` ≥ 4.5:1. `accent`, `border-strong`, `playhead` against adjacent surfaces ≥ 3:1.
5. Output a table of every measured ratio.

## Type

One UI family (Geist Sans, OFL) and one mono (Geist Mono) used for timecodes, frame counts, and numeric fields only. Both bundled as latin subsets, `font-display: swap`, falling back to the system stack. If the subsets cost more than 60 KB gzipped together, drop to the system stack and say so.
Base UI size 13 px, labels 12 px, timeline text 11 px. Tabular numerals on all numbers that change.
Sentence case everywhere. No all-caps labels, no eyebrow labels above panels, no decorative type.

## Layout

```
┌───────────────────────────────────────────────────────────────┐
│ top bar: project · undo/redo · theme · Export (action)        │
├────┬──────────────┬─────────────────────────────┬─────────────┤
│rail│ asset browser│ canvas + artboard           │ inspector   │
│ 48 │ folders/files│  (Approximate preview badge)│ transform   │
│    │ 12 items     │                             │ fill/stroke │
│    │              │                             │ grid/export │
├────┴──────────────┴─────────────────────────────┴─────────────┤
│ transport: ⏮ ▶ ⟲ ● timecode      easings · snap · zoom · fit │
│ ruler ─────────────────────────────────────────────────────── │
│ video   ▭▭▭▭▭▭▭▭▭▭    audio ▭▭▭▭ waveform   graphics ▭▭       │
│  ▸ keyframe rows: opacity · rotation · scale · position       │
└───────────────────────────────────────────────────────────────┘
```

Panels are resizable and collapsible, sizes persisted. The timeline can collapse to the transport bar.

## Components (build once, token-only)

Button (action, secondary, ghost), IconButton, Switch, Checkbox, Select, NumberField (drag-to-scrub, tabular numerals), Slider, Tabs, Menu, Popover, Tooltip, Dialog, Toast, PanelHeader, ListRow (asset), TrackHeader (collapse, mute, hide, lock), Clip (type color, label, waveform or thumbnail strip), Ruler, Playhead, KeyframeDiamond (filled when on a keyframe, outlined otherwise), EasingPopover (list on the left, curve preview on the right, "Save curve" and "Open graph editor"), SnapMenu (grid, playhead, keyframes and layers).

## Interaction rules

- Selection and focus use `--color-accent`. Focus ring: 2 px, offset 1 px, always visible on keyboard focus.
- Minimum interactive target 24×24 px. Dense but not cramped.
- Hover and press states use `--color-bg-hover` and 1-step surface changes, no scale animations.
- Motion answers an action (open popover, drag, snap) and takes `--dur-fast` or `--dur-base`. No decorative or idle animation. Respect reduced motion.
- Timeline drags use CSS transforms, then commit an op on release. Never write to the project on every pointer move.
- Everything is reachable by keyboard, with visible shortcuts in tooltips and menus.
- Icons: one set (Lucide, ISC license), 16 px grid, 1.5 px stroke, imported individually as inline SVG. No emoji, no mixed icon styles.

## Copy

Sentence case, plain verbs. Actions keep their name through the flow: "Render preview" then "Preview rendered". Errors say what happened and how to fix it, no apologies. Empty states say what to do next. Labels use the user's words ("Silence cutting", not "VAD pipeline").

## Don't

No gradients as decoration. No glassmorphism. No cards-in-cards. No third theme. No hard-coded colors. No shadows except `--shadow-popover`. No lime anywhere but the single action. No motion on idle.
