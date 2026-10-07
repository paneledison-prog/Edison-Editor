# 03 Audio

## Order of operations

For speech, the chain order matters: **high-pass → denoise → EQ → de-ess (if needed) → compress → limit → loudness normalize last.** Normalizing before denoising raises the noise.

## Measure first, change second

Before any processing, run `studio inspect loudness` and record: integrated LUFS, LRA, true peak, noise floor (RMS of the quietest 10% of 50 ms windows), clipping count. After processing, measure again and report both.

## Denoise

- Start with high-pass at 70–90 Hz for voice.
- `afftdn` (built in) with gentle reduction (noise reduction ≈ 10–18 dB) for steady hiss and hum. Use `arnndn` (RNNoise) or DeepFilterNet if installed for more difficult noise.
- Over-processing causes watery or metallic speech. Always compare before and after on a 10 s sample of speech and a 10 s sample of room tone; say what you heard in numbers (noise floor delta) and what you could not judge by ear.
- Mains hum: notch at 50/60 Hz and harmonics instead of broad denoise.
- You cannot remove reverb or overlapping speech with these tools. Say so.

## Podcast cleanup preset (`audio clean-podcast`)

high-pass 80 Hz → light denoise → gentle EQ (cut mud 200–300 Hz by 1–3 dB, optional presence +2 dB around 3 kHz) → compressor (ratio 2:1 to 3:1, soft knee, 3–6 dB gain reduction at peaks) → limiter → loudnorm.
Targets: **−16 LUFS stereo (−19 LUFS mono)**, true peak ≤ −1.5 dBTP. Each step is optional via flags, and the command prints the exact filtergraph it used.

## Loudness targets

| Destination | Integrated | True peak |
|---|---|---|
| Social, web video (default) | −14 LUFS | ≤ −1.5 dBTP |
| Podcast | −16 LUFS (stereo) | ≤ −1.5 dBTP |
| Broadcast (EBU R128) | −23 LUFS | ≤ −1 dBTP |

Use two-pass `loudnorm` (measure, then apply with the measured values) for accuracy. Single-pass is allowed for previews only. Do not push loudness with a limiter to hit a number at the cost of audible pumping; report if LRA gets squashed below ~3 LU for speech content.

## Ducking

Sidechain compression: music is the signal, voice is the sidechain. Starting values: threshold set so speech reduces music by about 12–18 dB, ratio 6–10:1, attack 10–30 ms, release 300–600 ms. Music bed base level about −20 dB relative to the voice. Verify by measuring music-only and speech-with-music windows.

## Joins

Every spliced join gets a 10–20 ms crossfade. Detect clicks after rendering with a short-window peak-difference check at each join timestamp (see verification).

## Sample rate and channels

Keep 48 kHz for video. Convert 44.1 kHz material once, at ingest or render, not repeatedly. Mono voice on a stereo track: duplicate to both channels (don't pan hard left).

## Voiceover

Record-first. Steps: import the file; align to the script (forced alignment with transcript timestamps); trim breaths and false starts; cleanup chain; place on the VO track; run QC. If the user wants synthetic voice, require a locally installed TTS engine with a recorded license, mark `"synthetic": true` on the asset, and say it in the report. Recording inside the UI (the record button) is a Phase 6 feature.

## Music and SFX library

A local index (`.studio/library.json`) with: path, duration, bpm if known, tags, license note, and loop points if known. `audio sfx search "<query>"` searches names and tags only; it does not "understand" audio. Never add a track without a license note. If the license is unknown, mark `license: "unknown"` and warn at export.

## Transcription

See `06-captions.md`. Always keep the raw transcript with word timestamps in the cache; edits create a derived transcript.
