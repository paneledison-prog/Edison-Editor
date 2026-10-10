#!/usr/bin/env python3
"""Promptable segmentation (Segment Anything 2.1, tiny) as a small JSON-lines server: the Object Mask Tool's model.

    segment.py --model-dir models/sam2.1-tiny --cache DIR

Reads one JSON object per line on stdin and answers one JSON line on stdout.

  {"cmd":"embed","id":"f12","in":"frame.png"}
      Runs the image encoder once and keeps the embedding (memory and DIR/<id>.npz), so any number of prompts on the
      same frame afterwards cost milliseconds.
  {"cmd":"decode","id":"f12","points":[[x,y],...],"labels":[1,0,...],"box":[x0,y0,x1,y1],"pick":"auto|whole|smallest|best|first","out":"mask.png"}
      Coordinates are pixels of the embedded image. Writes an 8-bit grayscale PNG (probability, same size as the image)
      and answers with the three candidate masks' predicted quality and area and the one that was written.
  {"cmd":"proposals","id":"f12","prompts":[{"points":[[x,y]],"labels":[1],"box":null},...],"out":"file"}
      Many prompts on one frame: the logits (256x256) of every one of the three candidates of each, one byte each, in the file "out".
  {"cmd":"quit"}

Only onnxruntime, numpy and Pillow are used. Limits come from the model: thin structures and hair are soft, the model
sees the picture at 1024x1024 whatever its shape, and its predicted quality is a hint, not a measurement.
"""
import argparse
import json
import os
import sys
import time

import numpy as np
import onnxruntime as ort
from PIL import Image

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
S = 1024


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-np.clip(x, -30, 30)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--cache", required=True)
    ap.add_argument("--threads", type=int, default=0)
    a = ap.parse_args()
    os.makedirs(a.cache, exist_ok=True)
    so = ort.SessionOptions()
    if a.threads:
        so.intra_op_num_threads = a.threads
    prov = ["CPUExecutionProvider"]
    enc = ort.InferenceSession(os.path.join(a.model_dir, "vision_encoder_int8.onnx"), so, providers=prov)
    dec = ort.InferenceSession(os.path.join(a.model_dir, "prompt_encoder_mask_decoder.onnx"), so, providers=prov)
    mem = {}
    sizes = {}

    def reply(o):
        print(json.dumps(o), flush=True)

    def load(i):
        if i in mem:
            return mem[i]
        f = os.path.join(a.cache, i + ".npz")
        if not os.path.exists(f):
            raise KeyError("no embedding for " + i)
        z = np.load(f)
        mem[i] = [z["e0"].astype(np.float32), z["e1"].astype(np.float32), z["e2"].astype(np.float32)]
        sizes[i] = tuple(int(v) for v in z["size"])
        if len(mem) > 6:  # keep memory small: the disk copy is the cache
            for k in list(mem)[:-6]:
                del mem[k]
        return mem[i]

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            q = json.loads(line)
            cmd = q["cmd"]
            if cmd == "quit":
                reply({"ok": True})
                return
            if cmd == "embed":
                f = os.path.join(a.cache, q["id"] + ".npz")
                if os.path.exists(f):
                    load(q["id"])
                    reply({"ok": True, "id": q["id"], "ms": 0, "cached": True})
                    continue
                im = Image.open(q["in"]).convert("RGB")
                w, h = im.size
                x = np.asarray(im.resize((S, S), Image.Resampling.BILINEAR), dtype=np.float32) / 255.0
                x = ((x - MEAN) / STD).transpose(2, 0, 1)[None].astype(np.float32)
                t = time.perf_counter()
                e = enc.run(None, {"pixel_values": x})
                ms = round((time.perf_counter() - t) * 1000)
                np.savez(f + ".tmp.npz", e0=e[0].astype(np.float16), e1=e[1].astype(np.float16), e2=e[2].astype(np.float16), size=np.array([w, h]))
                os.replace(f + ".tmp.npz", f)
                mem[q["id"]] = [v.astype(np.float32) for v in e]
                sizes[q["id"]] = (w, h)
                reply({"ok": True, "id": q["id"], "ms": ms, "cached": False})
            elif cmd == "decode":
                e = load(q["id"])
                w, h = sizes[q["id"]]
                pts = q.get("points") or []
                lab = q.get("labels") or []
                box = q.get("box")
                sc = np.array([S / w, S / h], dtype=np.float32)
                if pts:
                    p = (np.array(pts, dtype=np.float32) * sc).reshape(1, 1, -1, 2)
                    l = np.array(lab, dtype=np.int64).reshape(1, 1, -1)
                else:
                    p = np.zeros((1, 1, 1, 2), np.float32)
                    l = np.full((1, 1, 1), -1, np.int64)
                if box:
                    b = (np.array(box, dtype=np.float32) * np.array([S / w, S / h, S / w, S / h], dtype=np.float32)).reshape(1, 1, 4)
                else:
                    b = np.zeros((1, 0, 4), np.float32)
                t = time.perf_counter()
                iou, m, obj = dec.run(None, {"image_embeddings.0": e[0], "image_embeddings.1": e[1], "image_embeddings.2": e[2], "input_points": p.astype(np.float32), "input_labels": l, "input_boxes": b.astype(np.float32)})
                ms = round((time.perf_counter() - t) * 1000)
                m = m[0, 0]  # (3, 256, 256) logits
                iou = iou[0, 0]
                areas = [float((m[k] > 0).mean()) for k in range(m.shape[0])]
                pick = q.get("pick") or "auto"
                if pick == "auto":
                    # the candidate that keeps every point asked to be inside, none asked to be outside, and is most sure of itself
                    best, bs = 0, -1e9
                    for kk in range(m.shape[0]):
                        sc_ = 0.2 * float(iou[kk])
                        for (px, py), lb in zip(pts, lab):
                            gx = min(255, max(0, int(px / w * 256)))
                            gy = min(255, max(0, int(py / h * 256)))
                            inside = m[kk][gy, gx] > 0
                            sc_ += (1.0 if inside else -1.0) if lb == 1 else (-2.0 if inside else 0.5)
                        # of the candidates that agree with the points, the whole object (the largest) rather than a part of it
                        sc_ += 1.5 * areas[kk] / max(max(areas), 1e-6)
                        if box:
                            # a box says the object is inside it: a candidate that spills far outside it is another object or the background
                            gx0, gy0, gx1, gy1 = [v * 256 / d for v, d in zip(box, (w, h, w, h))]
                            mk_ = m[kk] > 0
                            tot = float(mk_.sum())
                            if tot > 0:
                                ys, xs = np.mgrid[0:256, 0:256]
                                inb = float((mk_ & (xs >= gx0) & (xs <= gx1) & (ys >= gy0) & (ys <= gy1)).sum()) / tot
                                sc_ -= 4.0 * max(0.0, 0.85 - inb)
                        if sc_ > bs:
                            best, bs = kk, sc_
                    k = best
                elif pick == "whole":
                    k = int(np.argmax(areas))
                elif pick == "smallest":
                    # the smallest candidate that keeps every point asked to be inside and none asked to be outside (one object, not its neighbours)
                    ok = [kk for kk in range(m.shape[0]) if all((m[kk][min(255, max(0, int(py / h * 256))), min(255, max(0, int(px / w * 256)))] > 0) == (lb == 1) for (px, py), lb in zip(pts, lab))]
                    k = min(ok or range(m.shape[0]), key=lambda kk: areas[kk])
                elif pick == "best":
                    k = int(np.argmax(iou))
                else:
                    k = 0
                if isinstance(q.get("index"), int):
                    k = int(q["index"])
                # logits upsampled (smooth) before the sigmoid, so the boundary is not a staircase of 256-px cells
                lg = Image.fromarray(m[k].astype(np.float32), mode="F").resize((w, h), Image.Resampling.BILINEAR)
                prob = sigmoid(np.asarray(lg))
                Image.fromarray((prob * 255 + 0.5).astype(np.uint8), "L").save(q["out"], "PNG")
                reply({"ok": True, "ms": ms, "picked": k, "iou": [round(float(v), 3) for v in iou], "area": [round(v, 4) for v in areas], "object": round(float(obj.reshape(-1)[0]), 2)})
            elif cmd == "proposals":
                # many prompts on one frame; every candidate's 256x256 logits (clipped to +-12, one byte each) go to one file:
                # prompt-major, then candidate, then row-major: P x 3 x 256 x 256 bytes
                e = load(q["id"])
                w, h = sizes[q["id"]]
                sc = np.array([S / w, S / h], dtype=np.float32)
                res = []
                blob = []
                t0 = time.perf_counter()
                for pi, pr in enumerate(q["prompts"]):
                    pts = pr.get("points") or []
                    lab = pr.get("labels") or []
                    box = pr.get("box")
                    if pts:
                        p = (np.array(pts, dtype=np.float32) * sc).reshape(1, 1, -1, 2)
                        l = np.array(lab, dtype=np.int64).reshape(1, 1, -1)
                    else:
                        p = np.zeros((1, 1, 1, 2), np.float32)
                        l = np.full((1, 1, 1), -1, np.int64)
                    if box:
                        b = (np.array(box, dtype=np.float32) * np.array([S / w, S / h, S / w, S / h], dtype=np.float32)).reshape(1, 1, 4)
                    else:
                        b = np.zeros((1, 0, 4), np.float32)
                    iou, m, obj = dec.run(None, {"image_embeddings.0": e[0], "image_embeddings.1": e[1], "image_embeddings.2": e[2], "input_points": p.astype(np.float32), "input_labels": l, "input_boxes": b.astype(np.float32)})
                    m = m[0, 0]
                    iou = iou[0, 0]
                    blob.append(np.clip((m + 12.0) * (255.0 / 24.0) + 0.5, 0, 255).astype(np.uint8))
                    res.append({"iou": [round(float(v), 3) for v in iou], "area": [round(float((m[k] > 0).mean()), 4) for k in range(m.shape[0])]})
                np.stack(blob).tofile(q["out"])
                reply({"ok": True, "ms": round((time.perf_counter() - t0) * 1000), "results": res, "size": [int(blob[0].shape[1]), int(blob[0].shape[2])] if blob else [0, 0]})
            else:
                reply({"ok": False, "error": "unknown cmd " + str(cmd)})
        except Exception as ex:  # noqa: BLE001 - report any failure as one JSON line and keep serving
            reply({"ok": False, "error": type(ex).__name__ + ": " + str(ex)})


if __name__ == "__main__":
    main()
