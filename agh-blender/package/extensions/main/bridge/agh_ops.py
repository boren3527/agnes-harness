"""P1 (第 ④ 环): structured opcode whitelist for the Blender side.

The whole point of this module is that nothing outside the table below can run.
`/op` accepts JSON, this module validates it against a small declarative schema,
and only then does a fixed function run. There is no eval, no getattr by name,
and no way for the caller to name a Python symbol.

Every op runs on Blender's main thread and is expected to be small, reversible by
Ctrl+Z (the caller pushes an undo step) and cheap to re-apply (ops are written to
be idempotent when their target already exists, unless `replace` says otherwise).
"""

import math
import os

import bpy
from mathutils import Matrix, Vector

# --------------------------------------------------------------------------- schema

MAX_OPS_PER_BATCH = 64
MAX_OBJECTS = 512


class OpError(Exception):
    """Rejection with a machine-readable code; never a traceback to the caller."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def _num(value, path):
    # bool is an int in Python; reject it explicitly so True never becomes 1.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise OpError('E_ARG_TYPE', '%s must be a number' % path)
    if not math.isfinite(value):
        raise OpError('E_ARG_TYPE', '%s must be finite' % path)
    return float(value)


def _vec(value, path, length, minimum=None, maximum=None):
    if not isinstance(value, (list, tuple)) or len(value) != length:
        raise OpError('E_ARG_TYPE', '%s must be a list of %d numbers' % (path, length))
    out = []
    for index, item in enumerate(value):
        number = _num(item, '%s[%d]' % (path, index))
        if minimum is not None and number < minimum:
            raise OpError('E_ARG_RANGE', '%s[%d] below %s' % (path, index, minimum))
        if maximum is not None and number > maximum:
            raise OpError('E_ARG_RANGE', '%s[%d] above %s' % (path, index, maximum))
        out.append(number)
    return out


def _name(value, path):
    if not isinstance(value, str):
        raise OpError('E_ARG_TYPE', '%s must be a string' % path)
    text = value.strip()
    if not text or len(text) > 96:
        raise OpError('E_ARG_RANGE', '%s must be 1..96 characters' % path)
    if not all(character.isalnum() or character in '_-.' for character in text):
        raise OpError('E_ARG_CHARSET', '%s allows letters, digits, _ - . only' % path)
    return text


def _enum(value, path, allowed):
    if value not in allowed:
        raise OpError('E_ARG_ENUM', '%s must be one of %s' % (path, ', '.join(sorted(allowed))))
    return value


def _flag(value, path):
    if not isinstance(value, bool):
        raise OpError('E_ARG_TYPE', '%s must be a boolean' % path)
    return value


def _color(value, path):
    triple = _vec(value, path, 3, 0.0, 1.0)
    return triple


# --------------------------------------------------------------------------- helpers


def _object(name):
    target = bpy.data.objects.get(name)
    if target is None:
        raise OpError('E_NO_SUCH_OBJECT', 'no object named %s' % name)
    return target


def _material(name):
    found = bpy.data.materials.get(name)
    if found is not None:
        return found
    if len(bpy.data.materials) > 4096:
        raise OpError('E_LIMIT', 'too many materials in this file')
    return bpy.data.materials.new(name)


def _ensure_principled(material):
    # A brand new material already carries a Principled BSDF in 4.x/5.x, but a
    # material loaded from an older file may not.
    if material.use_nodes and material.node_tree is not None:
        for node in material.node_tree.nodes:
            if node.type == 'BSDF_PRINCIPLED':
                return node
    material.use_nodes = True
    node = material.node_tree.nodes.new('ShaderNodeBsdfPrincipled')
    output = next((n for n in material.node_tree.nodes if n.type == 'OUTPUT_MATERIAL'), None)
    if output is None:
        output = material.node_tree.nodes.new('ShaderNodeOutputMaterial')
    material.node_tree.links.new(node.outputs['BSDF'], output.inputs['Surface'])
    return node


def _counts():
    return len(bpy.data.objects)


# --------------------------------------------------------------------------- ops
# Each entry: (spec, apply). `spec` drives validation; `apply` gets already-validated
# values and must return a small JSON-able delta.

PRIMITIVE_KINDS = ('cube', 'uv_sphere', 'cylinder', 'cone', 'torus', 'plane')

# The capability face this module publishes, so a consumer can name what it actually observed
# instead of inferring it from the package version (which drifts silently: 0.1.7 vs 0.1.8 was caught
# exactly that way). Bump CAPABILITY_SET whenever the primitive kinds, the op table or the limits
# change. `primitives` is emitted from PRIMITIVE_KINDS, the same tuple that validates `kind`, so the
# published list and the enforced enum cannot disagree.
CAPABILITY_SET = 'primitives-%d' % len(PRIMITIVE_KINDS)


def _op_primitive_add(args):
    kind = _enum(args.get('kind'), 'kind', PRIMITIVE_KINDS)
    name = _name(args.get('name'), 'name')
    if len(bpy.data.objects) >= MAX_OBJECTS:
        raise OpError('E_LIMIT', 'object budget exhausted')
    replace = _flag(args.get('replace', False), 'replace')
    size = _num(args.get('size', 1.0), 'size') if 'size' in args else 1.0
    if size <= 0 or size > 1000:
        raise OpError('E_ARG_RANGE', 'size must be in (0, 1000]')
    location = _vec(args.get('location', [0, 0, 0]), 'location', 3, -10000.0, 10000.0)
    rotation = _vec(args.get('rotation_euler', [0, 0, 0]), 'rotation_euler', 3)
    scale = _vec(args.get('scale', [1, 1, 1]), 'scale', 3, 1e-6, 10000.0)

    if kind == 'cube':
        bpy.ops.mesh.primitive_cube_add(size=size)
    elif kind == 'uv_sphere':
        bpy.ops.mesh.primitive_uv_sphere_add(radius=size / 2.0)
    elif kind == 'cylinder':
        bpy.ops.mesh.primitive_cylinder_add(radius=size / 2.0, depth=size)
    elif kind == 'cone':
        bpy.ops.mesh.primitive_cone_add(radius1=size / 2.0, depth=size)
    elif kind == 'torus':
        bpy.ops.mesh.primitive_torus_add(major_radius=size / 2.0, minor_radius=size / 8.0)
    else:
        bpy.ops.mesh.primitive_plane_add(size=size)

    created = bpy.context.active_object
    if created is None:
        raise OpError('E_INTERNAL', 'primitive operator produced no active object')

    previous = bpy.data.objects.get(name)
    if previous is not None and previous is not created:
        if replace:
            bpy.data.objects.remove(previous, do_unlink=True)
        else:
            bpy.data.objects.remove(created, do_unlink=True)
            raise OpError('E_NAME_TAKEN', 'object %s already exists (pass replace=true)' % name)
    created.name = name
    created.location = location
    created.rotation_euler = rotation
    created.scale = scale

    material_name = args.get('material')
    if material_name is not None:
        created.data.materials.append(_material(_name(material_name, 'material')))
    return {'created': name, 'kind': kind, 'objectCount': _counts()}


def _op_transform(args):
    target = _object(_name(args.get('name'), 'name'))
    changed = []
    for key in ('location', 'rotation_euler', 'scale'):
        if key in args:
            value = _vec(args[key], key, 3)
            if key == 'scale' and min(value) <= 0:
                raise OpError('E_ARG_RANGE', 'scale components must be positive')
            setattr(target, key, value)
            changed.append(key)
    if not changed:
        raise OpError('E_ARG_MISSING', 'transform needs at least one of location/rotation_euler/scale')
    return {'transformed': target.name, 'changed': changed, 'objectCount': _counts()}


def _op_duplicate(args):
    source = _object(_name(args.get('name'), 'name'))
    name = _name(args.get('newName'), 'newName')
    if bpy.data.objects.get(name) is not None:
        raise OpError('E_NAME_TAKEN', 'object %s already exists' % name)
    if len(bpy.data.objects) >= MAX_OBJECTS:
        raise OpError('E_LIMIT', 'object budget exhausted')
    clone = source.copy()
    if source.data is not None:
        clone.data = source.data.copy()
    bpy.context.collection.objects.link(clone)
    clone.name = name
    clone.location = [source.location[i] + _num(args.get('offset', [0, 0, 0])[i], 'offset[%d]' % i)
                      for i in range(3)] if 'offset' in args else list(source.location)
    if 'scale' in args:
        clone.scale = _vec(args['scale'], 'scale', 3, 1e-6, 10000.0)
    return {'duplicated': source.name, 'created': clone.name, 'objectCount': _counts()}


def _op_delete(args):
    target = _object(_name(args.get('name'), 'name'))
    name = target.name
    bpy.data.objects.remove(target, do_unlink=True)
    return {'deleted': name, 'objectCount': _counts()}


def _op_material_set(args):
    material = _material(_name(args.get('name'), 'name'))
    node = _ensure_principled(material)
    color = _color(args.get('color', [0.8, 0.8, 0.8]), 'color')
    node.inputs['Base Color'].default_value = (color[0], color[1], color[2], 1.0)
    if 'roughness' in args:
        node.inputs['Roughness'].default_value = _num(args['roughness'], 'roughness')
    if 'metallic' in args:
        node.inputs['Metallic'].default_value = _num(args['metallic'], 'metallic')
    if 'emission' in args:
        strength = _num(args['emission'], 'emission')
        if 'Emission Color' in node.inputs:
            node.inputs['Emission Color'].default_value = (color[0], color[1], color[2], 1.0)
        node.inputs['Emission Strength'].default_value = strength
    return {'material': material.name, 'color': color}


def _op_material_assign(args):
    target = _object(_name(args.get('name'), 'name'))
    material = _material(_name(args.get('material'), 'material'))
    if target.data is None:
        raise OpError('E_NOT_A_MESH', '%s has no mesh data' % target.name)
    target.data.materials.clear()
    target.data.materials.append(material)
    return {'assigned': material.name, 'to': target.name}


def _op_join(args):
    names = args.get('names')
    if not isinstance(names, list) or len(names) < 2 or len(names) > MAX_OPS_PER_BATCH:
        raise OpError('E_ARG_TYPE', 'names must be a list of 2..%d names' % MAX_OPS_PER_BATCH)
    targets = [_object(_name(item, 'names[]')) for item in names]
    kind = _name(args.get('name'), 'name')
    for item in bpy.context.view_layer.objects:
        item.select_set(False)
    for item in targets:
        item.select_set(True)
    bpy.context.view_layer.objects.active = targets[0]
    bpy.ops.object.join()
    merged = bpy.context.active_object
    merged.name = kind
    return {'joined': len(targets), 'name': merged.name, 'objectCount': _counts()}


INSTANCE_DIR = None


def set_instance_dir(path):
    """The bridge owns the instance directory; the ops module only needs to be told where it is."""
    global INSTANCE_DIR
    INSTANCE_DIR = path


def _sha256_file(path):
    import hashlib
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _image_report():
    """Every image path, raw and resolved — the point of a checkpoint is that the resolved path
    still lands on the original asset, not on an empty directory beside the copy."""
    report = []
    for image in bpy.data.images:
        raw = image.filepath
        if not raw:
            continue
        resolved = bpy.path.abspath(raw)
        report.append({
            'name': image.name,
            'filepath': raw,
            'resolved': resolved,
            'exists': os.path.exists(resolved),
        })
    return report


def _op_data_purge_unused(args):
    """Remove datablocks nothing references.

    Deleting an object does not delete its mesh or material: Blender keeps them until the file is
    saved and reloaded, so a long modelling session accumulates orphans. Only blocks with no users
    and no fake user are touched, and linked (library) data is never removed.
    """
    import os  # noqa: F401  (kept local so the module header stays untouched)
    dry = bool(args.get('dry', False))
    removed = {'meshes': [], 'materials': [], 'images': []}
    for label, pool in (('meshes', bpy.data.meshes), ('materials', bpy.data.materials), ('images', bpy.data.images)):
        for block in list(pool):
            if block.users == 0 and not block.use_fake_user and block.library is None:
                removed[label].append(block.name)
                if not dry:
                    pool.remove(block)
    return {
        'dry': dry,
        'removed': {name: names for name, names in removed.items() if names},
        'counts': {name: len(names) for name, names in removed.items()},
        'objectCount': _counts(),
    }


def _op_file_checkpoint(args):
    """Save a snapshot with copy=True / relative_remap=True.

    copy=True leaves bpy.data.filepath pointing at the original, so checkpointing never mutates the
    open file; relative_remap=True rewrites relative image paths so they still resolve back to the
    original project's assets instead of to an empty folder next to the copy.
    """
    if INSTANCE_DIR is None:
        raise OpError('E_NO_INSTANCE', 'the bridge has no instance directory configured')
    label = _name(args.get('label') or 'checkpoint', 'label')
    target_dir = os.path.join(INSTANCE_DIR, 'checkpoints')
    if not os.path.isdir(target_dir):
        os.makedirs(target_dir)
    target = os.path.join(target_dir, label + '.blend')
    # Never overwrite: a checkpoint that replaces an earlier one is not a checkpoint.
    if os.path.exists(target):
        raise OpError('E_TARGET_EXISTS', 'checkpoint already exists: %s (pick another label)' % target)
    before = bpy.data.filepath
    bpy.ops.wm.save_as_mainfile(
        filepath=target, copy=True, relative_remap=True, compress=False, check_existing=False,
    )
    return {
        'path': target,
        'bytes': os.path.getsize(target),
        'sha256': _sha256_file(target),
        'mainFilepathBefore': before,
        'mainFilepathAfter': bpy.data.filepath,
        'mainFileUntouched': bpy.data.filepath == before,
        'images': _image_report(),
    }


def _op_file_stage_export(args):
    """Write a fresh copy into the instance staging area, for the Host to deliver with its own
    file write (so the final write is audited and cannot overwrite anything).

    relative_remap=False on purpose: the export is a standalone artifact, so a relative path that
    would silently break outside the project is reported rather than rewritten to point somewhere
    the caller never chose.
    """
    if INSTANCE_DIR is None:
        raise OpError('E_NO_INSTANCE', 'the bridge has no instance directory configured')
    target_dir = os.path.join(INSTANCE_DIR, 'staging')
    if not os.path.isdir(target_dir):
        os.makedirs(target_dir)
    name = os.urandom(16).hex()
    if args.get('name') is not None:
        name = _name(args['name'], 'name')
    target = os.path.join(target_dir, name + '.blend')
    if os.path.exists(target):
        raise OpError('E_TARGET_EXISTS', 'staging target already exists: %s' % target)
    before = bpy.data.filepath
    images = _image_report()
    bpy.ops.wm.save_as_mainfile(
        filepath=target, copy=True, relative_remap=False, compress=False, check_existing=False,
    )
    relative = [image for image in images if image['filepath'].startswith('//')]
    return {
        'path': target,
        'bytes': os.path.getsize(target),
        'sha256': _sha256_file(target),
        'mainFilepathBefore': before,
        'mainFilepathAfter': bpy.data.filepath,
        'mainFileUntouched': bpy.data.filepath == before,
        'images': images,
        'relativeImages': relative,
        'relativeWarning': (
            'this scene has %d relative image path(s); delivering the artifact outside the project '
            'would leave them pointing at the original directory' % len(relative)
        ) if relative else None,
    }


# --------------------------------------------------------------------------- mesh.import


_IMPORT_FORMATS = {'.glb': 'gltf', '.gltf': 'gltf', '.obj': 'obj'}


def _op_mesh_import(args):
    """Import an external mesh into the managed scene.

    The caller declares the file's up axis; this op never guesses it. Measured on Blender 5.2.2:
    the glTF importer exposes no axis parameter at all -- it always applies the glTF standard
    (Y up) -- so a file that declares another up axis arrives tipped and is corrected here. The
    OBJ importer does take axis parameters and gets the declared one directly, with a fixed
    forward axis (-Y), which is the pair that round-trips against our own OBJ export.
    """
    raw_path = args.get('path')
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise OpError('E_ARG_MISSING', 'path is required')
    path = os.path.abspath(os.path.expanduser(raw_path.strip()))
    extension = os.path.splitext(path)[1].lower()
    if extension not in _IMPORT_FORMATS:
        raise OpError('E_UNSUPPORTED_FORMAT', 'only .glb, .gltf and .obj can be imported, got %s' % (extension or '(no extension)'))
    if not os.path.isfile(path):
        raise OpError('E_NO_SUCH_FILE', 'no such file: %s' % path)

    actual_bytes = os.path.getsize(path)
    declared_bytes = args.get('bytes')
    if isinstance(declared_bytes, (int, float)) and int(declared_bytes) != actual_bytes:
        raise OpError('E_BYTE_MISMATCH', 'the caller declared %s bytes but the file is %s bytes' % (int(declared_bytes), actual_bytes))
    declared_sha = args.get('sha256')
    if isinstance(declared_sha, str) and declared_sha.strip():
        actual_sha = _sha256_file(path)
        if actual_sha.lower() != declared_sha.strip().lower():
            raise OpError('E_BYTE_MISMATCH', 'the caller declared sha256 %s... but the file is %s...' % (declared_sha.strip()[:16], actual_sha[:16]))

    up_axis = _enum(str(args.get('upAxis', 'Y')).upper(), 'upAxis', ('X', 'Y', 'Z'))
    scale = 1.0 if 'scale' not in args else _num(args['scale'], 'scale')
    if scale <= 0.0:
        raise OpError('E_ARG_RANGE', 'scale must be greater than 0')

    before = set(bpy.data.objects.keys())
    if _IMPORT_FORMATS[extension] == 'gltf':
        bpy.ops.import_scene.gltf(filepath=path)
    else:
        bpy.ops.wm.obj_import(filepath=path, forward_axis='NEGATIVE_Y', up_axis=up_axis)
    created = [bpy.data.objects[name] for name in list(bpy.data.objects.keys()) if name not in before]
    meshes = [item for item in created if item.type == 'MESH']
    if not meshes:
        # Leaving the non-mesh leftovers behind would silently pollute the scene on a refusal.
        for item in created:
            try:
                bpy.data.objects.remove(item, do_unlink=True)
            except Exception:
                pass
        raise OpError('E_NO_MESH_IMPORTED', 'the file produced no mesh object (%d object(s) were created and removed)' % len(created))

    if _IMPORT_FORMATS[extension] == 'gltf' and up_axis != 'Y':
        degrees, axis = (-90.0, 'X') if up_axis == 'Z' else (90.0, 'Y')
        rotation = Matrix.Rotation(math.radians(degrees), 4, axis)
        for item in meshes:
            item.matrix_world = rotation @ item.matrix_world
    if scale != 1.0:
        resize = Matrix.Scale(scale, 4)
        for item in meshes:
            item.matrix_world = resize @ item.matrix_world

    requested_name = args.get('name')
    if isinstance(requested_name, str) and requested_name.strip():
        primary = max(meshes, key=lambda item: item.dimensions[0] * item.dimensions[1] * item.dimensions[2])
        primary.name = _name(requested_name, 'name')

    bpy.context.view_layer.update()
    lows = []
    highs = []
    for item in meshes:
        low, high = _world_bounds(item)
        lows.append(low)
        highs.append(high)
    low = [min(entry[i] for entry in lows) for i in range(3)]
    high = [max(entry[i] for entry in highs) for i in range(3)]
    dimensions = [round(high[i] - low[i], 6) for i in range(3)]
    center = [round((high[i] + low[i]) / 2.0, 6) for i in range(3)]

    result = {
        'path': path,
        'format': _IMPORT_FORMATS[extension],
        'upAxis': up_axis,
        'scale': scale,
        'bytes': actual_bytes,
        'sha256': _sha256_file(path),
        'imported': sorted(item.name for item in meshes),
        'meshCount': len(meshes),
        'dimensions': dimensions,
        'bounds': {'min': [round(v, 6) for v in low], 'max': [round(v, 6) for v in high], 'center': center},
        'objectCount': _counts(),
    }

    # size/location are the caller's expectation, not a transform: compared and reported, never
    # applied, so a mismatch cannot quietly reshape geometry the caller asked to import as-is.
    checks = {}
    if args.get('size') is not None:
        want = _vec(args['size'], 'size', 3)
        checks['size'] = {
            'requested': [round(v, 6) for v in want],
            'achieved': dimensions,
            'ok': all(abs(dimensions[i] - want[i]) <= max(1e-4, abs(want[i]) * 1e-4) for i in range(3)),
        }
    if args.get('location') is not None:
        want = _vec(args['location'], 'location', 3)
        checks['location'] = {
            'requested': [round(v, 6) for v in want],
            'achieved': center,
            'ok': all(abs(center[i] - want[i]) <= max(1e-4, abs(want[i]) * 1e-4) for i in range(3)),
        }
    if checks:
        result['selfCheck'] = checks
    return result


# --------------------------------------------------------------------------- modifiers, lights, cameras


MODIFIER_KINDS = {
    'subdivision': 'SUBSURF',
    'bevel': 'BEVEL',
    'mirror': 'MIRROR',
    'solidify': 'SOLIDIFY',
}

LIGHT_KINDS = {
    'point': 'POINT',
    'sun': 'SUN',
    'area': 'AREA',
    'spot': 'SPOT',
}

# Energy is per-kind because the units differ: a sun is irradiance in W/m^2 (single digits),
# the others are radiant power in W (tens to hundreds).
LIGHT_DEFAULT_ENERGY = {'sun': 3.0, 'point': 100.0, 'area': 100.0, 'spot': 100.0}


def _fresh_name(requested, replace):
    """Validate a requested name and refuse a collision unless replace is set."""
    if requested is None:
        return None
    label = _name(requested, 'name')
    if bpy.data.objects.get(label) is not None and not replace:
        raise OpError('E_NAME_TAKEN', 'an object named %s already exists (pass replace=true to replace it)' % label)
    return label


def _op_modifier_add(args):
    """Add a modifier to a mesh object and leave it unapplied.

    Unapplied on purpose: the modifier stays visible and editable in Blender's stack, and baking it
    would be a destructive change the caller did not ask for. Anything that reads the scene sees the
    modifier list, and an export keeps it.
    """
    target = _object(_name(args.get('name'), 'name'))
    if target.type != 'MESH':
        raise OpError('E_NOT_A_MESH', '%s is a %s, modifiers here are for meshes' % (target.name, target.type))
    kind = _enum(args.get('kind'), 'kind', tuple(sorted(MODIFIER_KINDS)))
    if len(target.modifiers) >= 64:
        raise OpError('E_LIMIT', 'too many modifiers on %s' % target.name)
    modifier = target.modifiers.new(name=MODIFIER_KINDS[kind], type=MODIFIER_KINDS[kind])
    if kind == 'subdivision':
        levels = int(_num(args.get('amount', 2), 'amount'))
        if levels < 1 or levels > 6:
            raise OpError('E_ARG_RANGE', 'subdivision amount (levels) must be 1..6')
        modifier.levels = levels
        modifier.render_levels = levels
    elif kind == 'bevel':
        modifier.width = _num(args.get('amount', 0.05), 'amount')
        segments = int(_num(args.get('segments', 2), 'segments'))
        if segments < 1 or segments > 16:
            raise OpError('E_ARG_RANGE', 'bevel segments must be 1..16')
        modifier.segments = segments
    elif kind == 'mirror':
        axis = _enum(str(args.get('axis', 'X')).upper(), 'axis', ('X', 'Y', 'Z'))
        modifier.use_axis = [axis == 'X', axis == 'Y', axis == 'Z']
    elif kind == 'solidify':
        modifier.thickness = _num(args.get('amount', 0.02), 'amount')
    bpy.context.view_layer.update()
    return {
        'name': target.name,
        'kind': kind,
        'modifier': modifier.name,
        'modifierCount': len(target.modifiers),
        'applied': False,
    }


def _op_light_add(args):
    kind = _enum(args.get('kind', 'point'), 'kind', tuple(sorted(LIGHT_KINDS)))
    replace = _flag(args['replace'], 'replace') if 'replace' in args else False
    label = _fresh_name(args.get('name'), replace)
    location = _vec(args.get('location', (0.0, 0.0, 4.0)), 'location', 3)
    if replace and label is not None:
        existing = bpy.data.objects.get(label)
        if existing is not None:
            bpy.data.objects.remove(existing, do_unlink=True)
    bpy.ops.object.light_add(type=LIGHT_KINDS[kind], location=location)
    item = bpy.context.active_object
    if label is not None:
        item.name = label
    if 'rotation_euler' in args:
        item.rotation_euler = _vec(args['rotation_euler'], 'rotation_euler', 3)
    energy = _num(args['energy'], 'energy') if 'energy' in args else LIGHT_DEFAULT_ENERGY[kind]
    if energy < 0.0:
        raise OpError('E_ARG_RANGE', 'energy must not be negative')
    item.data.energy = energy
    if 'color' in args:
        item.data.color = _color(args['color'], 'color')
    if 'size' in args and kind == 'area':
        size = _num(args['size'], 'size')
        if size <= 0.0:
            raise OpError('E_ARG_RANGE', 'area size must be greater than 0')
        item.data.size = size
    bpy.context.view_layer.update()
    return {
        'name': item.name,
        'kind': kind,
        'type': item.type,
        'energy': round(float(item.data.energy), 6),
        'location': [round(v, 6) for v in item.location],
        'objectCount': _counts(),
    }


def _op_camera_add(args):
    replace = _flag(args['replace'], 'replace') if 'replace' in args else False
    label = _fresh_name(args.get('name'), replace)
    location = _vec(args.get('location', (0.0, -6.0, 3.0)), 'location', 3)
    if replace and label is not None:
        existing = bpy.data.objects.get(label)
        if existing is not None:
            bpy.data.objects.remove(existing, do_unlink=True)
    bpy.ops.object.camera_add(location=location)
    item = bpy.context.active_object
    if label is not None:
        item.name = label
    if 'rotation_euler' in args:
        item.rotation_euler = _vec(args['rotation_euler'], 'rotation_euler', 3)
    lens = _num(args['lens'], 'lens') if 'lens' in args else 50.0
    if lens < 1.0 or lens > 500.0:
        raise OpError('E_ARG_RANGE', 'lens must be 1..500 mm')
    item.data.lens = lens
    make_active = _flag(args['active'], 'active') if 'active' in args else True
    if make_active:
        bpy.context.scene.camera = item
    bpy.context.view_layer.update()
    return {
        'name': item.name,
        'lens': round(float(item.data.lens), 6),
        'location': [round(v, 6) for v in item.location],
        'active': bool(make_active),
        'sceneCamera': bpy.context.scene.camera.name if bpy.context.scene.camera else None,
    }


def _op_object_look_at(args):
    """Aim an object at a point, or at another object.

    Cameras and lights both look down their own -Z with +Y as up, so the same aim works for both.
    """
    item = _object(_name(args.get('name'), 'name'))
    target = args.get('target')
    if isinstance(target, str):
        point = _object(target).matrix_world.translation.copy()
    else:
        point = Vector(_vec(target, 'target', 3))
    direction = point - item.matrix_world.translation
    if direction.length < 1e-6:
        raise OpError('E_ARG_RANGE', 'the target is where the object already is; nothing to aim at')
    item.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    bpy.context.view_layer.update()
    return {
        'name': item.name,
        'target': [round(v, 6) for v in point],
        'rotationEuler': [round(v, 6) for v in item.rotation_euler],
    }


OPS = {
    'mesh.primitive_add': _op_primitive_add,
    'object.transform': _op_transform,
    'object.duplicate': _op_duplicate,
    'object.delete': _op_delete,
    'material.set': _op_material_set,
    'material.assign': _op_material_assign,
    'object.join': _op_join,
    'data.purge_unused': _op_data_purge_unused,
    'file.checkpoint': _op_file_checkpoint,
    'file.stage_export': _op_file_stage_export,
    'mesh.import': _op_mesh_import,
    'modifier.add': _op_modifier_add,
    'light.add': _op_light_add,
    'camera.add': _op_camera_add,
    'object.look_at': _op_object_look_at,
}

# Declared so a caller can ask what exists without guessing. This table is the single
# source of truth: the model composes batches from it, and `mutates`/`destructive` drive
# the approval decision on the Node side.
OP_MANIFEST = {
    'mesh.primitive_add': {
        'mutates': False,
        'summary': 'add one primitive mesh',
        'args': {
            'kind': {'type': 'enum', 'required': True, 'values': list(PRIMITIVE_KINDS)},
            'name': {'type': 'string', 'required': True, 'charset': 'A-Za-z0-9_-.', 'maxLength': 96},
            'size': {'type': 'number', 'default': 1.0, 'range': '(0, 1000]', 'note': 'diameter/footprint'},
            'location': {'type': 'vec3', 'default': [0, 0, 0], 'absMax': 10000},
            'rotation_euler': {'type': 'vec3', 'default': [0, 0, 0], 'unit': 'radians'},
            'scale': {'type': 'vec3', 'default': [1, 1, 1], 'range': '(0, 10000]'},
            'material': {'type': 'string', 'optional': True, 'note': 'created on demand'},
            'replace': {'type': 'boolean', 'default': False, 'note': 'overwrite an existing object of the same name'},
        },
        'example': {'op': 'mesh.primitive_add',
                    'args': {'kind': 'uv_sphere', 'name': 'head', 'size': 1.6,
                             'location': [0, 0, 3.3], 'material': 'Skin'}},
    },
    'object.transform': {
        'mutates': True,
        'summary': 'set absolute location / rotation_euler / scale',
        'args': {
            'name': {'type': 'string', 'required': True},
            'location': {'type': 'vec3', 'optional': True, 'absMax': 10000},
            'rotation_euler': {'type': 'vec3', 'optional': True, 'unit': 'radians'},
            'scale': {'type': 'vec3', 'optional': True, 'range': '(0, 10000]'},
        },
        'notes': ['at least one of location/rotation_euler/scale is required',
                  'values are absolute, not deltas'],
        'example': {'op': 'object.transform',
                    'args': {'name': 'arm_L', 'rotation_euler': [0, 0, -0.35]}},
    },
    'object.duplicate': {
        'mutates': False,
        'summary': 'copy an object (cheapest way to build mirrored limbs)',
        'args': {
            'name': {'type': 'string', 'required': True, 'note': 'source'},
            'newName': {'type': 'string', 'required': True, 'charset': 'A-Za-z0-9_-.', 'maxLength': 96},
            'offset': {'type': 'vec3', 'optional': True, 'note': 'relative to the source location'},
            'scale': {'type': 'vec3', 'optional': True, 'range': '(0, 10000]'},
        },
        'example': {'op': 'object.duplicate',
                    'args': {'name': 'body', 'newName': 'arm_R', 'offset': [-0.85, 0, 0.15]}},
    },
    'object.delete': {
        'mutates': True,
        'destructive': True,
        'summary': 'remove an object',
        'args': {'name': {'type': 'string', 'required': True}},
        'example': {'op': 'object.delete', 'args': {'name': 'Cube'}},
    },
    'material.set': {
        'mutates': False,
        'summary': 'create a material if missing, then set colour/roughness/metallic/emission',
        'args': {
            'name': {'type': 'string', 'required': True},
            'color': {'type': 'vec3', 'default': [0.8, 0.8, 0.8], 'range': '0..1 per channel'},
            'roughness': {'type': 'number', 'optional': True, 'range': '0..1'},
            'metallic': {'type': 'number', 'optional': True, 'range': '0..1'},
            'emission': {'type': 'number', 'optional': True, 'note': 'emission strength, 0..1 typical'},
        },
        'notes': ['colour is linear scene-referred, not sRGB hex; divide a hex value by 255 and '
                  'apply an approximate sRGB->linear step for similar-looking results'],
        'example': {'op': 'material.set',
                    'args': {'name': 'Hair', 'color': [0.12, 0.18, 0.55], 'roughness': 0.45}},
    },
    'material.assign': {
        'mutates': True,
        'summary': 'replace all material slots of an object with one material',
        'args': {
            'name': {'type': 'string', 'required': True, 'note': 'object'},
            'material': {'type': 'string', 'required': True},
        },
        'example': {'op': 'material.assign', 'args': {'name': 'head', 'material': 'Skin'}},
    },
    'object.join': {
        'mutates': True,
        'destructive': True,
        'summary': 'merge several objects into the first one',
        'args': {
            'names': {'type': 'strlist', 'required': True, 'minItems': 2, 'maxItems': MAX_OPS_PER_BATCH},
            'name': {'type': 'string', 'required': True},
        },
        'example': {'op': 'object.join', 'args': {'names': ['arm_L', 'arm_R'], 'name': 'arms'}},
    },
}

OP_MANIFEST.update({
    'modifier.add': {
        'mutates': True,
        'destructive': False,
        'summary': 'add an unapplied modifier to a mesh object',
        'args': {
            'name': {'type': 'string', 'required': True, 'note': 'the mesh object'},
            'kind': {'type': 'enum', 'values': ['subdivision', 'bevel', 'mirror', 'solidify'], 'required': True},
            'amount': {'type': 'number', 'optional': True, 'note': 'subdivision levels (1-6, integer), bevel width, or solidify thickness'},
            'segments': {'type': 'integer', 'optional': True, 'range': '1..16', 'note': 'bevel only'},
            'axis': {'type': 'enum', 'values': ['X', 'Y', 'Z'], 'optional': True, 'note': 'mirror only'},
        },
        'refuses': ['E_NO_SUCH_OBJECT', 'E_NOT_A_MESH', 'E_ARG_ENUM', 'E_ARG_RANGE', 'E_LIMIT'],
        'note': 'left unapplied so it stays editable in the modifier stack; nothing is baked',
        'example': {'op': 'modifier.add', 'args': {'name': 'body', 'kind': 'bevel', 'amount': 0.02, 'segments': 3}},
    },
    'light.add': {
        'mutates': True,
        'destructive': False,
        'summary': 'add a light',
        'args': {
            'kind': {'type': 'enum', 'values': ['point', 'sun', 'area', 'spot'], 'default': 'point'},
            'name': {'type': 'string', 'optional': True},
            'energy': {'type': 'number', 'optional': True, 'note': 'W/m^2 for sun, W otherwise; defaults are per kind'},
            'color': {'type': 'vec3', 'optional': True, 'range': '0..1 per channel'},
            'size': {'type': 'number', 'optional': True, 'note': 'area lights only'},
            'location': {'type': 'vec3', 'optional': True, 'default': [0, 0, 4]},
            'rotation_euler': {'type': 'vec3', 'optional': True, 'unit': 'radians'},
            'replace': {'type': 'boolean', 'default': False},
        },
        'refuses': ['E_NAME_TAKEN', 'E_ARG_ENUM', 'E_ARG_RANGE', 'E_ARG_TYPE'],
        'example': {'op': 'light.add', 'args': {'kind': 'sun', 'name': 'KeyLight', 'energy': 4.0, 'location': [4, -4, 8]}},
    },
    'camera.add': {
        'mutates': True,
        'destructive': False,
        'summary': 'add a camera and optionally make it the scene camera',
        'args': {
            'name': {'type': 'string', 'optional': True},
            'lens': {'type': 'number', 'optional': True, 'range': '1..500 mm', 'default': 50},
            'location': {'type': 'vec3', 'optional': True, 'default': [0, -6, 3]},
            'rotation_euler': {'type': 'vec3', 'optional': True, 'unit': 'radians'},
            'active': {'type': 'boolean', 'default': True, 'note': 'assign it as scene.camera'},
            'replace': {'type': 'boolean', 'default': False},
        },
        'refuses': ['E_NAME_TAKEN', 'E_ARG_RANGE', 'E_ARG_TYPE'],
        'example': {'op': 'camera.add', 'args': {'name': 'Shot', 'location': [6, -6, 4], 'lens': 35}},
    },
    'object.look_at': {
        'mutates': True,
        'destructive': False,
        'summary': 'aim an object (camera or light) at a point or at another object',
        'args': {
            'name': {'type': 'string', 'required': True},
            'target': {'type': 'string or vec3', 'required': True, 'note': 'an object name, or a world point'},
        },
        'refuses': ['E_NO_SUCH_OBJECT', 'E_ARG_RANGE', 'E_ARG_TYPE'],
        'note': 'both lights and cameras look down their own -Z with +Y up, so one aim serves both',
        'example': {'op': 'object.look_at', 'args': {'name': 'Shot', 'target': 'body'}},
    },
    'mesh.import': {
        'mutates': True,
        'destructive': False,
        'summary': 'import an external mesh (.glb/.gltf/.obj) into the managed scene',
        'args': {
            'path': {'type': 'string', 'required': True, 'note': 'absolute, or relative to the working directory; the file must exist'},
            'name': {'type': 'string', 'optional': True, 'note': 'rename the largest imported mesh'},
            'upAxis': {'type': 'enum', 'values': ['X', 'Y', 'Z'], 'default': 'Y', 'note': 'the up axis the FILE uses, declared by the caller; this op never guesses it'},
            'scale': {'type': 'number', 'default': 1.0, 'range': '(0, 1000]', 'note': 'file space -> metres'},
            'size': {'type': 'vec3', 'optional': True, 'note': 'expected final size; compared and reported, never applied'},
            'location': {'type': 'vec3', 'optional': True, 'note': 'expected final centre; compared and reported, never applied'},
            'bytes': {'type': 'integer', 'optional': True, 'note': 'declared file size; a mismatch refuses with E_BYTE_MISMATCH'},
            'sha256': {'type': 'string', 'optional': True, 'note': 'declared digest; a mismatch refuses with E_BYTE_MISMATCH'},
        },
        'refuses': ['E_NO_SUCH_FILE', 'E_UNSUPPORTED_FORMAT', 'E_BYTE_MISMATCH', 'E_NO_MESH_IMPORTED'],
        'note': 'A refusal leaves the scene untouched (non-mesh leftovers are removed). The glTF importer has no axis parameter, so a declared up axis other than Y is corrected by rotating the imported objects; OBJ passes the declared axis straight to its importer with a fixed -Y forward axis.',
        'example': {'op': 'mesh.import', 'args': {'path': 'D:/work/out/model.glb', 'upAxis': 'Y', 'scale': 1.0}},
    },
    'data.purge_unused': {
        'mutates': True,
        'destructive': True,
        'summary': 'remove datablocks with no users (orphan meshes/materials/images)',
        'args': {
            'dry': {'type': 'boolean', 'default': False, 'note': 'report what would be removed without removing it'},
        },
        'notes': ['deleting an object does not delete its mesh or material; they linger until purge'],
        'example': {'op': 'data.purge_unused', 'args': {'dry': True}},
    },
    'file.checkpoint': {
        'mutates': False,
        'summary': 'save a snapshot beside the instance (main file untouched, relative paths kept working)',
        'args': {
            'label': {'type': 'string', 'default': 'checkpoint', 'charset': 'A-Za-z0-9_-.', 'maxLength': 96},
        },
        'notes': [
            'copy=True: bpy.data.filepath is unchanged, so the open file is never modified',
            'relative_remap=True: relative image paths still resolve to the original assets',
            'an existing label is refused (a checkpoint that replaces an earlier one is not a checkpoint)',
        ],
        'example': {'op': 'file.checkpoint', 'args': {'label': 'boy-01'}},
    },
    'file.stage_export': {
        'mutates': False,
        'summary': 'write a standalone copy into the instance staging area for the Host to deliver',
        'args': {
            'name': {'type': 'string', 'optional': True, 'charset': 'A-Za-z0-9_-.', 'maxLength': 96},
        },
        'notes': [
            'the staging target is always a fresh name; an existing target is refused',
            'relative_remap=False: relative image paths are reported, not silently rewritten',
            'the final destination is written by the Host (audited, and it refuses to overwrite)',
        ],
        'example': {'op': 'file.stage_export', 'args': {}},
    },
})


ERROR_CODES = {
    'E_TARGET_EXISTS': 'the target file already exists (checkpoints and exports never overwrite)',
    'E_NO_INSTANCE': 'the bridge has no instance directory configured',
    'E_UNKNOWN_OP': 'op is not in the whitelist',
    'E_BAD_RECORD': 'record has unknown/missing keys',
    'E_ARG_TYPE': 'a value has the wrong type (or is not finite)',
    'E_ARG_RANGE': 'a value is outside its allowed range',
    'E_ARG_ENUM': 'a value is not one of the allowed enum members',
    'E_ARG_CHARSET': 'a name contains characters outside A-Za-z0-9_-.',
    'E_ARG_MISSING': 'a required field is absent',
    'E_NO_SUCH_OBJECT': 'the named object does not exist',
    'E_NAME_TAKEN': 'the name is already used (pass replace=true to overwrite)',
    'E_NOT_A_MESH': 'the object has no mesh data to take a material',
    'E_LIMIT': 'a budget was exceeded (ops per batch, objects, materials)',
    'E_BAD_BATCH': 'the batch is empty or malformed',
    'E_NO_SUCH_FILE': 'the file to import does not exist',
    'E_UNSUPPORTED_FORMAT': 'only .glb, .gltf and .obj can be imported',
    'E_BYTE_MISMATCH': 'the file does not match the size or digest the caller declared',
    'E_NO_MESH_IMPORTED': 'the import produced no mesh object (nothing was left behind)',
}


def catalog():
    """The machine-readable contract: what may be called, with which arguments."""
    return {
        'version': 1,
        # Named capability face; consumers should record this rather than the package version.
        'capabilitySet': CAPABILITY_SET,
        # The primitive kinds `mesh.primitive_add` will accept. Published from PRIMITIVE_KINDS, so a
        # consumer can gate on it instead of falling back to "cannot tell".
        'primitives': list(PRIMITIVE_KINDS),
        'limits': {
            'maxOpsPerBatch': MAX_OPS_PER_BATCH,
            'maxObjects': MAX_OBJECTS,
            'nameCharset': 'A-Za-z0-9_-.',
            'nameMaxLength': 96,
        },
        'ops': OP_MANIFEST,
        'errorCodes': ERROR_CODES,
        'notes': [
            'ops are applied in order; the batch stops at the first rejection and reports what already ran',
            'the whole batch shares one undo step',
            'a rejected op changes nothing',
            'read the scene with scene.describe before and after a build to verify the result',
            'capabilitySet names the capability face; primitives is the accepted set for '
            'mesh.primitive_add.kind (a UV sphere is published as uv_sphere)',
        ],
    }


def apply_op(record):
    """Validate and run one op record. Raises OpError for anything rejected."""
    if not isinstance(record, dict):
        raise OpError('E_BAD_RECORD', 'op record must be an object')
    unknown = set(record.keys()) - {'op', 'args'}
    if unknown:
        raise OpError('E_BAD_RECORD', 'unknown keys: %s' % ', '.join(sorted(unknown)))
    name = record.get('op')
    if not isinstance(name, str):
        raise OpError('E_BAD_RECORD', 'op must be a string')
    handler = OPS.get(name)
    if handler is None:
        raise OpError('E_UNKNOWN_OP', 'op is not in the whitelist: %s' % name)
    args = record.get('args', {})
    if not isinstance(args, dict):
        raise OpError('E_ARG_TYPE', 'args must be an object')
    return handler(args)


def apply_batch(records):
    """Run a batch; stop at the first rejection and report what already happened."""
    if not isinstance(records, list) or not records:
        raise OpError('E_BAD_BATCH', 'ops must be a non-empty list')
    if len(records) > MAX_OPS_PER_BATCH:
        raise OpError('E_LIMIT', 'at most %d ops per batch' % MAX_OPS_PER_BATCH)
    applied = []
    for index, record in enumerate(records):
        try:
            applied.append({'index': index, 'op': record.get('op'), 'result': apply_op(record), 'ok': True})
        except OpError as error:
            return {'ok': False, 'applied': applied, 'failed': {'index': index, 'code': error.code, 'message': error.message}}
    return {'ok': True, 'applied': applied}


# Objects whose data can supply a bounding box. Measured on Blender 5.2.2: every object carries a
# `dimensions` vector, and cameras, lights and empties answer [0, 0, 0] instead of raising -- so
# hasattr() alone can never yield None here, and reporting that zero as a size would be a lie
# (a camera is not a zero-size box). Only objects with geometry report a size.
_GEOMETRY_TYPES = ('MESH', 'CURVE', 'SURFACE', 'META', 'FONT')


def _rounded3(value):
    """Round a vector to the same precision as location/scale; None when it is unavailable.

    Used by a read-only diagnostic path, so it must never raise: an attribute that is missing,
    or of an unexpected shape, becomes None rather than failing the whole scene readback.
    """
    try:
        return [round(v, 6) for v in value]
    except Exception:
        return None


def _world_bounds(item):
    """Axis-aligned (min, max) corners of an object's own bounding box, in world space."""
    corners = [item.matrix_world @ Vector(corner) for corner in item.bound_box]
    low = [min(c[i] for c in corners) for i in range(3)]
    high = [max(c[i] for c in corners) for i in range(3)]
    return low, high


def _world_dimensions(item):
    """Final world-space size of the object, or None when it has no geometry to measure.

    Measured on Blender 5.2.2: `Object.dimensions` is the LOCAL bounding box times the object
    scale and it ignores rotation -- an imported object that carries the importer's own 90 degree
    axis conversion reports its pre-rotation size, which is exactly the number a caller comparing
    "is this the size I asked for" must not be given. The world AABB is the honest answer, and it
    is deterministic here: bound_box comes from the mesh data, not from a depsgraph evaluation
    that a background run can leave stale.
    """
    if item.type not in _GEOMETRY_TYPES:
        return None
    try:
        low, high = _world_bounds(item)
        return [round(high[i] - low[i], 6) for i in range(3)]
    except Exception:
        return None


def describe_scene():
    scene = bpy.context.scene
    # Settle the depsgraph before measuring anything derived from a world matrix. Measured
    # 2026-10-09: matrix_world and bound_box are EVALUATED values, so right after a Python-side
    # transform they still describe the previous state -- an object scaled to [1,2,4] read back as
    # [1,1,1], and a rotation was ignored entirely ([1,2,4] instead of [1,4,2]). Fields read
    # straight off the object (name/type/location/scale) are unaffected, but dimensions is derived,
    # and this is the one place that can hide the difference from every caller.
    bpy.context.view_layer.update()
    objects = []
    for item in bpy.data.objects:
        entry = {
            'name': item.name,
            'type': item.type,
            'location': [round(v, 6) for v in item.location],
            'scale': [round(v, 6) for v in item.scale],
            # Final world-space size (scale is already baked in). None for cameras, lights and
            # empties, which have no geometry to measure.
            'dimensions': _world_dimensions(item),
            'rotation_euler': _rounded3(getattr(item, 'rotation_euler', None)),
        }
        if item.type == 'MESH' and item.data is not None:
            entry['vertices'] = len(item.data.vertices)
            entry['polygons'] = len(item.data.polygons)
            entry['materials'] = [slot.name for slot in item.data.materials if slot is not None]
        objects.append(entry)
    return {
        'scene': scene.name,
        'objectCount': len(objects),
        'objects': objects,
        'materials': sorted(material.name for material in bpy.data.materials),
        'knownOps': sorted(OPS.keys()),
    }
