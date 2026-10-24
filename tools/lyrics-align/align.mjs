// Alignement forcé CTC (MMS-300M FA, ONNX) : probabilités des lettres toutes les 20 ms, puis chemin de Viterbi
// qui suit le texte connu.
import { createRequire } from 'module'; import fs from 'fs';
const require = createRequire(new URL('../../package.json', import.meta.url));
const ort = require('onnxruntime-node');
const MODEL = new URL('../../models/mms_300m_fa_fp16.onnx', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const VOCAB = JSON.parse(fs.readFileSync(new URL('../../models/vocab.json', import.meta.url), 'utf8')).vocab;
export const RATE = 16000, HOP = 320, FPS = RATE / HOP;
let session;
export async function load(ep = 'dml') {
  session ??= await ort.InferenceSession.create(MODEL, { executionProviders: ep === 'cpu' ? ['cpu'] : [{ name: 'dml', deviceId: Number(process.env.DML_DEVICE ?? 1) }, 'cpu'], logSeverityLevel: 3, graphOptimizationLevel: 'all' });
  return session;
}
// → { T, V, logp: Float32Array T×V } (log-probabilités normalisées)
export async function emissions(pcm, { win = 20, ctx = 2 } = {}) {
  await load();
  const T = Math.floor(pcm.length / HOP), V = 31;
  const logp = new Float32Array(T * V);
  const W = win * RATE, C = ctx * RATE;
  for (let a = 0; a < pcm.length; a += W) {
    const s = Math.max(0, a - C), e = Math.min(pcm.length, a + W + C);
    let chunk = pcm.slice(s, e);
    let m = 0; for (const v of chunk) m += v; m /= chunk.length;
    let sd = 0; for (const v of chunk) sd += (v - m) ** 2; sd = Math.sqrt(sd / chunk.length) + 1e-7;
    chunk = chunk.map((v) => (v - m) / sd);
    const out = await session.run({ input_values: new ort.Tensor('float32', chunk, [1, chunk.length]) });
    const lg = out.logits.data, F = out.logits.dims[1];
    const f0 = Math.round((a - s) / HOP), f1 = Math.min(F, Math.round((Math.min(a + W, pcm.length) - s) / HOP));
    for (let f = f0; f < f1; f++) {
      const t = Math.round(s / HOP) + f; if (t >= T) break;
      let mx = -Infinity; for (let v = 0; v < V; v++) mx = Math.max(mx, lg[f * V + v]);
      let z = 0; for (let v = 0; v < V; v++) z += Math.exp(lg[f * V + v] - mx);
      const lz = mx + Math.log(z);
      for (let v = 0; v < V; v++) logp[t * V + v] = lg[f * V + v] - lz;
    }
  }
  return { T, V, logp };
}
// Texte d'un mot → identifiants de lettres (latin sans accents ; le reste doit être romanisé avant)
export function tokens(word) {
  const w = word.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss').replace(/[’`]/g, "'");
  return [...w].filter((c) => c in VOCAB && VOCAB[c] > 3).map((c) => VOCAB[c]);
}
// Viterbi CTC sur tous les mots ; renvoie pour chaque mot [première image, dernière image] (ou null s'il n'a pas de lettres).
// opts.star : log-prob d'un état « poubelle » entre les mots (voix hors texte, chœurs), ou null
// opts.windows : pour chaque mot, [première image permise, dernière image permise] (lignes du LRC), ou null
export function viterbi({ T, V, logp }, words, { star = null, t0 = 0, t1 = T, windows = null } = {}) {
  const toks = words.map(tokens);
  // états : blank, (lettres du mot, blank entre lettres répétées gérées par CTC), avec un état poubelle optionnel entre mots
  const lab = [], wordOf = [], kind = []; // kind 0 blank, 1 lettre, 2 poubelle
  const push = (l, w, k) => { lab.push(l); wordOf.push(w); kind.push(k); };
  push(0, -1, 0);
  toks.forEach((tk, w) => {
    if (!tk.length) return;
    for (const l of tk) { push(l, w, 1); push(0, w, 0); }
    if (star != null) { push(-1, w, 2); push(0, w, 0); }
  });
  const S = lab.length, N = t1 - t0;
  let prev = new Float32Array(S).fill(-Infinity), cur = new Float32Array(S);
  const bp = new Uint8Array(N * S);
  // fenêtre permise de chaque état : celle de son mot (les blancs entre deux mots : l'union des deux)
  const lo = new Int32Array(S).fill(t0), hi = new Int32Array(S).fill(t1);
  if (windows) {
    for (let s = 0; s < S; s++) {
      const w = wordOf[s];
      if (kind[s] === 1 && windows[w]) { lo[s] = windows[w][0]; hi[s] = windows[w][1]; }
    }
  }
  const em = (t, s) => (t < lo[s] || t > hi[s] ? -1e9 : lab[s] === -1 ? star : logp[t * V + lab[s]]);
  prev[0] = em(t0, 0); if (S > 1) prev[1] = em(t0, 1);
  for (let i = 1; i < N; i++) {
    const t = t0 + i;
    for (let s = 0; s < S; s++) {
      let best = prev[s], b = 0;
      if (s >= 1 && prev[s - 1] > best) { best = prev[s - 1]; b = 1; }
      // saut d'un blank : vers une lettre différente de la précédente (ou depuis/vers la poubelle)
      if (s >= 2 && kind[s] !== 0 && lab[s] !== lab[s - 2] && prev[s - 2] > best) { best = prev[s - 2]; b = 2; }
      // la poubelle est facultative : on peut la sauter (blank → blank, lettre → blank, → lettre suivante)
      if (s >= 3 && kind[s] === 0 && kind[s - 1] === 2) {
        if (prev[s - 2] > best) { best = prev[s - 2]; b = 2; }
        if (prev[s - 3] > best) { best = prev[s - 3]; b = 3; }
      }
      if (s >= 4 && kind[s] === 1 && kind[s - 2] === 2) {
        if (prev[s - 3] > best) { best = prev[s - 3]; b = 3; }
        if (lab[s] !== lab[s - 4] && prev[s - 4] > best) { best = prev[s - 4]; b = 4; }
      }
      cur[s] = best + em(t, s); bp[i * S + s] = b;
    }
    [prev, cur] = [cur, prev];
  }
  let s = prev[S - 1] >= prev[S - 2] ? S - 1 : S - 2;
  const first = new Int32Array(words.length).fill(-1), last = new Int32Array(words.length).fill(-1);
  const sum = new Float64Array(words.length), cnt = new Int32Array(words.length);
  // regret de chaque image : log-prob de l'état imposé par le chemin moins celle de la classe préférée du modèle
  const regret = new Float32Array(T);
  for (let i = N - 1; i >= 0; i--) {
    const t = t0 + i;
    let mx = -Infinity; for (let v = 0; v < V; v++) mx = Math.max(mx, logp[t * V + v]);
    regret[t] = Math.max(-30, (lab[s] === -1 ? star : logp[t * V + lab[s]]) - mx);
    if (kind[s] === 1) {
      const w = wordOf[s]; first[w] = t0 + i; if (last[w] < 0) last[w] = t0 + i;
      sum[w] += logp[(t0 + i) * V + lab[s]]; cnt[w]++;
    }
    s -= bp[i * S + s];
  }
  // [première image, dernière image, confiance = log-prob moyenne des lettres sur leurs images]
  const out = words.map((_, w) => (first[w] < 0 ? null : [first[w], last[w], sum[w] / cnt[w]]));
  out.regret = regret;
  return out;
}
