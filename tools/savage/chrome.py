# Cadre « SAVAGE » : jonc et épines tribales en chrome liquide, en relief, pour la fenêtre de 540 × 88 px.
# Le volume est calculé depuis la forme (carte de distance au bord → hauteur au profil arrondi → normales),
# éclairé par le reflet d'un environnement de studio (bandes claires et sombres, lumière principale en haut à
# gauche, légère irisation comme le logo) plus un éclat spéculaire ; ombre portée douce sur le verre.
# Sorties (3× : 1620 × 264) : frame.png (chrome + ombre) et mask.png (le chrome seul, masque du reflet animé).
#   python chrome.py <dossier de sortie>   (réglages par défaut : ceux de src/renderer/skins/savage-*.png)
import re, sys, os, math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else HERE
W, H = 540, 88
HI, LO = 6, 3  # tracé à 6×, sortie à 3×

def parse(d):
    toks = re.findall(r'[MCLZ]|-?\d+\.?\d*', d)
    out, cur, i, cmd = [], [], 0, None
    while i < len(toks):
        t = toks[i]
        if t in 'MCLZ':
            cmd = t; i += 1
            if cmd == 'Z':
                if cur: out.append(cur)
                cur = []
                continue
        if cmd == 'M':
            cur = [(float(toks[i]), float(toks[i + 1]))]; i += 2; cmd = 'L'
        elif cmd == 'L':
            cur.append((float(toks[i]), float(toks[i + 1]))); i += 2
        elif cmd == 'C':
            p0 = cur[-1]
            c1 = (float(toks[i]), float(toks[i + 1])); c2 = (float(toks[i + 2]), float(toks[i + 3])); p = (float(toks[i + 4]), float(toks[i + 5]))
            for k in range(1, 41):
                s = k / 40
                cur.append(tuple((1 - s) ** 3 * a + 3 * (1 - s) ** 2 * s * b + 3 * (1 - s) * s * s * c + s ** 3 * e
                                 for a, b, c, e in zip(p0, c1, c2, p)))
            i += 6
    if cur: out.append(cur)
    return out

def read(name):
    return [l for l in open(os.path.join(HERE, name), encoding='utf8').read().split('\n') if l.strip()]

def place(lines, ox, oy, w, h, vw, vh, fx=1, fy=1):
    for d in lines:
        for c in parse(d):
            yield [(ox + (x / vw * w if fx > 0 else w - x / vw * w), oy + (y / vh * h if fy > 0 else h - y / vh * h)) for x, y in c]

# ---------- forme (masque à 6×) ----------
img = Image.new('L', (W * HI, H * HI), 0)
dr = ImageDraw.Draw(img)
RING = float(os.environ.get('RING', 3.2))  # épaisseur du jonc (px)
R = 8                                       # rayon des coins de la fenêtre
dr.rounded_rectangle([0, 0, W * HI - 1, H * HI - 1], radius=R * HI, fill=255)
dr.rounded_rectangle([RING * HI, RING * HI, (W - RING) * HI - 1, (H - RING) * HI - 1], radius=max(1, (R - RING)) * HI, fill=0)
TOP, CORNER, COVER = read('top.txt'), read('corner.txt'), read('cover.txt')
# sertissage chromé autour de la pochette (64 px à 12 px du bord), et ses pièces tribales (cover.txt, en px,
# la moitié haute : la moitié basse en est le reflet)
dr.rounded_rectangle([9 * HI, 9 * HI, 79 * HI, 79 * HI], radius=10.5 * HI, fill=255)
dr.rounded_rectangle([12 * HI, 12 * HI, 76 * HI, 76 * HI], radius=8 * HI, fill=0)
for d in COVER:
    for c in parse(d):
        dr.polygon([(x * HI, y * HI) for x, y in c], fill=255)
        dr.polygon([(x * HI, (H - y) * HI) for x, y in c], fill=255)
pieces = list(place(TOP, 175, 0, 260, 11, 300, 14)) + list(place(TOP, 195, H - 9, 220, 9, 300, 14, fy=-1))
for fx, fy, ox, oy in [(-1, 1, W - 15, 0), (-1, -1, W - 15, H - 15)]:
    pieces += list(place(CORNER, ox, oy, 15, 15, 14, 14, fx, fy))
for poly in pieces:
    dr.polygon([(x * HI, y * HI) for x, y in poly], fill=255)
mask = np.asarray(img, dtype=np.float32) / 255
# raccords fondus entre les pièces (comme du métal coulé) : une fermeture adoucit les angles rentrants sans
# émousser les pointes
FILLET = float(os.environ.get('FILLET', 0.7))
if FILLET > 0:
    yy, xx = np.mgrid[-int(FILLET * HI):int(FILLET * HI) + 1, -int(FILLET * HI):int(FILLET * HI) + 1]
    disk = xx * xx + yy * yy <= (FILLET * HI) ** 2
    mask = np.maximum(mask, ndimage.binary_closing(mask > 0.5, structure=disk).astype(np.float32))

# ---------- volume : hauteur au profil arrondi depuis la distance au bord ----------
inside = mask > 0.5
dist = ndimage.distance_transform_edt(inside) / HI          # en px
# section ronde pour chaque trait, quelle que soit son épaisseur : la demi-épaisseur locale r (le maximum de
# la distance au bord alentour) donne un demi-cercle h = √(r² − (r − d)²), du bord vertical à la crête
MAXW = float(os.environ.get('MAXW', 3))                    # demi-épaisseur la plus grande attendue (px)
r = ndimage.grey_dilation(dist, size=(int(2 * MAXW * HI) | 1,) * 2)
r = np.maximum(ndimage.gaussian_filter(r, MAXW * HI / 3), 0.3)
dd = np.minimum(dist, r)
height = np.sqrt(np.maximum(0, r * r - (r - dd) ** 2))
height = ndimage.gaussian_filter(height, 0.35 * HI)        # adoucit l'axe des lames sans aplatir
height *= inside
gy, gx = np.gradient(height * HI)
k = float(os.environ.get('RELIEF', 1.4))
n = np.dstack([-gx * k, -gy * k, np.ones_like(gx)])
n /= np.linalg.norm(n, axis=2, keepdims=True)
nx, ny, nz = n[..., 0], n[..., 1], n[..., 2]

# ---------- éclairage : reflet d'un studio + éclat ----------
# direction réfléchie pour une vue de face (v = (0, 0, 1)) ; y vers le bas de l'image
rx, ry, rz = 2 * nz * nx, 2 * nz * ny, 2 * nz * nz - 1
elev = np.clip(rz, -1, 1)                       # 1 : droit vers le spectateur ; 0 : horizon
az = np.arctan2(ry, rx)                          # côté d'où vient le reflet
def band(x, a, b, soft=0.05):                    # 1 entre a et b, adouci
    return np.clip((x - a) / soft, 0, 1) * np.clip((b - x) / soft, 0, 1)
# Structure du chrome du logo SAVAGE (mesurée : 19 % de pixels presque noirs, 32 % presque blancs) : une
# crête blanche face au spectateur, une bande sombre sur la pente, un liseré clair sur le flanc, un fin trait
# sombre tout au bord ; reflets pêche d'un côté, cyan de l'autre
def smooth(x, a, b):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)
crest = smooth(elev, float(os.environ.get('CREST', 0.80)), 1.0)                    # 1 sur la crête
FL = float(os.environ.get('FLANK', 0.42))
flank = smooth(elev, 0.05, 0.2) * (1 - smooth(elev, FL, FL + 0.16))  # liseré clair du flanc
edge = 1 - smooth(elev, -0.2, 0.08)                  # tout au bord : sombre
# luminosité du reflet selon l'angle (de -0,2 : tout au bord, à 1 : face au spectateur), continue pour avoir
# les dégradés du chrome : liseré clair au flanc, bande sombre sur la pente, crête blanche
ENV = [float(v) for v in os.environ.get('ENV', '-0.6:0.25,-0.2:0.55,0:0.85,0.15:1,0.32:0.55,0.48:0.08,0.66:0.4,0.82:1,1:1').replace(':', ',').split(',')]
env = np.interp(elev, ENV[0::2], ENV[1::2])
key = np.clip(-(rx * 0.6 + ry * 0.8), 0, 1) ** 3    # lumière principale en haut à gauche, sur les pentes
env = env + 0.6 * key * (1 - crest) * (elev > 0.3)
warm = np.clip(np.cos(az - 2.4), 0, 1) * flank        # pêche sur un flanc
cool = np.clip(np.cos(az + 0.8), 0, 1) * (flank + 0.5 * (1 - crest) * (elev > 0.5))  # cyan sur l'autre
base = np.array([0.80, 0.82, 0.88])                   # le noir du chrome tire vers le bleu nuit
rgb = env[..., None] * np.ones(3) * (0.85 + 0.15 * base)
rgb = rgb + 0.18 * warm[..., None] * np.array([1.0, 0.55, 0.25]) + 0.20 * cool[..., None] * np.array([0.15, 0.65, 1.0])
rgb = rgb * np.where(env[..., None] < 0.3, base, 1)
# éclat spéculaire net (lumière en haut à gauche, devant)
L = np.array([-0.45, -0.6, 0.66]); L /= np.linalg.norm(L)
Hv = L + np.array([0, 0, 1.0]); Hv /= np.linalg.norm(Hv)
spec = np.clip(nx * Hv[0] + ny * Hv[1] + nz * Hv[2], 0, 1) ** 90
rgb += 1.2 * spec[..., None]
rgb = np.clip(rgb * float(os.environ.get('GAIN', 1.0)), 0, 1)   # les blancs du chrome vont jusqu'au blanc pur
rgb = np.clip(rgb, 0, 1)

# ---------- ombre portée (vers le bas à droite) et assemblage ----------
alpha = ndimage.gaussian_filter(mask, 0.6)        # bord antialiasé
shadow = ndimage.shift(mask, (1.6 * HI, 1.1 * HI), order=1)
shadow = ndimage.gaussian_filter(shadow, 2.2 * HI) * 0.55
out_a = alpha + shadow * (1 - alpha)
out_rgb = (rgb * alpha[..., None]) / np.maximum(out_a[..., None], 1e-6)   # l'ombre est noire
frame = np.dstack([out_rgb, out_a])
def save(arr, name):
    im = Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8), 'RGBA' if arr.shape[-1] == 4 else 'L')
    im = im.resize((W * LO, H * LO), Image.LANCZOS)
    im.save(os.path.join(OUT, name))
save(frame, 'frame.png')
save(np.dstack([np.ones_like(alpha), np.ones_like(alpha), np.ones_like(alpha), alpha]), 'mask.png')  # le masque CSS lit la transparence
print('ok', os.path.join(OUT, 'frame.png'))
