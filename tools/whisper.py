#!/usr/bin/env python3
"""Transcription adapter: faster-whisper (CTranslate2) with Silero VAD first and word timestamps.

Usage: whisper.py --audio A --model-dir D --out J [--language en] [--prompt TEXT] [--model-name N]
Writes one JSON file; progress goes to stderr. Times are seconds in the raw output; the engine converts to ms.
"""
import argparse
import json
import sys
import time


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--model-name", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--language")
    ap.add_argument("--prompt")
    ap.add_argument("--threads", type=int, default=0)
    a = ap.parse_args()

    import ctranslate2
    import faster_whisper
    from faster_whisper import WhisperModel
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    t0 = time.time()
    audio = decode_audio(a.audio, sampling_rate=16000)
    dur = len(audio) / 16000
    # VAD first: transcribe only speech spans, and keep the spans so segments over silence can be flagged.
    vad = VadOptions(min_silence_duration_ms=300, speech_pad_ms=100)
    speech = [
        {"start": c["start"] / 16000, "end": c["end"] / 16000}
        for c in get_speech_timestamps(audio, vad)
    ]
    model = WhisperModel(a.model_dir, device="cpu", compute_type="int8", cpu_threads=a.threads)
    segs, info = model.transcribe(
        audio,
        language=a.language,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters=vad,
        initial_prompt=a.prompt or None,
        condition_on_previous_text=False,
        beam_size=5,
    )
    out = []
    for s in segs:
        words = [
            {"w": w.word.strip(), "start": w.start, "end": w.end, "p": round(w.probability, 4)}
            for w in (s.words or [])
            if w.word.strip()
        ]
        under = sum(
            max(0.0, min(s.end, v["end"]) - max(s.start, v["start"])) for v in speech
        )
        out.append(
            {
                "start": s.start,
                "end": s.end,
                "text": s.text.strip(),
                "words": words,
                "speechOverlap": round(under / max(1e-6, s.end - s.start), 3),
            }
        )
        print(f"segment {len(out)} ends {s.end:.1f}s", file=sys.stderr)
    took = time.time() - t0
    json.dump(
        {
            "engine": "faster-whisper",
            "engineVersion": faster_whisper.__version__,
            "ctranslate2": ctranslate2.__version__,
            "model": a.model_name,
            "language": info.language,
            "languageProbability": round(info.language_probability, 4),
            "audioSeconds": dur,
            "tookSeconds": round(took, 2),
            "vad": {"engine": "silero (faster-whisper)", "speech": speech},
            "segments": out,
        },
        open(a.out, "w"),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
