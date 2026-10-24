# Chrome liquide en relief, calculé depuis une forme : carte de distance au bord → hauteur au profil arrondi →
# normales, éclairées par le reflet d'un studio et un éclat, plus une ombre portée douce. Partagé par le cadre du
# bureau (chrome.py) et celui du téléphone (chrome_mobile.py).
# Tracés : parse lit un chemin SVG (M, C, L, Z), read un fichier de chemins, place les pose dans un rectangle.
#   mask : forme (0..1) tracée à HI pixels par px ; rend (frame RGBA, alpha du chrome seul), à la même échelle
import os, re
import numpy as np
from scipy import ndimage

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
    return [l for l in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), name), encoding='utf8').read().split('\n') if l.strip()]

def place(lines, ox, oy, w, h, vw, vh, fx=1, fy=1):
    for d in lines:
        for c in parse(d):
            yield [(ox + (x / vw * w if fx > 0 else w - x / vw * w), oy + (y / vh * h if fy > 0 else h - y / vh * h)) for x, y in c]

# Le chrome
# shadow : ombre portée (décalage x, y, flou en px ; opacité)
def chrome(mask, HI, shadow=(1.6, 1.1, 2.2, 0.55)):
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
    dx, dy, blur, strength = shadow
    shade = ndimage.shift(mask, (dx * HI, dy * HI), order=1)
    shade = ndimage.gaussian_filter(shade, blur * HI) * strength
    out_a = alpha + shade * (1 - alpha)
    out_rgb = (rgb * alpha[..., None]) / np.maximum(out_a[..., None], 1e-6)   # l'ombre est noire
    frame = np.dstack([out_rgb, out_a])
    return frame, alpha
