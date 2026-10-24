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
from shade import chrome, parse, read, place

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else HERE
W, H = 540, 88
HI, LO = 6, 3  # tracé à 6×, sortie à 3×

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

frame, alpha = chrome(mask, HI)
def save(arr, name):
    im = Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8), 'RGBA' if arr.shape[-1] == 4 else 'L')
    im = im.resize((W * LO, H * LO), Image.LANCZOS)
    im.save(os.path.join(OUT, name))
save(frame, 'frame.png')
save(np.dstack([np.ones_like(alpha), np.ones_like(alpha), np.ones_like(alpha), alpha]), 'mask.png')  # le masque CSS lit la transparence
print('ok', os.path.join(OUT, 'frame.png'))
