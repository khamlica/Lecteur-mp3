# Cadre « SAVAGE » du téléphone (thème SAVAGE, android/app/src/web/mobile.css) : le même chrome liquide que le cadre
# du bureau (shade.py), mais pour le plein écran. Deux pièces :
#   - le bord de l'écran : un jonc aux coins arrondis, deux épines à chaque coin, un ornement tribal au milieu de
#     chaque côté. Rendu une fois sur un écran de référence (412 × 924 px), puis découpé : les coins et les ornements
#     gardent leur taille, les tronçons droits du jonc (rails) sont étirés entre eux, comme les rails du widget ;
#   - le sertissage de la pochette : un jonc qui l'épouse, une griffe à chaque coin et une épine au milieu de
#     chaque côté. Il suit la pochette (after.js) et s'agrandit avec elle.
# Sorties (3×, le sertissage à 2×) dans android/app/src/web/skins/ : savage-mobile-<pièce>.png (chrome + ombre) et
# savage-mobile-<pièce>-mask.png (le chrome seul, masque du reflet qui en fait le tour).
#   python chrome_mobile.py [dossier de sortie]
import os, sys
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from shade import chrome, read, place

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '..', '..', 'android', 'app', 'src', 'web', 'skins')
HI, LO = 4, 3  # tracé à 4×, sortie à 3×
os.environ.setdefault('MAXW', '9')  # pièces bombées bien plus épaisses que sur la barre du bureau : du métal massif

TOP, COVER = read('top.txt'), read('cover.txt')

# Mêmes valeurs que mobile.css (--savage-*) : elles décrivent la découpe
W, H = 412, 924
RING, R = 6, 28           # épaisseur du jonc, rayon des coins de l'écran (celui du reflet du verre, .fx-rim)
CT = 78                   # côté d'une pièce de coin
TOP_W, TOP_H = 240, 26    # ornement du haut (pièce découpée, ombre comprise)
BOT_W, BOT_H = 204, 23    # du bas
SIDE_W, SIDE_H = 22, 176  # des côtés
RAIL = 14                 # épaisseur d'un rail (jonc + ombre)
COVER_SIZE, COVER_R, COVER_M = 338, 18, 34   # pochette de référence, son arrondi, la marge des griffes
COVER_RING = 3.5
SHADOW = (0.9, 0.7, 0.8, 0.45)     # ombre portée courte et nette : décalage, flou (px), opacité


def polygons(img, polys, k):
    dr = ImageDraw.Draw(img)
    for poly in polys:
        dr.polygon([(x * k, y * k) for x, y in poly], fill=255)


def transposed(lines, ox, oy, w, h, vw, vh, right=False):
    # un ornement du haut posé sur un côté : sa base contre le bord, sa longueur le long du côté
    for poly in place(lines, 0, 0, h, w, vw, vh):
        yield [(ox + (w - y if right else y), oy + x) for x, y in poly]


def cubic(p0, c1, c2, p1, n=40):
    return [tuple((1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d
                  for a, b, c, d in zip(p0, c1, c2, p1)) for t in (i / n for i in range(n + 1))]


def thorn(base_a, base_b, tip, bend):
    # une épine tribale : de sa base (deux points sur la pièce) à sa pointe, courbée de `bend` (px, sur le côté)
    (ax, ay), (bx, by), (tx, ty) = base_a, base_b, tip
    mx, my = (ax + bx) / 2, (ay + by) / 2
    dx, dy = tx - mx, ty - my
    n = (dy, -dx)
    k = bend / max(1e-6, (dx * dx + dy * dy) ** 0.5)
    c = (mx + dx * 0.55 + n[0] * k, my + dy * 0.55 + n[1] * k)
    return cubic(base_a, ((ax + c[0]) / 2, (ay + c[1]) / 2), c, tip)[:-1] + cubic(tip, c, ((bx + c[0]) / 2, (by + c[1]) / 2), base_b)


def fillet(mask, k):
    # raccords fondus entre les pièces (comme chrome.py)
    f = float(os.environ.get('FILLET', 0.7))
    yy, xx = np.mgrid[-int(f * k):int(f * k) + 1, -int(f * k):int(f * k) + 1]
    disk = xx * xx + yy * yy <= (f * k) ** 2
    return np.maximum(mask, ndimage.binary_closing(mask > 0.5, structure=disk).astype(np.float32))


def save(arr, w, h, name, lo):
    mode = 'RGBA' if arr.ndim == 3 else 'L'
    im = Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8), mode).resize((w * lo, h * lo), Image.LANCZOS)
    im.save(os.path.join(OUT, name), optimize=True)
    return im


def render(img, w, h, lo=LO):
    # le chrome liquide du bureau, bombé sur toute la largeur des pièces ; une ombre courte et nette, sans halo
    frame, alpha = chrome(fillet(np.asarray(img, dtype=np.float32) / 255, HI), HI, shadow=SHADOW)
    white = np.ones_like(alpha)
    return save(frame, w, h, '_frame.png', lo), save(np.dstack([white, white, white, alpha]), w, h, '_mask.png', lo)


os.makedirs(OUT, exist_ok=True)

# ---------- le bord de l'écran ----------
img = Image.new('L', (W * HI, H * HI), 0)
dr = ImageDraw.Draw(img)
# plein jusqu'aux bords de l'écran, coins compris : l'arrondi de l'écran du téléphone rogne ce qui dépasse
dr.rectangle([0, 0, W * HI - 1, H * HI - 1], fill=255)
dr.rounded_rectangle([RING * HI, RING * HI, (W - RING) * HI - 1, (H - RING) * HI - 1], radius=(R - RING) * HI, fill=0)
# une équerre pleine dans chaque coin, qui remplit l'arrondi ; en haut, elle descend le long du côté plutôt que
# vers le centre, pour laisser l'heure et les icônes de la barre d'état
# Dans chaque coin, le jonc s'épaissit (plein jusqu'à l'angle de l'écran, son arrondi intérieur seul reste) et
# des épines épaisses en sortent : vers le bas le long du côté en haut (l'heure reste dégagée), le long des deux
# bords et vers l'intérieur en bas
polys = []
for fx, fy in [(1, 1), (-1, 1), (1, -1), (-1, -1)]:
    if fy > 0:
        shapes = [thorn((0, R + 2), (RING + 6, R + 4), (2, R + 46), -6)]
    else:
        shapes = [thorn((0, R + 2), (RING + 7, R + 4), (2, R + 40), -6),
                  thorn((R + 2, 0), (R + 4, RING + 7), (R + 40, 2), 6),
                  thorn((8, 15), (15, 8), (36, 36), 0)]
    for shape in shapes:
        polys.append([(x if fx > 0 else W - x, y if fy > 0 else H - y) for x, y in shape])
polys += place(TOP, (W - 236) / 2, 0, 236, 20, 300, 14)
polys += place(TOP, (W - 200) / 2, H - 17, 200, 17, 300, 14, fy=-1)
polys += transposed(TOP, 0, (H - 170) / 2, 16, 170, 300, 14)
polys += transposed(TOP, W - 16, (H - 170) / 2, 16, 170, 300, 14, right=True)
polygons(img, polys, HI)
frame, mask = render(img, W, H)

pieces = {
    'tl': (0, 0, CT, CT), 'tr': (W - CT, 0, W, CT), 'bl': (0, H - CT, CT, H), 'br': (W - CT, H - CT, W, H),
    'top': ((W - TOP_W) / 2, 0, (W + TOP_W) / 2, TOP_H), 'bottom': ((W - BOT_W) / 2, H - BOT_H, (W + BOT_W) / 2, H),
    'left': (0, (H - SIDE_H) / 2, SIDE_W, (H + SIDE_H) / 2), 'right': (W - SIDE_W, (H - SIDE_H) / 2, W, (H + SIDE_H) / 2),
    # rails : 4 px de jonc droit, pris entre un coin et un ornement
    'rail-top': (82, 0, 86, RAIL), 'rail-bottom': (82, H - RAIL, 86, H),
    'rail-left': (0, 300, RAIL, 304), 'rail-right': (W - RAIL, 300, W, 304),
}
for name, box in pieces.items():
    box = tuple(round(v * LO) for v in box)
    frame.crop(box).save(os.path.join(OUT, f'savage-mobile-{name}.png'), optimize=True)
    mask.crop(box).save(os.path.join(OUT, f'savage-mobile-{name}-mask.png'), optimize=True)

# ---------- le sertissage de la pochette ----------
S = COVER_SIZE + 2 * COVER_M
img = Image.new('L', (S * HI, S * HI), 0)
dr = ImageDraw.Draw(img)
a, b = COVER_M, COVER_M + COVER_SIZE
dr.rounded_rectangle([(a - COVER_RING) * HI, (a - COVER_RING) * HI, (b + COVER_RING) * HI - 1, (b + COVER_RING) * HI - 1], radius=(COVER_R + COVER_RING) * HI, fill=255)
dr.rounded_rectangle([a * HI, a * HI, b * HI - 1, b * HI - 1], radius=COVER_R * HI, fill=0)
claw, spike = COVER[3], COVER[4]   # (cover.txt, en px du bureau : la griffe du coin, l'épine du côté)
K = 2.2
polys = []
# la griffe : posée sur l'arrondi du coin (à 45°), pointe vers l'extérieur
inset = (COVER_R + COVER_RING) * (1 - 2 ** -0.5) - 1
for fx, fy in [(1, 1), (-1, 1), (1, -1), (-1, -1)]:
    for poly in place([claw], 0, 0, 88, 88, 88, 88):
        pts = [(a + inset + (x - 12) * K, a + inset + (y - 12) * K) for x, y in poly]   # coin en haut à gauche
        polys.append([(x if fx > 0 else S - x, y if fy > 0 else S - y) for x, y in pts])
# l'épine : base dans le jonc, au milieu du haut et du bas (sur les côtés, elle ferait doublon avec les ornements
# du bord de l'écran, tout près)
for top in (True, False):
    for poly in place([spike], 0, 0, 88, 88, 88, 88):
        # tracée sur le côté gauche, puis tournée vers le haut ou le bas
        pts = [(a - 1.5 + (x - 9.4) * K, S / 2 + (y - 44) * K) for x, y in poly]
        polys.append([(y, x) if top else (y, S - x) for x, y in pts])
polygons(img, polys, HI)
# à 2× seulement : agrandi avec la pochette, c'est la plus grande image (3× : 12 Mo une fois décodée)
frame, mask = render(img, S, S, 2)
frame.save(os.path.join(OUT, 'savage-mobile-cover.png'), optimize=True)
mask.save(os.path.join(OUT, 'savage-mobile-cover-mask.png'), optimize=True)
for tmp in ('_frame.png', '_mask.png'):
    os.remove(os.path.join(OUT, tmp))
print('ok', OUT)
