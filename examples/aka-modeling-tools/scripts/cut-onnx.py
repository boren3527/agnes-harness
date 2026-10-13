"""
cut-onnx.py -- subject extraction with a class-agnostic salient-object model, via
onnxruntime directly. Called by mesh_run's `preprocessCommand`.

Why not rembg: pip cannot reach pypi.org from this machine (SSL EOF), and rembg drags in
opencv/pymatting/scikit-image anyway. `onnxruntime`, `numpy` and `Pillow` are ALREADY in
this venv, so the only thing missing is the model file itself - which is exactly the thing
that must be local (the earlier failure was rembg trying to fetch it at run time and hanging
silently, not the model being unavailable).

    # one download, then this runs offline forever:
    curl.exe -L --retry 3 -o "%USERPROFILE%\\.u2net\\u2net.onnx" ^
      "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx"

Usage (mesh_run substitutes the placeholders):
    python cut-onnx.py {image} {out}

Writes <out>/prep/<stem>_cut.png: the source, RGBA, background transparent, NOT cropped and
NOT rescaled - the generator wrapper's own prep does the cropping and grey compositing.
Prints how much of the frame survived, because that number is what a human needs in order to
judge whether the cut is plausible.

u2net preprocessing (as the model expects, and as rembg does it): resize to 320x320 RGB,
normalise with ImageNet mean/std, take output[0][0] as the saliency map, resize that back to
the original size. Anything deviating from this is a guess, so it is written down here.
"""
import os
import sys

import numpy as np
from PIL import Image

SRC, DST_DIR = sys.argv[1], sys.argv[2]
MODEL_PATH = os.environ.get('U2NET_PATH') or os.path.join(os.environ.get('USERPROFILE', '.'), '.u2net', 'u2net.onnx')
SIZE = 320
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def main():
    try:
        import onnxruntime as ort
    except ImportError:
        print('FATAL: onnxruntime is not installed in this interpreter (it is required, not optional)')
        return 2
    if not os.path.isfile(MODEL_PATH):
        print('FATAL: no model at %s. Download it once (see the docstring); nothing is fetched at run time.'
              % MODEL_PATH)
        return 2

    src = Image.open(SRC)
    # **图自己带 alpha 就直接用它**：那是作者的裁切，比我们重新预测更可信；也省一次推理。
    # 只有在 alpha 没有真正起作用时（全不透明 / 全透明）才去跑模型 —— 否则我们是在用一次预测
    # 去覆盖一个已知的事实。
    if 'A' in src.getbands():
        existing = src.split()[-1]
        opaque = sum(existing.histogram()[8:]) / float(existing.size[0] * existing.size[1])
        if 0.01 < opaque < 0.99:
            print('source already carries alpha (%.1f%% opaque): using it as the cut, no model run' % (100.0 * opaque))
            cut = src.convert('RGBA')
            bbox = cut.split()[-1].getbbox()
            stem = os.path.splitext(os.path.basename(SRC))[0]
            out_dir = os.path.join(DST_DIR, 'prep')
            os.makedirs(out_dir, exist_ok=True)
            path = os.path.join(out_dir, stem + '_cut.png')
            cut.save(path)
            print('wrote %s (%dx%d RGBA), bounding box %s' % (path, cut.size[0], cut.size[1], bbox))
            return 0

    src = Image.open(SRC).convert('RGB')
    w, h = src.size
    small = src.resize((SIZE, SIZE), Image.LANCZOS)
    x = (np.asarray(small, dtype=np.float32) / 255.0 - MEAN) / STD
    x = np.transpose(x, (2, 0, 1))[None, ...].astype(np.float32)

    session = ort.InferenceSession(MODEL_PATH, providers=['CPUExecutionProvider'])
    outputs = session.run(None, {session.get_inputs()[0].name: x})
    saliency = outputs[0][0][0]
    lo, hi = float(saliency.min()), float(saliency.max())
    saliency = (saliency - lo) / (hi - lo) if hi > lo else np.zeros_like(saliency)

    alpha = Image.fromarray((saliency * 255.0).astype(np.uint8), 'L').resize((w, h), Image.LANCZOS)
    mask = alpha.point(lambda v: 255 if v >= 128 else 0)
    bbox = mask.getbbox()
    if not bbox:
        print('FATAL: the model returned an empty mask - nothing survived the cut')
        return 3
    share = sum(mask.histogram()[128:]) / float(w * h)
    print('subject is %.1f%% of the frame, bounding box %s' % (100.0 * share, bbox))
    if share > 0.97:
        print('WARNING: the model kept almost the whole frame - the cut may not have happened. '
              'Downstream would then reconstruct the background too.')

    cut = Image.open(SRC).convert('RGBA')
    cut.putalpha(mask)
    stem = os.path.splitext(os.path.basename(SRC))[0]
    out_dir = os.path.join(DST_DIR, 'prep')
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, stem + '_cut.png')
    cut.save(path)
    print('wrote %s (%dx%d RGBA)' % (path, w, h))
    return 0


if __name__ == '__main__':
    sys.exit(main())
