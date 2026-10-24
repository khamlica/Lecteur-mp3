# Paroles mot à mot : banc d'essai (non livré dans l'app)

L'app affiche les paroles **ligne par ligne** (LRCLIB, fichier `.lrc`, tags du fichier). Le mot à mot n'est
affiché que si la source donne l'instant de chaque mot (LRC étendu). Ce dossier garde les deux méthodes de calage
mot à mot essayées, et leurs mesures, au cas où on y reviendrait. Il n'est pas empaqueté (seuls `src/` et
`assets/` le sont).

## Mesures (JamendoLyrics, 79 morceaux annotés à la main, débuts de lignes simulés comme un LRC à ±0,3 s)

| Méthode | Mots à ≤ 0,3 s | Bon mot surligné | … à 150 ms près |
|---|---|---|---|
| Répartition par syllabes (`spread.mjs`) | 68 % | 55 % du temps | 70 % |
| Alignement CTC, MMS-300M, fenêtres des lignes ±0,75 s (`align.mjs`) | 93 % | 84 % du temps | 93 % |

Décision (2026-10-24) : la répartition par syllabes n'est pas fiable ; l'alignement l'est, mais le modèle pèse
631 Mo et demande ~3 à 12 s par morceau sur la carte graphique, ~1 min sur le processeur seul : pas livré.

Exactitude des horodatages de **lignes** de LRCLIB sur les fichiers de l'utilisateur (clips YouTube), mesurée avec
l'aligneur : 14 morceaux sur 18 à moins de 0,5 s ; STAY (+3,2 s, intro du clip), Sultans Of Swing (−1 s),
BOOMPALA (−0,7 s) décalés en bloc ; Hootie Frutti mal minuté à la source. D'où le recalage à la main dans la fenêtre
des paroles (clic droit sur une ligne au moment où elle est chantée).

## Utilisation

- Modèle : `models/mms_300m_fa_fp16.onnx` + `models/vocab.json` (non commités), depuis
  https://huggingface.co/tatsu020/mms-300m-fa-onnx (licence CC-BY-NC-4.0). 16 kHz mono, une image toutes les 20 ms,
  lettres a–z et apostrophe : le coréen et le japonais doivent être romanisés (`romanlite.mjs`, provisoire).
- `node decode.mjs fichiers…` → `pcm/<nom>.f32` (16 kHz mono) ; `node emit.mjs pcm/*.f32` → `em/<nom>.em`
  (probabilités en cache) ; `JAMENDO=<clone de github.com/f90/jamendolyrics> node benchCW.mjs '{"sigma":0.3,"delta":0.75}'`.
- DirectML : sur un portable, l'adaptateur 0 est souvent la puce intégrée (aussi lent que le processeur) ; la carte
  dédiée est `DML_DEVICE=1` (~0,4 s par fenêtre de 20 s sur une RTX 4050).
- `viterbi()` rend aussi une confiance par mot (log-prob moyenne des lettres) : au-dessus de −3, 77 % des lignes
  gardées dont 96 % justes (89 % sans tri).
