# 10 Performance

"Lightweight and fast" is a requirement with numbers. Targets are in the Master Prompt §8. Measure and report; do not claim.

## How to measure

- `pnpm bench` runs: CLI cold start, ingest of a 10-minute 1080p fixture, a 100-cut render, a 200-image batch, timeline scroll with 500 clips, UI idle CPU and memory.
- Record results with machine spec (CPU, RAM, GPU, OS, ffmpeg build) in `docs/perf.md`. Compare to the previous run. A regression over 10% blocks the change unless justified.

## Media

- Decode once, filter once, encode once. Fewer intermediate files.
- Use hardware decode (`-hwaccel auto`) when available and safe; fall back quietly only for decode (output is identical), and log it.
- Cache by content hash: proxies, thumbnails, peaks, transcripts, scene lists, analysis. Cache keys include tool version and args.
- Background jobs use a small queue (concurrency from `doctor`), cancellable, resumable, never blocking the CLI response for interactive commands.
- Never buffer a whole file. Stream through pipes or let FFmpeg read files directly.
- Large batches: bounded concurrency, backpressure, and progress on stderr.

## UI

- Shell ≤ 250 KB gzipped JS. Remotion Player, graph editor, and waveform workers are lazy chunks. Check bundle size in CI and fail on growth over 10% without a note.
- **Virtualize** the timeline (only draw visible clips and rows) and the asset list.
- Waveforms from cached peaks with multi-resolution levels, drawn on canvas, never recomputed from audio in the UI.
- Thumbnails: sprite sheets per asset, lazily loaded.
- Live reload via the **op stream**, not by reloading the entire project. Debounce file watching at ~50 ms. Preserve playhead, selection, zoom, and scroll.
- Sync preview using `requestVideoFrameCallback` when available. Keep one `<video>` per active proxy. Release elements that are off-screen.
- No work when idle: no polling, no timers, no animation loops while paused.
- Avoid layout thrash: batch DOM reads and writes. Use CSS transforms for playhead and clip drags. `will-change` only during active drags.
- Memory: cap decoded thumbnail cache; evict least recently used.
- Dependencies are rare and small. Show size next to each in the license table.

## CLI

- Cold start under 300 ms for non-media commands: lazy-import engines, no top-level heavy imports, no network calls.
- JSON output only; no pretty-printing unless `--pretty`.
- `studio tools --json` is generated, not hand-written, and costs nothing at runtime.
