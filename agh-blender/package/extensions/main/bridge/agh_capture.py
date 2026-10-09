"""P0-4: offscreen viewport capture + standard-library PNG encoder.

`v1.1` requires: one GPU colour-management pass, then a PNG written with the
standard library only (zlib + struct, scanline filter 0). No Pillow, no
`save_render`, no intermediate image datablock.

Everything here must run on Blender's main thread: `draw_view3d` needs a real
3D View space and region, and GPU drawing is main-thread only.
"""

import array
import hashlib
import math
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


# Object types that carry geometry, i.e. the ones worth framing. Kept in step with
# agh_ops._GEOMETRY_TYPES: cameras, lights and empties have nothing to frame.
FRAMABLE_TYPES = ('MESH', 'CURVE', 'SURFACE', 'META', 'FONT')


def scene_bounds(scene):
    """World-space bounding box of everything framable: (center, radius, count).

    `radius` is the radius of a sphere around the centre that contains every corner, which
    is what a fit needs: framing on the box's half-diagonal in one direction would clip a
    model that is tall in another.
    """
    from mathutils import Vector

    minimum = [float('inf')] * 3
    maximum = [float('-inf')] * 3
    count = 0
    for item in scene.objects:
        if item.type not in FRAMABLE_TYPES:
            continue
        try:
            if not item.visible_get():
                continue
        except Exception:
            pass
        matrix = item.matrix_world
        for corner in item.bound_box:
            point = matrix @ Vector((corner[0], corner[1], corner[2]))
            for axis in range(3):
                if point[axis] < minimum[axis]:
                    minimum[axis] = point[axis]
                if point[axis] > maximum[axis]:
                    maximum[axis] = point[axis]
        count += 1
    if count == 0:
        return None, None, 0, None, None
    center = [(minimum[i] + maximum[i]) / 2.0 for i in range(3)]
    # A sphere around the box, so no axis clips regardless of view direction. Taking only the
    # largest axis here would clip a model that is tall in a different direction.
    radius = math.sqrt(sum(((maximum[i] - minimum[i]) / 2.0) ** 2 for i in range(3)))
    if radius <= 0:
        radius = 1e-6
    return center, radius, count, minimum, maximum


def fit_view_to_bounds(space, center, radius, out_w, out_h, margin=1.15):
    """Point the region's view at the bounds from a fixed direction and back off until they fit.

    Deterministic on purpose: bpy.ops.view3d.view_selected() would be the canonical fit, but
    an operator can fail its poll and then the caller silently gets an unframed image again --
    which is the defect this exists to fix. The maths is stated here so the result is checkable.
    """
    from mathutils import Vector

    r3d = space.region_3d
    # A fixed three-quarter direction: front, slightly above. Constant across runs, which is
    # what makes two captures comparable.
    direction = Vector((0.0, 1.0, -0.35)).normalized()
    r3d.view_rotation = direction.to_track_quat('-Z', 'Y')
    r3d.view_location = Vector((center[0], center[1], center[2]))

    lens = float(getattr(space, 'lens', 50.0) or 50.0)
    sensor = float(getattr(space, 'sensor_width', 36.0) or 36.0)
    # Pin the sensor to the horizontal axis. Blender's default sensor_fit is 'AUTO', which maps
    # sensor_width to whichever image dimension is LARGER -- so in a portrait frame the formula
    # below would attribute 36mm to the wrong axis and under-estimate the limiting angle, letting
    # the model clip. Pinning it makes the maths below exact instead of approximate.
    if hasattr(space, 'sensor_fit'):
        space.sensor_fit = 'HORIZONTAL'
    fov_x = 2.0 * math.atan(sensor / (2.0 * lens))
    aspect = (float(out_h) / float(out_w)) if out_w else 1.0
    fov_y = 2.0 * math.atan(math.tan(fov_x / 2.0) * aspect)
    half = min(fov_x, fov_y) / 2.0
    distance = (radius / math.sin(half)) * margin if half > 0 else radius * 3.0
    r3d.view_distance = distance
    was_ortho = not bool(getattr(r3d, 'is_perspective', True))
    if was_ortho:
        # An orthographic region ignores view_distance entirely, so the fit would silently do
        # nothing. Switch to perspective and say so in the report.
        r3d.is_perspective = True
    return {
        'center': [round(v, 6) for v in center],
        'radius': round(radius, 6),
        'viewDistance': round(distance, 6),
        'fovDegrees': round(math.degrees(half) * 2.0, 4),
        'margin': margin,
        'sensorFit': 'HORIZONTAL',
        'wasOrthographic': was_ortho,
    }


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


def _perspective_matrix(fov_y, aspect, near, far):
    """Standard GL perspective projection.

    Built by hand because Blender 5.2's mathutils has no Matrix.Perspective (measured: the
    attribute does not exist). View space looks down -Z, hence the -1 in the fourth row.
    """
    from mathutils import Matrix

    f = 1.0 / math.tan(fov_y / 2.0) if fov_y > 0 else 1.0
    matrix = Matrix.Identity(4)
    matrix[0][0] = (f / aspect) if aspect else f
    matrix[1][1] = f
    matrix[2][2] = (far + near) / (near - far)
    matrix[2][3] = (2.0 * far * near) / (near - far)
    matrix[3][2] = -1.0
    matrix[3][3] = 0.0
    return matrix


def framed_matrices(space, center, radius, out_w, out_h, margin=1.15):
    """Deterministic view and projection matrices that frame the bounds.

    Measured 2026-10-09: writing region_3d.view_location/view_rotation/view_distance and then
    reading region_3d.view_matrix back returns the STALE matrices -- without a redraw the region
    never recomputes them, so frame='all' and frame='none' produced byte-identical images. The
    fit was therefore a no-op. The matrices are built here instead and handed to draw_view3d
    directly, which also makes two captures of two runs comparable by construction.
    """
    from mathutils import Matrix, Vector

    direction = Vector((0.0, 1.0, -0.35)).normalized()
    lens = float(getattr(space, 'lens', 50.0) or 50.0)
    sensor = float(getattr(space, 'sensor_width', 36.0) or 36.0)
    fov_x = 2.0 * math.atan(sensor / (2.0 * lens))
    aspect = (float(out_h) / float(out_w)) if out_w else 1.0
    fov_y = 2.0 * math.atan(math.tan(fov_x / 2.0) * aspect)
    half = min(fov_x, fov_y) / 2.0
    distance = (radius / math.sin(half)) * margin if half > 0 else radius * 3.0

    rotation = direction.to_track_quat('-Z', 'Y').to_matrix().to_4x4()
    eye = Vector((center[0], center[1], center[2])) - direction * distance
    view = (Matrix.Translation(eye) @ rotation).inverted()
    near = max(0.01, distance - radius * 2.0)
    far = distance + radius * 4.0 + 1.0
    projection = _perspective_matrix(fov_y, (float(out_w) / float(out_h)) if out_h else 1.0, near, far)
    return view, projection, {
        'center': [round(v, 6) for v in center],
        'radius': round(radius, 6),
        'viewDistance': round(distance, 6),
        'fovDegrees': round(math.degrees(fov_y), 4),
        'margin': margin,
        'direction': [round(v, 6) for v in direction],
        'eye': [round(v, 6) for v in eye],
        'clip': {'near': round(near, 6), 'far': round(far, 6)},
        'matrices': 'built here (the region cache is stale without a redraw)',
    }


def _project_box(view_matrix, projection, low, high, width, height):
    """Where the framed bounds land in the image, in pixels.

    Geometric on purpose. A viewport render also contains the floor grid, the axes and the
    gizmos, so a colour-based "how much of the image is not background" measurement counts all
    of that and is not comparable between two runs. Projecting the eight corners with the very
    matrices handed to draw_view3d answers the two questions a reviewer actually has: does the
    subject touch the frame, and how much of the frame does it cover.
    """
    from mathutils import Vector

    xs = []
    ys = []
    for index in range(8):
        corner = Vector((
            low[0] if (index & 1) else high[0],
            low[1] if (index & 2) else high[1],
            low[2] if (index & 4) else high[2],
        ))
        clip = projection @ (view_matrix @ corner.to_4d())
        w = clip[3] if abs(clip[3]) > 1e-9 else 1e-9
        xs.append(((clip[0] / w) * 0.5 + 0.5) * width)
        ys.append((1.0 - ((clip[1] / w) * 0.5 + 0.5)) * height)  # PNG rows run top-down
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    box_w = max(0.0, max_x - min_x)
    box_h = max(0.0, max_y - min_y)
    fraction = (box_w * box_h) / float(width * height) if width and height else None
    return {
        'pixelBox': {
            'minX': round(min_x, 2), 'minY': round(min_y, 2),
            'maxX': round(max_x, 2), 'maxY': round(max_y, 2),
        },
        'coveredFraction': round(fraction, 6) if fraction is not None else None,
        'touchesEdges': bool(min_x <= 1.0 or min_y <= 1.0 or max_x >= width - 1.0 or max_y >= height - 1.0),
        'clipped': bool(min_x < 0.0 or min_y < 0.0 or max_x > width or max_y > height),
        'method': 'projected bounding box (the frame also contains a grid, which a colour-based measure would count as content)',
    }


def _ink_fraction(rows, width, height, step_x=4, step_y=2, tolerance=24):
    """Best-effort share of pixels that differ from their row's background.

    The viewport background is a vertical gradient, so a single reference colour cannot work;
    within one row it is constant, so each row is compared against its own leftmost pixel. This
    still counts the grid and the gizmos, so treat it as an upper bound -- prefer
    coveredFraction when comparing two runs.
    """
    ink = 0
    sampled = 0
    for y in range(0, height, step_y):
        row = rows[y]
        if len(row) < 3:
            continue
        ref_r, ref_g, ref_b = row[0], row[1], row[2]
        for x in range(0, width, step_x):
            base = x * 3
            if (abs(row[base] - ref_r) > tolerance
                    or abs(row[base + 1] - ref_g) > tolerance
                    or abs(row[base + 2] - ref_b) > tolerance):
                ink += 1
            sampled += 1
    return round(ink / float(sampled), 6) if sampled else None


def _ink_box(rows, width, height, step_x=2, step_y=2, tolerance=24):
    """Content bounding box measured from the pixels, as fractions of the image.

    Independent of the projection maths on purpose: if the hand-built matrices are wrong, the
    geometric box and this one disagree, and that disagreement is the signal. Grid lines and
    gizmos are included, so treat the box as an outer bound.
    """
    min_x = min_y = None
    max_x = max_y = -1
    for y in range(0, height, step_y):
        row = rows[y]
        if len(row) < 3:
            continue
        ref_r, ref_g, ref_b = row[0], row[1], row[2]
        hit = False
        for x in range(0, width, step_x):
            base = x * 3
            if (abs(row[base] - ref_r) > tolerance
                    or abs(row[base + 1] - ref_g) > tolerance
                    or abs(row[base + 2] - ref_b) > tolerance):
                hit = True
                if min_x is None or x < min_x:
                    min_x = x
                if x > max_x:
                    max_x = x
        if hit:
            if min_y is None or y < min_y:
                min_y = y
            max_y = y
    if min_x is None:
        return {'empty': True}
    return {
        'empty': False,
        'minX': round(min_x / float(width), 4), 'minY': round(min_y / float(height), 4),
        'maxX': round(max_x / float(width), 4), 'maxY': round(max_y / float(height), 4),
        'touchesEdges': bool(min_x <= 1 or min_y <= 1 or max_x >= width - 2 or max_y >= height - 2),
        'areaFraction': round(((max_x - min_x + 1) * (max_y - min_y + 1)) / float(width * height), 6),
    }


def capture_viewport(instance_dir, width=None, height=None, color_management=True, frame='all'):
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
    framing = None
    try:
        # Frame the scene before reading the matrices. Without this, the capture renders
        # whatever the region happened to be looking at (typically the startup view near the
        # origin), so a model built away from the origin lands outside the frame -- and two
        # captures of two different runs are not comparable, which is the whole point of a
        # review image.
        center, radius, framable, low, high = scene_bounds(bpy.context.scene)
        if frame != 'none' and framable > 0:
            view_matrix, projection, framing = framed_matrices(space, center, radius, out_w, out_h)
            framing['objectsFramed'] = framable
        else:
            # The unframed path keeps whatever the region happens to be looking at. It is the
            # defect this feature exists to remove, so it has to be asked for explicitly.
            framing = {'objectsFramed': 0, 'note': 'framing disabled; the region view is used as-is'}
            view_matrix = space.region_3d.view_matrix
            projection = space.region_3d.window_matrix
        # Project the very matrices that are handed to draw_view3d, so the reported box describes
        # the image that is actually rendered.
        coverage = _project_box(view_matrix, projection, low, high, out_w, out_h) if low is not None else None
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
        'framing': framing,
        'bounds': {
            'min': [round(v, 6) for v in low] if low is not None else None,
            'max': [round(v, 6) for v in high] if high is not None else None,
            'center': [round(v, 6) for v in center] if center is not None else None,
            'radius': round(radius, 6) if radius is not None else None,
        },
        'coveredFraction': (coverage or {}).get('coveredFraction'),
        'touchesEdges': (coverage or {}).get('touchesEdges'),
        'coverage': dict(coverage or {}, inkFraction=_ink_fraction(rows, out_w, out_h), inkBox=_ink_box(rows, out_w, out_h)),
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
