"""Run with Blender --background --python surface-check.py -- <output-directory>."""
import sys
import os
import json
import tempfile
from pathlib import Path
import bpy
import bmesh
sys.dont_write_bytecode = True

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'packages' / 'agh-blender' / 'extensions' / 'main' / 'bridge'))
import agh_ops as ops
import agh_capture as capture

root = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else tempfile.mkdtemp(prefix='agh-surface-check-')
os.makedirs(root, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
profile = [[0,0],[.038,0],[.045,.003],[.05,.012],[.057,.028],[.063,.048],[.066,.070],[.068,.092],[.0675,.095],[.066,.096],[.0645,.095],[.064,.092],[.062,.070],[.059,.048],[.053,.028],[.047,.014],[.041,.007],[0,.007]]
points = [[.064,0,.078],[.078,0,.083],[.094,0,.079],[.105,0,.063],[.104,0,.044],[.09,0,.025],[.071,0,.017],[.052,0,.018]]
result = ops.apply_batch([
    {'op':'material.set','args':{'name':'BlackCeramic','color':[.008,.009,.011],'roughness':.16,'metallic':0}},
    {'op':'mesh.revolve_profile','args':{'name':'CupBody','profile':profile+[profile[0]],'segments':128,'material':'BlackCeramic'}},
    {'op':'mesh.sweep_tube','args':{'name':'CupHandle','points':points,'radius':.0045,'material':'BlackCeramic'}},
])
assert result['ok'], result
mesh = bmesh.new()
mesh.from_mesh(bpy.data.objects['CupBody'].data)
assert all(edge.is_manifold for edge in mesh.edges)
assert abs(mesh.calc_volume()) > 1e-7
mesh.free()
mesh = bmesh.new()
mesh.from_mesh(bpy.data.objects['CupHandle'].data)
assert all(edge.is_manifold for edge in mesh.edges), 'Tube end caps must join the side surface'
assert abs(mesh.calc_volume()) > 1e-9
mesh.free()
for bad in [
    {'name':'Bad','profile':[[0,0],[-1,1],[0,2]]},
    {'name':'Bad','profile':[[0,0],[1,1],[1,1]]},
    {'name':'Bad','profile':[[0,0],[1,1],[0,2]],'segments':True},
    {'name':'Bad','profile':[[0,0],[.06,.1],[.06,0],[0,.08]]},
]:
    count = len(bpy.data.objects)
    try:
        ops.apply_op({'op':'mesh.revolve_profile','args':bad})
        raise AssertionError('Invalid profile accepted')
    except ops.OpError:
        pass
    assert len(bpy.data.objects) == count
setup = ops.apply_batch([
    {'op':'light.add','args':{'kind':'area','name':'Key','energy':30,'size':.3,'location':[-.15,-.25,.30]}},
    {'op':'object.look_at','args':{'name':'Key','target':[0,0,.05]}},
    {'op':'light.add','args':{'kind':'area','name':'Fill','energy':15,'size':.25,'location':[.2,-.1,.25]}},
    {'op':'object.look_at','args':{'name':'Fill','target':[0,0,.05]}},
    {'op':'camera.add','args':{'name':'Front','type':'ORTHO','ortho_scale':.25,'location':[0,-.45,.20]}},
    {'op':'object.look_at','args':{'name':'Front','target':[.02,0,.05]}},
])
assert setup['ok'], setup
bpy.context.scene.render.engine = 'BLENDER_EEVEE'
scene = bpy.context.scene
before = (scene.camera, scene.render.filepath, scene.render.resolution_x, scene.render.film_transparent)
shot = capture.capture_scene(root, 'Front', 768, 768)
assert shot['source'] == 'scene-camera' and shot['camera'] == 'Front'
assert shot['bytes'] > 1000 and os.path.isfile(shot['path'])
assert before == (scene.camera, scene.render.filepath, scene.render.resolution_x, scene.render.film_transparent)
try:
    capture.capture_scene(root, 'MissingCamera', 768, 768)
    raise AssertionError('Missing camera accepted')
except ops.OpError:
    pass
assert before == (scene.camera, scene.render.filepath, scene.render.resolution_x, scene.render.film_transparent)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(root, 'cup.blend'))
with open(os.path.join(root, 'verification.json'), 'w') as handle:
    json.dump({'ok':True,'bodyManifold':True,'capture':shot,'scene':ops.describe_scene(),
               'surfaces':[{'name':'CupBody','kind':'revolve','profile':profile,'segments':128},
                           {'name':'CupHandle','kind':'tube','points':points,'radius':.0045}]}, handle)
print('SURFACE_AND_CAMERA_CHECK_PASS')
