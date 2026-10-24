# Cadre Meshy, étape 1 : retirer la plaque du centre, simplifier, enregistrer (clean.blend) et mesurer
# l'ouverture. La plaque : faces plates (normale selon ±Y), minces, de la texture gris uniforme, à l'intérieur.
#   blender -b -P clean.py -- <fichier.fbx> <dossier>
import bpy, bmesh, sys, os
import numpy as np
from mathutils import Vector
argv = sys.argv[sys.argv.index('--') + 1:]
FBX, OUT = argv[0], argv[1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=FBX)
ob = [o for o in bpy.context.scene.objects if o.type == 'MESH'][0]
bpy.context.view_layer.objects.active = ob
# transformations appliquées : on travaille en coordonnées du monde
bpy.ops.object.select_all(action='DESELECT'); ob.select_set(True)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
me = ob.data
img = bpy.data.images['Image_0']
w, h = img.size
px = np.array(img.pixels[:]).reshape(h, w, 4)

bm = bmesh.new(); bm.from_mesh(me)
uvl = bm.loops.layers.uv.active
kill = []
for f in bm.faces:
    c = f.calc_center_median()
    if abs(c.x) > 0.80 or not (-0.12 < c.z < 0.15):
        continue
    if abs(f.normal.y) < 0.9 or abs(c.y) > 0.008:
        continue
    u, v = f.loops[0][uvl].uv
    lum = px[min(h - 1, int(v * h)), min(w - 1, int(u * w)), :3].mean()
    if abs(lum - 0.369) < 0.06:
        kill.append(f)
print('faces de plaque retirées :', len(kill))
bmesh.ops.delete(bm, geom=kill, context='FACES')
# débris : îlots de moins de 300 faces
seen = set(); islands = []
for f in bm.faces:
    if f.index in seen: continue
    stack = [f]; isl = []; seen.add(f.index)
    while stack:
        g = stack.pop(); isl.append(g)
        for e in g.edges:
            for k in e.link_faces:
                if k.index not in seen:
                    seen.add(k.index); stack.append(k)
    islands.append(isl)
bm.faces.ensure_lookup_table()
small = [g for isl in islands if len(isl) < 300 for g in isl]
print('îlots :', len(islands), 'petits retirés :', sum(1 for isl in islands if len(isl) < 300))
bmesh.ops.delete(bm, geom=small, context='FACES')
bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
bm.to_mesh(me); bm.free()

# simplification
mod = ob.modifiers.new('decimate', 'DECIMATE')
mod.ratio = float(os.environ.get('RATIO', 0.18))
bpy.ops.object.modifier_apply(modifier='decimate')
print('faces après simplification :', len(me.polygons))

# ouverture : le long des axes, l'intervalle vide autour du centre
co = np.zeros((len(me.vertices), 3)); me.vertices.foreach_get('co', co.ravel())
row = co[np.abs(co[:, 2] - 0.012) < 0.015]
left = row[row[:, 0] < 0][:, 0].max(); right = row[row[:, 0] > 0][:, 0].min()
col = co[np.abs(co[:, 0] - 0.4) < 0.02]
top = col[col[:, 2] > 0.012][:, 2].min(); bottom = col[col[:, 2] < 0.012][:, 2].max()
print('OUVERTURE x %.4f .. %.4f  z %.4f .. %.4f' % (left, right, bottom, top))
print('BOITE x %.4f .. %.4f  z %.4f .. %.4f' % (co[:, 0].min(), co[:, 0].max(), co[:, 2].min(), co[:, 2].max()))
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'clean.blend'))
print('FIN')

