// Comme benchC, avec des horodatages de lignes simulés (LRC) : début réel + bruit gaussien σ, et une fenêtre ±δ.
import fs from 'fs'; import { loadSongs } from './jamendo.mjs'; import { score, summary } from './metrics.mjs'; import { viterbi, FPS } from './align.mjs';
const { sigma = 0.3, delta = 1.5, seed = 1 } = JSON.parse(process.argv[2] || '{}');
let r = seed; const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const res = [], byLang = {};
for (const s of loadSongs()) {
  const f = `em/${s.name}.em`; if (!fs.existsSync(f)) continue;
  const b = fs.readFileSync(f); const logp = new Float32Array(b.buffer, b.byteOffset, b.length / 4); const T = logp.length / 31;
  const lrc = s.lines.map((l) => l.start + sigma * gauss());
  const windows = [];
  s.lines.forEach((l, i) => {
    const a = Math.max(0, Math.floor((lrc[i] - delta) * FPS)), z = Math.min(T - 1, Math.ceil(((lrc[i + 1] ?? lrc[i] + 15) + delta) * FPS));
    l.words.forEach(() => windows.push([a, z]));
  });
  const words = s.lines.flatMap((l) => l.words.map((w) => w.text));
  const al = viterbi({ T, V: 31, logp }, words, { windows });
  let st = al.map((a) => (a ? a[0] / FPS : null));
  for (let i = 0; i < st.length; i++) if (st[i] == null) st[i] = st[i - 1] ?? st.find((x) => x != null);
  let k = 0; const pred = s.lines.map((l) => l.words.map(() => st[k++]));
  const sc = score(s.lines, pred); res.push(sc); (byLang[s.lang] ??= []).push(sc);
}
console.log(`σ=${sigma} δ=${delta}`.padEnd(14), 'tous    ', summary(res));
if (process.argv[3]) for (const [l, x] of Object.entries(byLang)) console.log(''.padEnd(14), l.padEnd(8), summary(x));
