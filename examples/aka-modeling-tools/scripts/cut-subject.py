"""
cut-subject.py -- take a photograph with a flat background and write an RGBA cut-out.

Why this exists (and why it is not rembg): the generator reconstructs whatever it is given,
so a photo with a background becomes a model OF the background too. rembg hung silently on
this machine (downloading u2net), and a 170 MB segmentation model is a lot of machinery for
photos whose background is a single flat colour - which is what screen captures and product
shots are.

Method: flood fill inward from every border pixel, absorbing pixels within `--tolerance`
of the local border colour. Whatever the fill cannot reach is the subject. No model, no
download, deterministic, and the answer is inspectable (the script prints how much it ate).

    python cut-subject.py <src> <dst-dir> [--tolerance 24] [--fill 0.9]

Writes <dst-dir>/<stem>_cut.png: RGBA, subject cropped tight and composited on a mid-grey
canvas at `--fill` of the canvas (the convention TripoSR's own prep uses). If the source
already carries a usable alpha channel, that is used instead - a cut-out is a cut-out.
"""
import sys
import os
from collections import deque

from PIL import Image

SRC, DST_DIR = sys.argv[1], sys.argv[2]
TOL = 24
FILL = 0.9
for i, a in enumerate(sys.argv):
    if a == '--tolerance':
        TOL = int(sys.argv[i + 1])
    if a == '--fill':
        FILL = float(sys.argv[i + 1])


def subject_from_alpha(img):
    """Use a real alpha channel when there is one: it is the author's own cut, not a guess."""
    alpha = img.split()[-1]
    return alpha.point(lambda v: 255 if v > 8 else 0)


def subject_by_floodfill(img):
    """BFS from the borders, absorbing pixels close to the border colour."""
    w, h = img.size
    px = img.convert('RGB').load()
    # The background colour is whatever the frame is mostly made of: sample the four edges.
    samples = [px[x, 0] for x in range(0, w, max(1, w // 64))]
    samples += [px[x, h - 1] for x in range(0, w, max(1, w // 64))]
    samples += [px[0, y] for y in range(0, h, max(1, h // 64))]
    samples += [px[w - 1, y] for y in range(0, h, max(1, h // 64))]
    bg = tuple(sum(s[i] for s in samples) // len(samples) for i in range(3))

    def close(p):
        return abs(p[0] - bg[0]) <= TOL and abs(p[1] - bg[1]) <= TOL and abs(p[2] - bg[2]) <= TOL

    outside = bytearray(w * h)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if close(px[x, y]) and not outside[y * w + x]:
                outside[y * w + x] = 1
                q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if close(px[x, y]) and not outside[y * w + x]:
                outside[y * w + x] = 1
                q.append((x, y))
    while q:
        x, y = q.popleft()
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < w and 0 <= ny < h:
                idx = ny * w + nx
                if not outside[idx] and close(px[nx, ny]):
                    outside[idx] = 1
                    q.append((nx, ny))

    mask = Image.new('L', (w, h), 255)
    mp = mask.load()
    for y in range(h):
        row = y * w
        for x in range(w):
            if outside[row + x]:
                mp[x, y] = 0
    return mask, bg, sum(outside) / float(w * h)


src = Image.open(SRC)
if src.mode in ('RGBA', 'LA') and src.split()[-1].getextrema()[0] < 250:
    mask = subject_from_alpha(src)
    bg, ate = (128, 128, 128), None
    print('source already carries alpha: using it as the cut')
else:
    mask, bg, ate = subject_by_floodfill(src)
    print('background colour sampled from the frame: rgb%s' % (bg,))
    print('flood fill ate %.1f%% of the frame' % (100.0 * ate,))
    if ate > 0.97:
        print('WARNING: the fill ate almost everything - the background may not be flat, '
              'and the "subject" may be an artefact of the tolerance. Inspect the output.')

bbox = mask.getbbox()
if not bbox:
    print('FATAL: nothing survived the cut (no subject found)')
    sys.exit(3)
print('subject bounding box: %dx%d at %s' % (bbox[2] - bbox[0], bbox[3] - bbox[1], bbox))

# Composite on mid-grey with the subject at FILL of the canvas - the convention prep uses.
subj = src.convert('RGBA').crop(bbox)
sw, sh = subj.size
canvas = 512
scale = min(canvas * FILL / sw, canvas * FILL / sh)
size = (max(1, int(sw * scale)), max(1, int(sh * scale)))
subj = subj.resize(size, Image.LANCZOS)
# Re-cut after the resize so the edge stays clean.
subj.putalpha(subj.split()[-1].point(lambda v: 255 if v > 8 else 0))
out = Image.new('RGBA', (canvas, canvas), (128, 128, 128, 255))
out.paste(subj, ((canvas - size[0]) // 2, (canvas - size[1]) // 2), subj)

stem = os.path.splitext(os.path.basename(SRC))[0]
os.makedirs(DST_DIR, exist_ok=True)
path = os.path.join(DST_DIR, stem + '_cut.png')
out.save(path)
print('wrote %s (%dx%d, subject %dx%d px)' % (path, canvas, canvas, size[0], size[1]))
