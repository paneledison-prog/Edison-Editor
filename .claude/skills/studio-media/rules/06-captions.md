# 06 Captions and subtitles

## Transcription

- Engine: whisper.cpp or faster-whisper, **word-level timestamps on**. Record the model name, language, and version in the transcript file.
- Model choice: small or base for drafts, medium or large for finals. Say which was used and how long it took. Larger models cost time and memory; check `doctor` for RAM and GPU first.
- **Run VAD first** and transcribe only speech spans. Whisper-family models can hallucinate text over silence or music. After transcribing, flag any segment with no detected speech under it.
- Provide a glossary (`brand/glossary.txt`: product names, people, jargon) as the initial prompt, then fix known terms in post. Names and numbers are the most common errors.
- Store low-confidence words (probability < 0.5) as `review` flags. In the report, list them and say a human should check names and numbers.
- Keep the raw transcript read-only in the cache. Edits create a derived transcript referenced by the project.
- Transcript-driven editing: you may delete text and cut the matching media span. Always keep 80–120 ms padding and crossfade the join.

## Building cues

Standards to start from (adult general audience):
- Max **2 lines**, max **~42 characters per line**.
- Reading speed **≤ 17–20 characters per second**.
- Cue duration **min 1.0 s, max 7 s**. Gap between cues ≥ 2 frames.
- Break at punctuation and clause boundaries. Never split a name, a number with its unit, or an article from its noun. Balance the two lines.
- Remove filler words only if asked (verbatim vs clean-verbatim is a user choice; default: clean-verbatim for marketing, verbatim for interviews).
- Social style (word-by-word or 2–4 words per cue) is allowed on request; the 17–20 cps rule is relaxed, the rest holds.

Timing: cue starts at the first word start minus 0 to 2 frames and ends at the last word end plus up to 250 ms, unless that would overlap the next cue.

## Styling

- Tokens come from `brand/palette.json`. Never hard-code colors.
- Vertical (1080×1920): font size about 4–5% of frame height (about 60–70 px), bold weight, inside the safe zone (see `Context.md` §7), max width 80% of frame.
- Horizontal (1080p): font about 4% of frame height (about 42–48 px), bottom margin ≥ 5%.
- Legibility: outline or semi-opaque box. Test against the **busiest** frame in the cue, not an average one. View it.
- Word highlight (karaoke) uses the word timestamps. Highlight color needs ≥ 3:1 against the base text color and the background.

## Delivery

| Need | Format |
|---|---|
| Social, silent autoplay | **burned in** (`captions` motion template, via `studio captions add`) |
| Web player, YouTube upload | **sidecar** `.srt` or `.vtt`, plus optionally burned-in variant |
| Styled sidecar | `.ass` |

FFmpeg `subtitles` needs libass and fonts available; `doctor` checks. Non-Latin scripts and right-to-left languages need a font with coverage and correct shaping. After rendering, inspect frames to confirm glyphs are not missing (tofu boxes).

## Translation

Only on request. Label the output "machine translation" in the file metadata and the report. Line lengths differ per language; re-run cue building after translation.

## Verification

- Check timing: pick 5 cues across the piece, extract frames at start+1 frame and end−1 frame, and confirm text visible and in the right place.
- Check max line length and cps by script, not by eye. Report violations.
- Check that no cue sits outside the safe zone for the chosen aspect.
