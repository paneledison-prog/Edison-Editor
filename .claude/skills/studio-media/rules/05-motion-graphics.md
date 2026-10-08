# 05 Motion graphics (in-house Chromium renderer)

> Remotion was rejected for licensing (see `docs/licenses.md`). Templates are HTML/CSS/TS in `motion/src/`, rendered frame by frame through headless Chromium (`packages/engines/src/motion.ts`). The model, the determinism rules, and the verification below are unchanged; only the API names differ.

## Model

Motion graphics are **templates driven by props JSON**. The agent edits props, not React code, for 90% of tasks. Code changes are for new templates only.

Templates (Phase 4): `title`, `lower-third`, `callout` (box + arrow + label), `kinetic-text`, `intro`, `outro`, `device-frame`, `cursor-highlight`, `speed-badge`, `chapter-card`.

A clip of type `comp` references a composition id and props:
```json
{ "id": "c_02", "track": "t_g1", "comp": "lower-third", "start": 2000, "dur": 3500,
  "props": { "title": "Ada Lovelace", "subtitle": "Founder", "accent": "token:accent", "ease": "expo.out" } }
```

## Determinism rules (a render must be repeatable)

- Drive everything by the frame number passed to `studio.render(frame)` (time = frame x 1000 / fps). No CSS transitions, CSS animations, `setTimeout`, `Date.now()`, or unseeded `Math.random()`.
- Use `ramp(t, start, dur, ease)` from `motion/src/ease.ts` (clamped, eased progress); it is the one easing module and accepts the project's easing names (`expo.out`, `bezier(...)`, `hold`). The UI does not use it yet.
- Fonts come from `brand/palette.json` (`fonts`), are loaded with `FontFace` before the first frame, and a missing or corrupt file fails the render (exit 3), not a silent substitute. Glyph coverage is not checked.
- Video inside compositions uses `<OffthreadVideo>`. Images via `<Img>`. Reference assets with `staticFile` or absolute local paths, not URLs.
- Duration and size come from props through `calculateMetadata`, so changing text length can change duration deliberately.

## Style rules

- Colors, spacing, type scale, and easing come from **brand tokens** (`brand/palette.json`) and the Studio tokens. No raw hex in templates.
- Motion language: entrances 300–500 ms `expo.out` or `cubic.out`; exits 200–300 ms `cubic.in`; stagger text by 40–80 ms per word or 15–30 ms per character; hold at least 1 s after the entrance finishes.
- Max two moving things competing for attention at once.
- Reading time: allow about 0.3 s per word, minimum 1.2 s.
- Lower thirds: sit inside the title-safe area (bottom third, 5% margins), animate in under 0.5 s, stay 3–5 s.
- Respect the vertical safe zone in `Context.md` §7 for 9:16 outputs.

## Rendering

- Use the compositor's frame-range render for previews: `studio motion still --comp X --frame N` (one PNG) before rendering video.
- Overlays for the FFmpeg path: render as ProRes 4444 or VP9 WebM with alpha, then composite. Check alpha by compositing over a checkerboard and viewing a frame.
- Set concurrency from `doctor` (half the cores by default, the browser is memory-hungry). Report render time and fps.
- Cache by hash of (composition id, props, code version, fps, size).
- A comp that takes more than ~3 s per second of video is slow; report it and look for heavy blur, shadows, or large images.

## Verification

- `still` at the first frame, the last frame, the entrance end, and the middle. View them.
- Check that text never overflows its container at the longest expected string. Test with a long placeholder.
- Check contrast of text against the actual underlying video frame, not just the template background.

## Licensing

Remotion's license did not fit, so the in-house renderer above is used. It depends on `playwright-core` (Apache-2.0) and a system Chromium; see `docs/licenses.md`.
