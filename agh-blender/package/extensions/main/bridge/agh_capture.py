"""P0-4: offscreen viewport capture + standard-library PNG encoder.

`v1.1` requires: one GPU colour-management pass, then a PNG written with the
standard library only (zlib + struct, scanline filter 0). No Pillow, no
`save_render`, no intermediate image datablock.

Everything here must run on Blender's main thread: `draw_view3d` needs a real
3D View space and region, and GPU drawing is main-thread only.
"""

import array
import hashlib
import os
import struct
import time
import uuid
import zlib

import bpy

try:
    import gpu
except ImportError:  # pragma: no cover
    gpu = None


# --------------------------------------------------------------------------- PNG


def _chunk(tag, payload):
    return (
        struct.pack('>I', len(payload))
        + tag
        + payload
        + struct.pack('>I', zlib.crc32(tag + payload) & 0xFFFFFFFF)
    )


def encode_png(width, height, rows, color_type=2):
    """rows: top-down sequence of bytes, each exactly width * channels long."""
    channels = 3 if color_type == 2 else 4
    expected = width * channels
    for index, row in enumerate(rows):
        if len(row) != expected:
            raise ValueError('row %d has %d bytes, expected %d' % (index, len(row), expected))
    ihdr = struct.pack('>IIBBBBB', width, height, 8, color_type, 0, 0, 0)
    raw = bytearray()
    for row in rows:
        raw.append(0)  # filter type 0 (None) for every scanline
        raw += row
    body = zlib.compress(bytes(raw), 6)
    return b''.join(
        [
            b'\x89PNG\r\n\x1a\n',
            _chunk(b'IHDR', ihdr),
            _chunk(b'IDAT', body),
            _chunk(b'IEND', b''),
        ]
    )


# ---------------------------------------------------------------- viewport capture


def find_view3d():
    """The first drawable 3D View: (window, screen, area, region, space)."""
    manager = getattr(bpy.context, 'window_manager', None)
    if manager is None:
        return None
    for window in manager.windows:
        screen = window.screen
        if screen is None:
            continue
        for area in screen.areas:
            if area.type != 'VIEW_3D':
                continue
            region = next((r for r in area.regions if r.type == 'WINDOW'), None)
            space = area.spaces.active
            if region is None or space is None or region.width < 8 or region.height < 8:
                continue
            return window, screen, area, region, space
    return None


def _band_mean(rows, width, height, channels, top):
    band = max(1, height // 10)
    picks = range(0, band) if top else range(height - band, height)
    total = 0
    count = 0
    for y in picks:
        row = rows[y]
        for x in range(0, width * channels, channels):
            total += row[x] + row[x + 1] + row[x + 2]
            count += 3
    return round(total / count, 3) if count else None


def capture_viewport(instance_dir, width=None, height=None, color_management=True):
    if gpu is None:
        raise RuntimeError('the gpu module is unavailable in this build')
    found = find_view3d()
    if found is None:
        raise RuntimeError('no VIEW_3D area with a WINDOW region (capture needs the GUI)')
    _window, _screen, _area, region, space = found

    out_w = int(width or region.width)
    out_h = int(height or region.height)
    if out_w < 16 or out_h < 16:
        raise ValueError('requested size is too small: %dx%d' % (out_w, out_h))
    out_w = min(out_w, 4096)
    out_h = min(out_h, 4096)

    offscreen = gpu.types.GPUOffScreen(out_w, out_h)
    try:
        view_matrix = space.region_3d.view_matrix
        projection = space.region_3d.window_matrix
        with offscreen.bind():
            frame_buffer = gpu.state.active_framebuffer_get()
            frame_buffer.clear(color=(0.0, 0.0, 0.0, 1.0))
            offscreen.draw_view3d(
                bpy.context.scene,
                bpy.context.view_layer,
                space,
                region,
                view_matrix,
                projection,
                do_color_management=bool(color_management),
                draw_background=True,
            )
            buffer = frame_buffer.read_color(0, 0, out_w, out_h, 4, 0, 'UBYTE')
            try:
                buffer.dimensions = out_w * out_h * 4
            except Exception:
                pass
            pixels = bytes(buffer)
    finally:
        offscreen.free()

    if len(pixels) != out_w * out_h * 4:
        raise RuntimeError('read_color returned %d bytes, expected %d' % (len(pixels), out_w * out_h * 4))

    # GL's origin is bottom-left, PNG wants top-down: walk the rows backwards and
    # drop the alpha byte with a C-level slice delete instead of a Python loop.
    rows = []
    stride = out_w * 4
    for y in range(out_h - 1, -1, -1):
        row = array.array('B', pixels[y * stride : (y + 1) * stride])
        del row[3::4]
        rows.append(row.tobytes())

    png = encode_png(out_w, out_h, rows, color_type=2)

    captures = os.path.join(instance_dir, 'captures')
    os.makedirs(captures, exist_ok=True)
    name = '%s.png' % uuid.uuid4()
    path = os.path.join(captures, name)
    temp = path + '.tmp'
    with open(temp, 'wb') as handle:
        handle.write(png)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)

    sample = rows[len(rows) // 2]
    return {
        'ok': True,
        'path': path,
        'file': name,
        'width': out_w,
        'height': out_h,
        'channels': 3,
        'colorManagement': bool(color_management),
        'bytes': len(png),
        'sha256': hashlib.sha256(png).hexdigest(),
        'source': {'area': 'VIEW_3D', 'regionWidth': region.width, 'regionHeight': region.height},
        'rowOrder': 'top-down',
        'origin': 'GL bottom-left, flipped once',
        'stats': {
            # Rough orientation probe: the default theme darkens the viewport
            # towards the bottom, so the top band should read brighter.
            'topBandMean': _band_mean(rows, out_w, out_h, 3, True),
            'bottomBandMean': _band_mean(rows, out_w, out_h, 3, False),
            'middleRowFirstPixels': list(sample[:12]),
        },
        'capturedAt': time.time(),
    }
