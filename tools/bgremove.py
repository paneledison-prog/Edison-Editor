#!/usr/bin/env python3
"""Salient-object mask with a U2-Net family ONNX model (the models rembg ships).

Why not rembg itself: it pulls numba, scipy, and opencv for features Studio does not use. This adapter does
the same inference with onnxruntime, numpy, and Pillow only, and is called by `studio image bgremove`.

    bgremove.py --model u2net.onnx --jobs jobs.json

jobs.json is a list of {"in": rgb.png, "out": mask.png}. Each mask is an 8-bit grayscale PNG with the same
width and height as its input. One JSON line per finished job goes to stdout; failures exit non-zero with a
JSON error on stderr.

Limits (they come from the model, not the adapter): hair, fur, glass, smoke, motion blur, and low-contrast
edges come out soft or wrong; soft shadows are removed with the background.
"""
import argparse
import json
import sys
import time

import numpy as np
import onnxruntime as ort
from PIL import Image

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def mask_for(session, name, size, path):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    x = np.asarray(im.resize((size, size), Image.Resampling.LANCZOS), dtype=np.float32)
    x = x / max(float(x.max()), 1e-6)
    x = (x - MEAN) / STD
    x = x.transpose(2, 0, 1)[None].astype(np.float32)
    pred = session.run(None, {name: x})[0][0, 0]
    lo, hi = float(pred.min()), float(pred.max())
    pred = (pred - lo) / (hi - lo + 1e-8)
    m = Image.fromarray((pred * 255).astype(np.uint8), "L").resize((w, h), Image.Resampling.LANCZOS)
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--jobs", required=True)
    a = ap.parse_args()
    try:
        session = ort.InferenceSession(a.model, providers=["CPUExecutionProvider"])
        inp = session.get_inputs()[0]
        size = int(inp.shape[2])
        jobs = json.load(open(a.jobs))
        for job in jobs:
            t = time.perf_counter()
            mask_for(session, inp.name, size, job["in"]).save(job["out"], "PNG")
            print(json.dumps({"in": job["in"], "out": job["out"], "ms": round((time.perf_counter() - t) * 1000)}), flush=True)
    except Exception as e:  # noqa: BLE001 - report any failure as one JSON line
        print(json.dumps({"error": type(e).__name__, "message": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
