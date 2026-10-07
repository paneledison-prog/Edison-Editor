# 04 Image

## Pipeline basics

- Engine: sharp (libvips). Streaming, low memory. Do not load images into JS buffers manually.
- Respect EXIF orientation (`rotate()` with no args), then strip metadata unless asked to keep it. Warn when stripping removes an ICC profile that affects appearance; convert to sRGB first.
- Work in sRGB for output. Convert wide-gamut sources deliberately and say so.
- Never overwrite the source. Outputs go to `renders/images/` with deterministic names.

## Resize and batch

- Modes: `cover` (fills, crops), `inside` (fits, no crop), `contain` (letterbox with a stated background color), `fill` only on request.
- `withoutEnlargement: true` by default. If the request needs enlargement, say the effective source size and offer upscaling.
- Resampling: Lanczos3 for downscale; light unsharp after downscale for web (sigma ~0.5 to 0.8) only if the user wants crisper output.
- Output formats: JPEG (quality 80–88, mozjpeg, progressive), WebP (quality 78–85), AVIF (slower; effort ≤ 5 for batches), PNG for alpha and flat graphics.
- Batch: concurrency = min(CPU cores − 1, 4). Process as a stream. Report count, failures with reasons, total input and output bytes. Resumable: skip outputs that exist with matching hash.
- Smart crop for thumbnails and avatars: use attention or entropy strategy only when told; otherwise center. Inspect a contact sheet of results.

## Background removal

- Engine: rembg with an ONNX model. Record the model name and license in the output. Some models are non-commercial.
- Output: PNG or WebP with alpha, same dimensions as the input.
- **Always inspect.** Composite the result over two backgrounds, one light and one dark, and look at edges, hair, glass, shadows, and thin parts. Report the failures you saw.
- Known limits: hair, fur, motion blur, glass, smoke, and low-contrast edges. Soft shadows are removed with the background. Offer a manual mask refinement path (`--mask-in`) when the output is not acceptable.
- Optional alpha matting for edges is slower. Offer it, don't default to it.

## Upscaling

- Engine: Real-ESRGAN ncnn-vulkan, 2x or 4x. Models: general photo vs anime/illustration, choose by content.
- Tile size to bound VRAM (default 256, lower on failure).
- **Upscaling invents detail.** Say so in the output. Never use it on documents where text accuracy matters without a review, and never for evidence or identification.
- Prefer upscale once, then downscale to the target, rather than multiple passes.
- Report time per megapixel from a small sample before starting a large batch.

## Color grading

Order: exposure → white balance (temperature/tint) → contrast → highlights/shadows → saturation/vibrance → LUT → sharpen → grain (optional).
- Parametric operations via libvips; `.cube` LUTs via FFmpeg `lut3d`. LUTs must declare their expected input color space. Applying a Rec.709 LUT to a log image looks wrong and must be flagged.
- Provide before/after side-by-side output for the agent to inspect. Check skin tones and clipped highlights with a histogram (`inspect frame --histogram`).
- Match shots by measuring mean luminance and channel means of two frames, adjust one toward the other, and report the delta.

## Thumbnail maker

- Default 1280×720 (16:9), JPEG or PNG under 2 MB for YouTube; also 1080×1920 for vertical covers.
- Inputs: a frame (select candidates via `inspect sheet`), optional cutout subject, headline text, brand palette.
- Rules: headline ≤ 5 words, high contrast, text over a clear region, subject not covered, safe margins ≥ 5%. **Legibility test:** downscale to 168×94 and inspect; if the headline is unreadable, fix it.
- Text is rendered via the motion engine (Remotion `still`) so fonts, tokens, and templates are shared with video.
- Produce 3 variants only if asked. Otherwise one, with the reason for the choices.
