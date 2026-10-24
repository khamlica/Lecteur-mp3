# Cadre Meshy, étape 2 : adapter le cadre nettoyé (clean.blend) à la fenêtre du lecteur et le rendre.
# - vide l'ouverture des éclats de plaque restants (sauf les deux pointes en V du centre) ;
# - cale la barre du cadre sur le bord de la fenêtre (540 × 88 px, 1 unité = 1 px) ;
# - replie vers l'intérieur ce qui dépasse (épines, boucles des coins), avec une compression progressive : ce
#   qui est près de la barre garde sa forme, les pointes lointaines se tassent dans ~FOLD px ;
# - rend de face (texture Meshy, studio HDR) : frame.png (3×, fond transparent) et mask.png (sa silhouette).
#   blender -b clean.blend -P adapt.py -- <dossier de sortie>
import bpy, bmesh, sys, os, math
from mathutils import Vector
OUT = sys.argv[sys.argv.index('--') + 1]
E = lambda k, d: float(os.environ.get(k, d))
W, H = 540, 88
SCALE = 3
# ouverture mesurée (clean.py) et épaisseur de la barre (unités du modèle)
LEFT, RIGHT, BOTTOM, TOP = -0.7298, 0.7072, -0.0759, 0.1412
BAR = E('BAR', 0.013)
EDGE = E('EDGE', 0.6)        # écart entre la barre et le bord de la fenêtre (px)
FOLD = E('FOLD', 11)         # profondeur maximale d'un ornement replié (px)
FOLDIN = E('FOLDIN', 10 if os.environ.get('OVER') != '1' else 2.5)     # profondeur maximale de ce qui avance dans l'ouverture (les pointes en V)

scene = bpy.context.scene
ob = [o for o in scene.objects if o.type == 'MESH'][0]
me = ob.data

# ---------- éclats de plaque dans l'ouverture ----------
bm = bmesh.new(); bm.from_mesh(me)
d = E('SHARD', 0.0015)
# texture, pour reconnaître la plaque grise partout (elle s'étendait aussi sous les ornements des côtés)
import numpy as np
img = bpy.data.images['Image_0']
tw, th = img.size
tex = np.array(img.pixels[:]).reshape(th, tw, 4)
uvl = bm.loops.layers.uv.active
kill = []
for f in bm.faces:
    c = f.calc_center_median()
    if LEFT + d < c.x < RIGHT - d and BOTTOM + d < c.z < TOP - d and not abs(c.x - (LEFT + RIGHT) / 2) < 0.16:
        kill.append(f); continue
    # éclats au ras de la barre : au plan de l'ancienne plaque, en retrait du chrome
    e = 0.006
    if LEFT - e < c.x < RIGHT + e and BOTTOM - e < c.z < TOP + e and c.y > -0.004             and not (LEFT + 0.02 > c.x or c.x > RIGHT - 0.02 or c.z > TOP + 0.002 or c.z < BOTTOM - 0.002)             and not abs(c.x - (LEFT + RIGHT) / 2) < 0.16:
        kill.append(f); continue
    # éclats de plaque dans la bande autour de l'ouverture (la barre n'est pas tout à fait droite) : au plan de
    # la plaque (le chrome est devant, ou de profil sur ses flancs), tournés vers la caméra ou à l'opposé
    b = E('BAND', 0.03)
    if LEFT - b < c.x < RIGHT + b and BOTTOM - b < c.z < TOP + b and -0.0045 < c.y < 0.0065             and abs(f.normal.y) > 0.5:
        kill.append(f); continue
    # plaque : plate, mince, grise, où qu'elle soit
    if abs(f.normal.y) > 0.9 and abs(c.y) < 0.008:
        u, v = f.loops[0][uvl].uv
        if abs(tex[min(th - 1, int(v * th)), min(tw - 1, int(u * tw)), :3].mean() - 0.369) < 0.06:
            kill.append(f)
bmesh.ops.delete(bm, geom=kill, context='FACES')
bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
print('éclats retirés :', len(kill))

# ---------- bord intérieur de la barre, mesuré sur toute sa longueur ----------
# La barre du modèle n'est pas droite : on mesure, colonne par colonne (haut, bas) et rangée par rangée
# (gauche, droite), où elle commence côté ouverture, pour la redresser exactement sur le rectangle du lecteur.
# Les pointes en V du centre (qui avancent dans l'ouverture) sont ignorées : le bord y est interpolé.
import numpy as np
P = np.array([v.co[:] for v in bm.verts])
XC, ZC = (LEFT + RIGHT) / 2, (BOTTOM + TOP) / 2
def profile(along, across, lo, hi, side, n=160, skip=None):
    """Bord intérieur : pour n tranches le long de [lo, hi], l'extrême de `across` côté ouverture."""
    t = np.linspace(lo, hi, n); out = np.full(n, np.nan); half = (hi - lo) / n
    for i, ti in enumerate(t):
        if skip and skip(ti):
            continue
        sel = (np.abs(P[:, along] - ti) < half * 1.5) & ((P[:, across] > (ZC if across == 2 else XC)) == (side > 0))
        vals = P[sel, across]
        vals = vals[np.abs(vals - (TOP if (across == 2 and side > 0) else BOTTOM if across == 2 else RIGHT if side > 0 else LEFT)) < 0.04]
        if len(vals):
            out[i] = vals.min() if side > 0 else vals.max()
    ok = ~np.isnan(out)
    out = np.interp(t, t[ok], out[ok])
    k = 9; pad = np.pad(out, k, mode='edge')
    out = np.array([np.median(pad[i:i + 2 * k + 1]) for i in range(n)])      # sans les accrocs
    out = np.convolve(np.pad(out, 6, mode='edge'), np.ones(13) / 13, mode='valid')  # profil lisse
    return t, out
centre = lambda x: abs(x - XC) < 0.2
TX, TOPE = profile(0, 2, LEFT, RIGHT, +1, skip=centre)     # haut : z du bord intérieur selon x
_, BOTE = profile(0, 2, LEFT, RIGHT, -1, skip=centre)      # bas
TZ, LEFE = profile(2, 0, BOTTOM, TOP, -1)                  # gauche : x du bord selon z
_, RIGE = profile(2, 0, BOTTOM, TOP, +1)                   # droite
print('bord haut : de %.4f à %.4f ; bas : de %.4f à %.4f' % (TOPE.min(), TOPE.max(), BOTE.min(), BOTE.max()))
edge_at = lambda prof, t, x: float(np.interp(x, t, prof))

# ---------- calage et repli ----------
OVER = os.environ.get('OVER') == '1'      # le cadre déborde du lecteur (fenêtre-cadre autour de lui)
FIT = os.environ.get('FIT') == '1'        # le cadre tient dans un rectangle plus grand que le lecteur
SL, ST, SB = E('SL', 50), E('ST', 22), E('SB', 22)   # marges du rectangle autour du lecteur (px)
if FIT:
    OVER = True   # même nettoyage et mêmes pointes en V que le mode débordant
if OVER:
    # l'ouverture (bord intérieur de la barre) recouvre à peine le bord du lecteur
    INSET = E('INSET', 2.5)
    sx = (W - 2 * INSET) / (RIGHT - LEFT)
    sz = (H - 2 * INSET) / (TOP - BOTTOM)
    x0, z1 = LEFT - INSET / sx, TOP + INSET / sz       # le coin haut gauche du lecteur
else:
    x0, x1 = LEFT - BAR, RIGHT + BAR          # bord extérieur de la barre
    z0, z1 = BOTTOM - BAR, TOP + BAR
    sx = (W - 2 * EDGE) / (x1 - x0)
    sz = (H - 2 * EDGE) / (z1 - z0)
print('échelles px/unité : x %.1f  z %.1f' % (sx, sz))
def fold(p, lo, hi):
    """Coordonnée en px ; ce qui sort de [lo, hi] revient à l'intérieur, tassé de plus en plus loin."""
    if p < lo:
        return lo + FOLD * (1 - math.exp(-(lo - p) / FOLD))
    if p > hi:
        return hi - FOLD * (1 - math.exp(-(p - hi) / FOLD))
    return p
def squeeze(p, lo, hi):
    """Ce qui avance dans l'ouverture [lo, hi] (au-delà de la barre) est tassé dans FOLDIN px."""
    if lo < p < (lo + hi) / 2:
        return lo + FOLDIN * (1 - math.exp(-(p - lo) / FOLDIN))
    if (lo + hi) / 2 <= p < hi:
        return hi - FOLDIN * (1 - math.exp(-(hi - p) / FOLDIN))
    return p
s_depth = (sx + sz) / 2
inner_l, inner_r = EDGE + BAR * sx, W - EDGE - BAR * sx
inner_t, inner_b = (EDGE + BAR * sz, H - EDGE - BAR * sz) if not OVER else (E('INSET', 2.5), H - E('INSET', 2.5))
xmin = min(v.co.x for v in bm.verts); xmax = max(v.co.x for v in bm.verts)
zmin = min(v.co.z for v in bm.verts); zmax = max(v.co.z for v in bm.verts)
def zones(t, a, b, lo, hi, out_lo, out_hi, A, B):
    """[lo, a] → [out_lo, A], [a, b] → [A, B], [b, hi] → [B, out_hi] (linéaire par morceaux)."""
    if t < a:
        return out_lo + (t - lo) / (a - lo) * (A - out_lo)
    if t > b:
        return B + (t - b) / (hi - b) * (out_hi - B)
    return A + (t - a) / (b - a) * (B - A)
INS = E('INSET', 2.5)
for v in bm.verts:
    px = EDGE + (v.co.x - x0) * sx
    py = EDGE + (z1 - v.co.z) * sz            # y vers le bas, comme la page
    if OVER and not FIT:
        ins = E('INSET', 2.5)
        zt, zb = edge_at(TOPE, TX, v.co.x), edge_at(BOTE, TX, v.co.x)
        xl, xr = edge_at(LEFE, TZ, v.co.z), edge_at(RIGE, TZ, v.co.z)
        # dans l'ouverture : de bord à bord (étiré au besoin) ; dehors : décalé, à l'échelle d'origine
        if v.co.x < xl:
            px = ins - (xl - v.co.x) * sx
        elif v.co.x > xr:
            px = W - ins + (v.co.x - xr) * sx
        else:
            px = ins + (v.co.x - xl) / (xr - xl) * (W - 2 * ins)
        if v.co.z > zt:
            py = ins - (v.co.z - zt) * sz
        elif v.co.z < zb:
            py = H - ins + (zb - v.co.z) * sz
        else:
            py = ins + (zt - v.co.z) / (zt - zb) * (H - 2 * ins)
    if FIT:
        # le lecteur est à (0, 0) : le rectangle va de (-SL, -ST) à (W + SL, H + SB)
        px = zones(v.co.x, LEFT, RIGHT, xmin, xmax, -SL + 1.5, W + SL - 1.5, INS, W - INS)
        py = zones(-v.co.z, -TOP, -BOTTOM, -zmax, -zmin, -ST + 1.5, H + SB - 1.5, INS, H - INS)
    if not OVER:
        px, py = fold(px, EDGE, W - EDGE), fold(py, EDGE, H - EDGE)
    if not OVER or abs(v.co.x - (LEFT + RIGHT) / 2) < 0.2:   # débordant : seules les pointes en V du centre
        py = squeeze(py, inner_t, inner_b)
    v.co = Vector((px, v.co.y * s_depth, -py))
if OVER:
    # rien d'autre que les pointes en V n'entre sur le lecteur : les derniers éclats à l'intérieur s'en vont
    # (la barre ne recouvre que la bande de INSET px le long du bord ; ce qui s'avance plus loin est retiré)
    m = E('INSET', 2.5) + 0.3
    inside = []
    for f in bm.faces:
        c = f.calc_center_median()
        if m < c.x < W - m and m < -c.z < H - m and not abs(c.x - W / 2) < 0.2 * sx:
            inside.append(f)
    bmesh.ops.delete(bm, geom=inside, context='FACES')
    print('éclats sur le lecteur retirés :', len(inside))
bm.to_mesh(me); bm.free()
me.update()

# ---------- matériau : la texture Meshy, chrome ----------
for mat in me.materials:
    bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf:
        if not bsdf.inputs['Metallic'].is_linked:
            bsdf.inputs['Metallic'].default_value = 1.0

# ---------- éclairage et caméra ----------
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
if FIT:
    L_, T_, FW, FH = -int(SL), -int(ST), int(W + 2 * SL), int(H + ST + SB)
    import json
    json.dump({'left': int(SL), 'top': int(ST), 'width': FW, 'height': FH}, open(os.path.join(OUT, 'frame.json'), 'w'))
    print('CADRE', FW, FH, 'lecteur à', SL, ST)
elif OVER:
    xs = [v.co.x for v in me.vertices]; ys = [-v.co.z for v in me.vertices]
    PAD = 4
    L_, T_ = math.floor(min(xs)) - PAD, math.floor(min(ys)) - PAD
    R_, B_ = math.ceil(max(xs)) + PAD, math.ceil(max(ys)) + PAD
    FW, FH = R_ - L_, B_ - T_
    import json
    json.dump({'left': -L_, 'top': -T_, 'width': FW, 'height': FH}, open(os.path.join(OUT, 'frame.json'), 'w'))
    print('CADRE', FW, FH, 'lecteur à', -L_, -T_)
else:
    L_, T_, FW, FH = 0, 0, W, H
cam.data.ortho_scale = max(FW, FH)
cam.location = (L_ + FW / 2, -200, -(T_ + FH / 2)); cam.rotation_euler = (math.pi / 2, 0, 0)
cam.data.clip_end = 1000

scene.render.engine = 'CYCLES'
scene.cycles.samples = int(E('SAMPLES', 64))
scene.cycles.use_denoising = True
scene.render.film_transparent = True
scene.render.resolution_x, scene.render.resolution_y = FW * SCALE, FH * SCALE
scene.view_settings.view_transform = 'Standard'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.filepath = os.path.join(OUT, 'frame.png')
bpy.ops.render.render(write_still=True)
print('FIN')
