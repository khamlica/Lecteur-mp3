# Cadre Meshy pour le plein écran du téléphone (thème SAVAGE ENHANCED, android/app/src/web/mobile.css) : même
# nettoyage que adapt.py (ses premières étapes sont reprises telles quelles), puis un calage par morceaux sur un écran
# de référence W × H px :
# - le jonc borde un rectangle en retrait des bords de l'écran (marges SL, ST, SB) ; ce qui dépasse dehors (les
#   épines) remplit la marge, tassé pour y tenir, toujours tourné vers l'extérieur ;
# - en hauteur, les groupes d'épines des côtés (les coins, le milieu) gardent leur taille ; seuls les tronçons
#   entre eux s'allongent (ce sont eux que mobile.css étire pour d'autres tailles d'écran) ;
# - rend de face, comme adapt.py : frame.png (3×) et frame.json (les zones à découper).
#   blender -b clean.blend -P adapt_mobile.py -- <dossier de sortie>
import os, sys, math
HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, 'adapt.py'), encoding='utf8').read()
# le nettoyage et la mesure du bord de la barre (jusqu'au calage, exclu)
exec(compile(src.split('# ---------- calage et repli ----------')[0], 'adapt.py', 'exec'))

W, H = int(E('MW', 412)), int(E('MH', 924))
SL, ST, SB = E('MSL', 34), E('MST', 26), E('MSB', 34)    # marges entre le bord de l'écran et le jonc (px)
INS = E('INSET', 2.5)
xmin = min(v.co.x for v in bm.verts); xmax = max(v.co.x for v in bm.verts)
zmin = min(v.co.z for v in bm.verts); zmax = max(v.co.z for v in bm.verts)
# Les groupes d'épines gardent la taille du bureau (k px par unité du modèle, la même dans les deux sens) ;
# seuls les tronçons de jonc entre eux s'allongent ou se resserrent
k = E('MSCALE', 390)
h0 = TOP - BOTTOM
XC = (LEFT + RIGHT) / 2
CX = E('MCX', 0.11)             # largeur (unités) des groupes des coins, le long du haut et du bas
OX = E('MOX', 0.30)             # demi-largeur des ornements du haut et du bas
CORNER = E('MCORNER', 0.036)    # hauteur des groupes des coins, le long des côtés
MID = E('MMID', 0.068)          # demi-hauteur du groupe du milieu des côtés
inner_l, inner_r = SL + INS, W - SL - INS
inner_t, inner_b = ST + INS, H - SB - INS
mid_x, mid_y = W / 2, (inner_t + inner_b) / 2
# par morceaux : en largeur (x du modèle → px), en hauteur (u, la distance sous le haut de l'ouverture → py)
knots_x = [LEFT, LEFT + CX, XC - OX, XC + OX, RIGHT - CX, RIGHT]
knots_px = [inner_l, inner_l + CX * k, mid_x - OX * k, mid_x + OX * k, inner_r - CX * k, inner_r]
knots_u = [0, CORNER, h0 / 2 - MID, h0 / 2 + MID, h0 - CORNER, h0]
knots_p = [inner_t, inner_t + CORNER * k, mid_y - MID * k, mid_y + MID * k, inner_b - CORNER * k, inner_b]
assert all(a < b for a, b in zip(knots_px, knots_px[1:])), knots_px
print('morceaux en largeur (px) :', [round(p) for p in knots_px])
print('morceaux en hauteur (px) :', [round(p) for p in knots_p])

def squeeze(p, lo, hi):
    """Ce qui avance dans l'écran (au-delà du jonc) est tassé dans FOLDIN px (comme adapt.py)."""
    if lo < p < (lo + hi) / 2:
        return lo + FOLDIN * (1 - math.exp(-(p - lo) / FOLDIN))
    if (lo + hi) / 2 <= p < hi:
        return hi - FOLDIN * (1 - math.exp(-(hi - p) / FOLDIN))
    return p


def outside(d, room, extent):
    """Ce qui dépasse de `d` unités (au plus `extent`) tient dans `room` px : à sa naissance à l'échelle k (la base
    des épines garde sa forme), de plus en plus tassé vers les pointes."""
    if extent * k <= room:
        return d * k
    # on cherche l'échelle de tassement qui fait tenir `extent` dans `room` : room = L (1 − e^(−extent·k/L))
    L = room
    for _ in range(60):
        L = room / (1 - math.exp(-extent * k / L))
    return L * (1 - math.exp(-d * k / L))

for v in bm.verts:
    x, z = v.co.x, v.co.z
    if x < LEFT:
        px = SL + INS - outside(LEFT - x, SL + INS - 1.5, LEFT - xmin)
    elif x > RIGHT:
        px = W - SL - INS + outside(x - RIGHT, SL + INS - 1.5, xmax - RIGHT)
    else:
        px = float(np.interp(x, knots_x, knots_px))
    if z > TOP:
        py = inner_t - outside(z - TOP, ST + INS - 1.5, zmax - TOP)
    elif z < BOTTOM:
        py = inner_b + outside(BOTTOM - z, SB + INS - 1.5, BOTTOM - zmin)
    else:
        py = float(np.interp(TOP - z, knots_u, knots_p))
    # les pointes en V du centre avancent dans l'écran : tassées comme dans adapt.py
    if abs(x - (LEFT + RIGHT) / 2) < 0.2:
        py = squeeze(py, inner_t, inner_b)
    v.co = Vector((px, v.co.y * k, -py))

# rien d'autre que le jonc et les pointes du centre n'entre dans l'écran
m = INS + 0.3
inside = [f for f in bm.faces
          if SL + m < f.calc_center_median().x < W - SL - m and inner_t + 0.3 < -f.calc_center_median().z < inner_b - 0.3
          and not abs(f.calc_center_median().x - W / 2) < 0.2 * k]
bmesh.ops.delete(bm, geom=inside, context='FACES')
print('éclats dans l\'écran retirés :', len(inside))
bm.to_mesh(me); bm.free()
me.update()

for mat in me.materials:
    bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf and not bsdf.inputs['Metallic'].is_linked:
        bsdf.inputs['Metallic'].default_value = 1.0

# éclairage (comme adapt.py)
world = bpy.data.worlds.new('studio'); scene.world = world; world.use_nodes = True
nt = world.node_tree
env = nt.nodes.new('ShaderNodeTexEnvironment')
env.image = bpy.data.images.load(os.path.join(os.path.dirname(bpy.app.binary_path), '%d.%d' % bpy.app.version[:2],
                                              'datafiles', 'studiolights', 'world', os.environ.get('HDRI', 'studio') + '.exr'))
mapping = nt.nodes.new('ShaderNodeMapping'); coord = nt.nodes.new('ShaderNodeTexCoord')
mapping.inputs['Rotation'].default_value = (0, 0, math.radians(E('ROT', 200)))
nt.links.new(coord.outputs['Generated'], mapping.inputs['Vector']); nt.links.new(mapping.outputs['Vector'], env.inputs['Vector'])
nt.links.new(env.outputs['Color'], nt.nodes['Background'].inputs['Color'])
nt.nodes['Background'].inputs['Strength'].default_value = E('ENV', 1.2)

cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); scene.collection.objects.link(cam); scene.camera = cam
cam.data.type = 'ORTHO'
cam.data.ortho_scale = max(W, H)
cam.location = (W / 2, -200, -H / 2); cam.rotation_euler = (math.pi / 2, 0, 0)
cam.data.clip_end = 1000
import json
json.dump({'width': W, 'height': H, 'margins': [SL, ST, SB], 'knots': knots_p}, open(os.path.join(OUT, 'frame.json'), 'w'))
scene.render.engine = 'CYCLES'
scene.cycles.samples = int(E('SAMPLES', 64))
scene.cycles.use_denoising = True
scene.render.film_transparent = True
scene.render.resolution_x, scene.render.resolution_y = W * SCALE, H * SCALE
scene.view_settings.view_transform = 'Standard'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.filepath = os.path.join(OUT, 'frame.png')
bpy.ops.render.render(write_still=True)
print('FIN')
