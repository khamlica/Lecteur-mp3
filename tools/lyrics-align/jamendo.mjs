// Chargement de JamendoLyrics : lignes (début, fin, texte) et mots (début, fin, texte), regroupés par ligne.
import fs from 'fs'; import path from 'path';
export const J = path.resolve(process.env.JAMENDO || '../data/jamendolyrics');
const csv = (f) => fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split(','));
export function loadSongs() {
  const meta = csv(path.join(J, 'JamendoLyrics.csv'));
  return meta.map((m) => {
    const name = m[1].replace(/\.mp3$/, '');
    const lines = fs.readFileSync(path.join(J, 'annotations/lines', name + '.csv'), 'utf8').trim().split(/\r?\n/).slice(1)
      .map((l) => { const [s, e, ...t] = l.split(','); return { start: +s, end: +e, text: t.join(',').replace(/^"|"$/g, '') }; });
    const wt = csv(path.join(J, 'annotations/words', name + '.csv')).map(([s, e]) => ({ start: +s, end: +e }));
    const wx = fs.readFileSync(path.join(J, 'lyrics', name + '.words.txt'), 'utf8').trim().split(/\r?\n/);
    let k = 0, ok = wt.length === wx.length;
    for (const line of lines) {
      const toks = line.text.trim().split(/\s+/);
      line.words = toks.map((t) => ({ text: t, ...wt[k++] }));
    }
    if (k !== wt.length) ok = false;
    return { name, lang: m[6], genre: m[4], lines, ok };
  });
}
