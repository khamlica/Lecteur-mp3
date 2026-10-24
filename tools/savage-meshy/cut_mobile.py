# Cadre Meshy du téléphone, étape 3 : découpe le rendu de adapt_mobile.py (frame.png, écran de référence, 3×) en
# pièces pour mobile.css (thème SAVAGE ENHANCED) : les quatre coins, les ornements du haut et du bas, le milieu de
# chaque côté, et des tranches du jonc, étirées entre eux (en largeur en haut et en bas, en hauteur sur les côtés).
# Chaque pièce a son masque (la silhouette du chrome, pour le reflet qui en fait le tour).
#   python cut_mobile.py <dossier du rendu> [dossier de sortie]
import json, os, sys
from PIL import Image

SRC = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                                                         'android', 'app', 'src', 'web', 'skins')
K = 3
info = json.load(open(os.path.join(SRC, 'frame.json')))
W, H, knots = info['width'], info['height'], info['knots']
frame = Image.open(os.path.join(SRC, 'frame.png'))
assert frame.size == (W * K, H * K), frame.size

# Mêmes valeurs que mobile.css (--enhanced-*)
TOP = 52      # hauteur du haut : les coins, l'ornement, et les pointes du centre qui avancent dans l'écran
BOTTOM = 60   # du bas
MID = 74      # hauteur du milieu des côtés, centré sur l'écran
SIDE = 48     # largeur des pièces des côtés
CORNER = 86   # largeur des coins (le haut et le bas)
RAIL_X = 81   # où prendre la tranche du jonc du haut et du bas (entre un coin et l'ornement)
assert knots[1] + 6 <= TOP and H - (knots[4] - 6) <= BOTTOM, knots
assert H / 2 - MID / 2 <= knots[2] - 4 and H / 2 + MID / 2 >= knots[3] + 4, knots

pieces = {
    'tl': (0, 0, CORNER, TOP), 'top': (CORNER, 0, W - CORNER, TOP), 'tr': (W - CORNER, 0, W, TOP),
    'bl': (0, H - BOTTOM, CORNER, H), 'bottom': (CORNER, H - BOTTOM, W - CORNER, H), 'br': (W - CORNER, H - BOTTOM, W, H),
    'rail-top': (RAIL_X, 0, RAIL_X + 2, TOP), 'rail-bottom': (RAIL_X, H - BOTTOM, RAIL_X + 2, H),
    'left': (0, (H - MID) / 2, SIDE, (H + MID) / 2), 'right': (W - SIDE, (H - MID) / 2, W, (H + MID) / 2),
    # les tronçons des côtés entiers, entre un coin et le milieu : allongés d'un bloc, leurs deux bouts raccordent
    # exactement (une tranche prise au milieu n'a pas le reflet de ses extrémités)
    'rail-left-top': (0, TOP, SIDE, (H - MID) / 2), 'rail-left-bottom': (0, (H + MID) / 2, SIDE, H - BOTTOM),
    'rail-right-top': (W - SIDE, TOP, W, (H - MID) / 2), 'rail-right-bottom': (W - SIDE, (H + MID) / 2, W, H - BOTTOM),
}
os.makedirs(OUT, exist_ok=True)
for name, box in pieces.items():
    piece = frame.crop(tuple(round(v * K) for v in box))
    piece.save(os.path.join(OUT, f'savage-enhanced-{name}.png'), optimize=True)
    alpha = piece.getchannel('A')
    mask = Image.new('RGBA', piece.size, (255, 255, 255, 0))
    mask.putalpha(alpha)
    mask.save(os.path.join(OUT, f'savage-enhanced-{name}-mask.png'), optimize=True)
print('ok', OUT)
