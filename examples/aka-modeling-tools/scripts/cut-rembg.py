"""
cut-rembg.py -- subject extraction with a class-agnostic model, called by mesh_run's
`preprocessCommand`.

Why a model and not a heuristic: the generator reconstructs whatever it is handed, so a
photograph with a background becomes a model OF the background. Flood-filling a flat colour
works only when the background is flat (measured: 4.1% eaten on a gradient background, i.e.
it did nothing) - for "any image" you need a salient-object model, and that model's weights
have to be local.

Why the weights must be PRE-DOWNLOADED: the first attempt at rembg hung silently, because
it fetches the model at run time. `new_session()` below reads from `U2NET_HOME`; if the file
is there it never touches the network.

    pip install rembg onnxruntime        (into D:\\triposr-venv)
    # weights: isnet-general-use.onnx (~176 MB) into %USERPROFILE%\\.u2net\\
    setx U2NET_HOME %USERPROFILE%\\.u2net

Usage (the tool substitutes the placeholders):
    python cut-rembg.py {image} {out}

Writes <out>/prep/<stem>_cut.png: the source, RGBA, background transparent, NOT cropped and
NOT rescaled - the generator wrapper's own prep does the cropping and the grey compositing,
so doing it twice would only blur things. Prints how much of the frame survived, which is
the number a human needs to judge whether the cut is plausible.
"""
import os
import sys

from PIL import Image

SRC, DST_DIR = sys.argv[1], sys.argv[2]
MODEL = os.environ.get('REMBG_MODEL', 'isnet-general-use')


def main():
    try:
        from rembg import remove, new_session
    except ImportError:
        print('FATAL: rembg is not installed in this interpreter. Run: pip install rembg onnxruntime')
        return 2
    home = os.environ.get('U2NET_HOME')
    if not home or not os.path.isdir(home):
        print('FATAL: U2NET_HOME is not set to an existing directory, so rembg would try to '
              'download the model at run time (that is the hang this script exists to avoid).')
        return 2
    try:
        session = new_session(MODEL)
    except Exception as error:  # noqa: BLE001 - the message is the point
        print('FATAL: could not load model "%s" from %s: %s' % (MODEL, home, error))
        return 2

    img = Image.open(SRC).convert('RGBA')
    cut = remove(img, session=session)
    mask = cut.split()[-1]
    bbox = mask.getbbox()
    if not bbox:
        print('FATAL: the model returned an empty mask - nothing survived the cut')
        return 3
    pixels = mask.histogram()[128:]          # pixels the model called "subject"
    share = sum(pixels) / float(mask.size[0] * mask.size[1])
    print('model %s: subject is %.1f%% of the frame, bounding box %s'
          % (MODEL, 100.0 * share, bbox))
    if share > 0.97:
        print('WARNING: the model kept almost the whole frame - the cut may not have happened. '
              'Downstream would then reconstruct the background too.')

    stem = os.path.splitext(os.path.basename(SRC))[0]
    out_dir = os.path.join(DST_DIR, 'prep')
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, stem + '_cut.png')
    cut.save(path)
    print('wrote %s (%dx%d RGBA)' % (path, cut.size[0], cut.size[1]))
    return 0


if __name__ == '__main__':
    sys.exit(main())
