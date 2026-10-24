// pred : pour chaque ligne, tableau des débuts de mots prédits (s). Mesures :
//  ae     : écarts absolus sur les débuts de mots
//  hl     : part du temps (pas de 10 ms, du début du 1er mot à la fin du dernier mot de chaque ligne)
//           où le mot surligné (dernier mot commencé) est le bon
const TOL = 0.15;
export function score(lines, pred) {
  const ae = []; let good = 0, total = 0, near = 0;
  lines.forEach((line, i) => {
    const p = pred[i], w = line.words;
    w.forEach((x, k) => ae.push(Math.abs(p[k] - x.start)));
    const t0 = w[0].start, t1 = w[w.length - 1].end;
    for (let t = t0; t < t1; t += 0.01) {
      let r = -1, q = -1, ra = -1, rb = -1;
      for (let k = 0; k < w.length; k++) { if (w[k].start <= t) r = k; if (p[k] <= t) q = k; if (w[k].start <= t - TOL) ra = k; if (w[k].start <= t + TOL) rb = k; }
      total++; if (r === q) good++;
      if (q >= ra && q <= rb) near++; // à ±150 ms près du bon changement de mot
    }
  });
  return { ae, good, total, near };
}
export function summary(list) {
  const ae = list.flatMap((s) => s.ae).sort((a, b) => a - b);
  const good = list.reduce((s, x) => s + x.good, 0), total = list.reduce((s, x) => s + x.total, 0), near = list.reduce((s, x) => s + x.near, 0);
  const pc = (t) => (100 * ae.filter((v) => v <= t).length / ae.length).toFixed(1);
  return `mots ${ae.length} | médiane ${(ae[ae.length >> 1] * 1000).toFixed(0)} ms | ≤0,1 s ${pc(0.1)} % | ≤0,3 s ${pc(0.3)} % | ≤0,5 s ${pc(0.5)} % | bon mot ${(100 * good / total).toFixed(1)} % du temps (à 150 ms près ${(100 * near / total).toFixed(1)} %)`;
}
