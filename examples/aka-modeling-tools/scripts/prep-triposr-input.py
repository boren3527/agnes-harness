"""Prepare TripoSR inputs: gray background, foreground filling ~90% of a square canvas.

Why: TripoSR's default path calls rembg, which downloads u2net on first use from a
network this machine cannot reach without the proxy -> it hangs silently. With
--no-remove-bg the README asks for "an RGB image with gray background and
properly-sized foreground", which is exactly what this produces.

  python prep-triposr-input.py OUTDIR IN1 [IN2 ...]
"""
import os
import sys

from PIL import Image

GRAY = (127, 127, 127)
CANVAS = 512
FILL = 0.90

out_dir = sys.argv[1]
inputs = sys.argv[2:]
os.makedirs(out_dir, exist_ok=True)

for src in inputs:
    img = Image.open(src)
    if img.mode in ("RGBA", "LA"):
        rgba = img.convert("RGBA")
        alpha = rgba.getchannel("A")
        box = alpha.point(lambda a: 255 if a > 10 else 0).getbbox()
        if box:
            rgba = rgba.crop(box)
        flat = Image.new("RGB", rgba.size, GRAY)
        flat.paste(rgba, (0, 0), rgba)
        obj = flat
    else:
        obj = img.convert("RGB")
        if obj.size != (CANVAS, CANVAS):
            side = max(obj.size)
            obj = obj.resize((int(obj.width * CANVAS * FILL / side), int(obj.height * CANVAS * FILL / side)), Image.LANCZOS)
            obj = obj.crop(obj.getbbox() or (0, 0, obj.width, obj.height))
    scale = CANVAS * FILL / max(obj.size)
    obj = obj.resize((max(1, int(obj.width * scale)), max(1, int(obj.height * scale))), Image.LANCZOS)
    canvas = Image.new("RGB", (CANVAS, CANVAS), GRAY)
    canvas.paste(obj, ((CANVAS - obj.width) // 2, (CANVAS - obj.height) // 2))
    name = os.path.splitext(os.path.basename(src))[0] + '_prep.png'
    dest = os.path.join(out_dir, name)
    canvas.save(dest)
    print(f'{src} -> {dest}  ({canvas.width}x{canvas.height}, foreground {obj.width}x{obj.height})')
