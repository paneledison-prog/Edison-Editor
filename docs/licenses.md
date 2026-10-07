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

## External engines

| Engine                                                            | Where                                  | License note                                                                                                                  | Status             |
| ----------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| FFmpeg / ffprobe 6.1.1 (Ubuntu build)                             | system binary, invoked as a subprocess | Built with `--enable-gpl` and libx264/libx265: **GPL**. Not redistributed by this repo.                                       | in use from step 7 |
| whisper, rembg, Real-ESRGAN, RNNoise, silero-vad, sharp, Remotion | not installed                          | License to be verified and recorded before each is wired in (Context §5). Remotion's license depends on company size and use. | not started        |

## Fonts and icons (UI)

Lucide (ISC) is in use. Geist Sans / Geist Mono (OFL) are **not bundled yet**: `tokens.css` lists them first and falls back to the system stack, which is what renders today. Bundling latin subsets needs a size check against the 60 KB gzipped limit in rules/11.
