# Licenses and dependency log

Sizes are unpacked package size in `node_modules` on linux-x64 (measured, not gzipped). Add a row in the same commit as any new dependency.

## npm dependencies

| Package     | Version | License    | Size       | Why                                                                      | Scope          |
| ----------- | ------- | ---------- | ---------- | ------------------------------------------------------------------------ | -------------- |
| zod         | 3.25.76 | MIT        | 4.8 MB     | Project schema and op argument validation, one source of truth for types | runtime (core) |
| typescript  | 5.9.3   | Apache-2.0 | 23 MB      | Strict typing, project references                                        | dev            |
| vitest      | 3.2.7   | MIT        | 1.7 MB     | Unit and property tests                                                  | dev            |
| esbuild     | 0.25.12 | MIT        | 0.2 MB     | Bundles the CLI into one file for fast cold start                        | dev            |
| prettier    | 3.9.9   | MIT        | 9.9 MB     | Formatting                                                               | dev            |
| @types/node | 22.x    | MIT        | types only | Node typings                                                             | dev            |

### Image tools (Phase 3)

| Package                      | Version | License           | Size                                 | Why                                                               | Scope                                                                   |
| ---------------------------- | ------- | ----------------- | ------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| sharp                        | 0.35.5  | Apache-2.0        | 1.0 MB, plus a 0.5 MB native binding | Resize, convert, composite, text, alpha. Streaming and low memory | runtime (engines, cli); external in the CLI bundle because it is native |
| @img/sharp-libvips-linux-x64 | 1.3.4   | LGPL-3.0-or-later | 18 MB                                | The libvips build sharp loads (prebuilt, dynamically linked)      | runtime, via sharp                                                      |

Python adapter (`tools/bgremove.py`, pinned in `tools/requirements.txt`; rembg itself is not used because it pulls numba, scipy, and opencv for features Studio does not need):

| Package     | Version | License                                                    | Size           | Why                                                  |
| ----------- | ------- | ---------------------------------------------------------- | -------------- | ---------------------------------------------------- |
| onnxruntime | 1.29.0  | MIT                                                        | 62 MB          | Runs the U2-Net ONNX models (CPU provider only here) |
| numpy       | 2.5.3   | BSD-3-Clause (bundled libraries: 0BSD, MIT, Zlib, CC0-1.0) | system package | Tensor preparation                                   |
| pillow      | 12.3.0  | MIT-CMU                                                    | system package | Image I/O and resizing for the model input           |

### Captions and motion (Phase 4)

**Remotion was evaluated and rejected by the project owner.** Its license is source-available (free for individuals, for-profit companies up to 3 people, and non-profits; a paid Company License otherwise, and it changes in Remotion 5.0), so motion graphics use an in-house renderer instead: HTML/CSS templates in `motion/`, driven frame by frame through headless Chromium, then composited by FFmpeg. No Remotion package is installed.

| Package                                | Version | License                                              | Size                 | Why                                                                                                                      | Scope                                                                                    |
| -------------------------------------- | ------- | ---------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| playwright-core                        | 1.64.0  | Apache-2.0                                           | 14 MB                | Drives the already-installed Chromium for motion frames (no browser is downloaded)                                       | runtime (engines); external in the CLI bundle. Was already a dev dependency for UI tests |
| Chromium (system, via Playwright)      | 141     | BSD-3-Clause and others                              | not part of the repo | Renders templates to transparent PNG frames; `STUDIO_CHROMIUM` overrides the path                                        | system binary, invoked as a subprocess                                                   |
| Inter Regular and Bold (`brand/fonts`) | 4.x     | OFL-1.1 (Inter also lists Apache-2.0 for some files) | 1.2 MB (two files)   | The template and caption font; the render fails if a font file is missing. License text: `brand/fonts/Inter-LICENSE.txt` | bundled in the repo                                                                      |

Python adapter for transcription (`tools/whisper.py`, pinned in `tools/requirements-whisper.txt`, installed in `tools/.venv` with `--system-site-packages` so the onnxruntime and numpy from `tools/requirements.txt` are reused):

| Package                                         | Version | License                                                                    | Size                 | Why                                                                                                                                          |
| ----------------------------------------------- | ------- | -------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| faster-whisper                                  | 1.2.1   | MIT                                                                        | 2 MB                 | Whisper inference with word timestamps and a built-in Silero VAD (run before decoding)                                                       |
| ctranslate2                                     | 4.8.2   | MIT                                                                        | 60 MB                | The inference engine under faster-whisper (CPU, int8)                                                                                        |
| av (PyAV)                                       | 16.1.0  | BSD-3-Clause                                                               | 36 MB                | Audio decode inside faster-whisper. 19.x does not work with faster-whisper 1.2.1 (`metadata_errors`), so it is pinned below 17               |
| tokenizers                                      | 0.23.2  | Apache-2.0                                                                 | 12 MB                | Whisper tokenizer                                                                                                                            |
| huggingface_hub                                 | 1.33.0  | Apache-2.0                                                                 | 8 MB                 | Required by faster-whisper; **not used to download**: Studio fetches models itself                                                           |
| hf_xet, httpx, httpcore, tqdm, filelock, fsspec | see pip | Apache-2.0, BSD-3-Clause, BSD-3-Clause, MPL-2.0 AND MIT, MIT, BSD-3-Clause | about 17 MB together | Dependencies pulled in by huggingface_hub (tqdm is MPL-2.0 and MIT; MPL applies to modifications of tqdm itself, which Studio does not make) |

### MCP (Phase 7)

`studio mcp` is a hand-written stdio JSON-RPC server (about 150 lines, no dependency). The official `@modelcontextprotocol/sdk` (MIT, 4.5 MB unpacked) was **not added**; version 1.32.1 was installed in a scratch directory only to check that its client can connect, list, and call tools.

## Models and engines (models/manifest.json)

Checksums were recorded on first download and are verified on every `studio models fetch`. Licenses are the upstream repository licenses; verify them for your use before shipping.

| Name                                                                                                    | Used for                                                                  | License      | Source of the license                                     | Size                       |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------ | --------------------------------------------------------- | -------------------------- |
| u2net (`u2net.onnx`)                                                                                    | `image bgremove` (default)                                                | Apache-2.0   | github.com/xuebinqin/U-2-Net LICENSE                      | 176 MB                     |
| u2netp (`u2netp.onnx`)                                                                                  | `image bgremove --model u2netp` (smaller, rougher)                        | Apache-2.0   | same                                                      | 4.6 MB                     |
| realesrgan-ncnn-vulkan 20220424 (with realesrgan-x4plus, realesrgan-x4plus-anime, realesr-animevideov3) | `image upscale`                                                           | BSD-3-Clause | github.com/xinntao/Real-ESRGAN LICENSE                    | 47 MB zip, 56 MB installed |
| whisper-tiny.en (Systran/faster-whisper-tiny.en, CTranslate2 conversion of OpenAI Whisper tiny.en)      | `transcribe --model whisper-tiny.en` (fast, English only, poorest timing) | MIT          | model card `license: mit`; upstream openai/whisper is MIT | 75 MB                      |
| whisper-small (Systran/faster-whisper-small)                                                            | `transcribe` (default draft model)                                        | MIT          | same                                                      | 484 MB                     |
| whisper-medium (Systran/faster-whisper-medium)                                                          | `transcribe --model whisper-medium` (finals)                              | MIT          | same                                                      | 1.5 GB                     |

The whisper entries are multi-file directories (`kind: whisper-dir`): every file has its own size and sha256 in the manifest, pinned to a Hugging Face revision, and is checked on fetch.

Not used on purpose: models with non-commercial licenses (for example BRIA RMBG-1.4).

## System packages outside the repository

`mesa-vulkan-drivers` 25.2.8 (Mesa, MIT; 96 MB installed) was installed with `apt` **in this container only** to give Real-ESRGAN a software Vulkan device (lavapipe). It is not part of the repository. A new session or machine needs a GPU driver or the same package, and `studio doctor` reports what it finds.

## Test-only material (not committed)

- `jfk.flac` (11 s speech excerpt) is downloaded from the OpenAI Whisper repository (`tests/jfk.flac`, repository license MIT) into `tests/.fixtures/real/` by `tests/real-speech.test.ts` to measure caption timing on real speech. The recording is an excerpt of a 1961 US presidential address, which I believe is a US government work in the public domain; that was **not independently verified**. The test skips, and says so, without network access or models.
- A public-domain NASA portrait (the scikit-image `astronaut.png` sample) is downloaded into `tests/.fixtures/` for background-removal tests. The tests skip, and say so, if it cannot be fetched.
- Inter (SIL OFL 1.1) is read from the system font path by the thumbnail tests. Phase 4 bundles Inter Regular and Bold under `brand/fonts` for the motion renderer (see above).
- Speech fixtures for the caption tests are synthesized by FFmpeg's built-in `flite` voice (slt); no recording is used.

## External engines

| Engine                                                          | Where                                  | License note                                                                                                            | Status             |
| --------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------ |
| FFmpeg / ffprobe 6.1.1 (Ubuntu build)                           | system binary, invoked as a subprocess | Built with `--enable-gpl` and libx264/libx265: **GPL**. Not redistributed by this repo.                                 | in use from step 7 |
| faster-whisper, CTranslate2, Silero VAD (inside faster-whisper) | `tools/.venv` (git-ignored)            | MIT. See the Phase 4 table above.                                                                                       | in use (Phase 4)   |
| RNNoise, rembg                                                  | not installed                          | Not used. RNNoise is not wired in (the `arnndn` path needs a model file); rembg is replaced by direct U2-Net inference. | not used           |
| Remotion                                                        | not installed                          | **Rejected by the project owner** (license tiers). An in-house Chromium renderer is used instead.                       | rejected           |

## Fonts and icons (UI)

Lucide (ISC) is in use. Geist Sans / Geist Mono (OFL) are **not bundled yet**: `tokens.css` lists them first and falls back to the system stack, which is what renders today. Bundling latin subsets needs a size check against the 60 KB gzipped limit in rules/11.

## Phase 9: plugins and scripts

No new dependency. The plugin loader, the expression evaluator, and the four shipped plugins (`glow`, `shapes`, `light-fx`, `logo-reveal`) and the three shipped scripts are Studio's own code, MIT like the repository. The shipped plugins use only FFmpeg filters already in the build and the browser's own 2D canvas and SVG. Plugin names such as "glow" or "saber" describe an effect; they are not copies of any commercial product and use none of its code or assets.
Test footage: the *Sintel* trailer (c) Blender Foundation, CC BY 3.0, was downloaded to a scratch directory to try the edit. It is not in the repository.

## Design editor

No new dependency. `packages/design` (zod, already used) and `apps/design` (preact and lucide-preact, already used by the media editor) are Studio's own code, MIT like the repository. Export uses the Chromium and FFmpeg already recorded above; MP4 uses libx264, the others use libvpx-vp9, prores_ks, and the GIF palette filters of the same FFmpeg build. Fonts are the brand's Inter (SIL OFL, recorded above). The editor imitates the layout of design-and-animation tools in general (layers, properties, timeline); it contains no code or assets from any of them.

