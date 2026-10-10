#!/usr/bin/env python3
"""Alpha matting with ViTMatte (small) as a JSON-lines server: the hair and fine-edge tier of the edge engine.

    matting.py --model models/vitmatte-small.onnx

One JSON object per line on stdin, one JSON line back:

  {"cmd":"matte","in":"rgb.png","tri":"trimap.png","out":"alpha.png"}
      `tri` is gray: 0 = sure background, 255 = sure object, anything else = unknown. Only the unknown band (padded) is
      sent through the model, so the cost follows the size of the edge, not of the picture. `out` is an 8-bit gray PNG the
      size of the input: the model's opacity in the unknown band, 0 and 255 elsewhere as the trimap says.
  {"cmd":"quit"}

Only onnxruntime, numpy and Pillow are used. Limits come from the model: it was trained on photographs of objects and
people with a good trimap; a trimap whose unknown band misses the true edge cannot be corrected by it, and it softens
what it cannot see.
"""
import argparse
import json
import sys
import time

import numpy as np
import onnxruntime as ort
from PIL import Image


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--threads", type=int, default=0)
    a = ap.parse_args()
    so = ort.SessionOptions()
    if a.threads:
        so.intra_op_num_threads = a.threads
    sess = ort.InferenceSession(a.model, so, providers=["CPUExecutionProvider"])

    def reply(o):
        print(json.dumps(o), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            q = json.loads(line)
            if q["cmd"] == "quit":
                reply({"ok": True})
                return
            if q["cmd"] != "matte":
                reply({"ok": False, "error": "unknown cmd"})
                continue
            im = np.asarray(Image.open(q["in"]).convert("RGB"), dtype=np.float32) / 255.0
            tri_in = np.asarray(Image.open(q["tri"]).convert("L"))
            h, w = tri_in.shape
            tri = np.where(tri_in == 0, 0.0, np.where(tri_in == 255, 1.0, 0.5)).astype(np.float32)
            unk = tri == 0.5
            out = np.where(tri_in == 255, 255, 0).astype(np.uint8)
            t = time.perf_counter()
            if unk.any():
                ys, xs = np.where(unk)
                pad = 32
                y0, y1 = max(0, ys.min() - pad), min(h, ys.max() + 1 + pad)
                x0, x1 = max(0, xs.min() - pad), min(w, xs.max() + 1 + pad)
                I = im[y0:y1, x0:x1]
                T = tri[y0:y1, x0:x1]
                ch, cw = T.shape
                ph = (32 - ch % 32) % 32
                pw = (32 - cw % 32) % 32
                X = np.concatenate([(I - 0.5) / 0.5, T[..., None]], axis=2).transpose(2, 0, 1)[None]
                X = np.pad(X, ((0, 0), (0, 0), (0, ph), (0, pw)), mode="constant").astype(np.float32)
                al = sess.run(None, {"pixel_values": X})[0][0, 0][:ch, :cw]
                region = unk[y0:y1, x0:x1]
                sub = out[y0:y1, x0:x1]
                sub[region] = np.clip(al[region] * 255.0 + 0.5, 0, 255).astype(np.uint8)
            ms = round((time.perf_counter() - t) * 1000)
            Image.fromarray(out, "L").save(q["out"], "PNG")
            reply({"ok": True, "ms": ms, "unknownShare": round(float(unk.mean()), 4)})
        except Exception as ex:  # noqa: BLE001 - one JSON line, keep serving
            reply({"ok": False, "error": type(ex).__name__ + ": " + str(ex)})


if __name__ == "__main__":
    main()
