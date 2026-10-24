// Méthode A : répartition des mots d'une ligne selon leurs syllabes.
export function syllables(word) {
  const w = word.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  let n = 0;
  n += (w.match(/[가-힣]/g) || []).length;                         // hangul : 1 par bloc
  n += (w.match(/[ぁ-ゖァ-ヺー]/g) || []).length
     - (w.match(/[ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ]/g) || []).length;  // kana : 1 par more
  n += 1.6 * (w.match(/[一-鿿]/g) || []).length;                   // kanji : ~1,6 more
  const latin = w.replace(/[^a-z]/g, '');
  if (latin) {
    let v = (latin.replace(/e$/, '').match(/[aeiouy]+/g) || []).length;
    n += Math.max(1, v);
  }
  return Math.max(1, n);
}
// lines : [{ start, next (début de la ligne suivante ou null), words: [texte] }]
// opts.maxSyl : durée maximale d'une syllabe (s) ; la ligne s'arrête avant si elle est courte
export function spread(lines, { maxSyl = Infinity, minSyl = 0 } = {}) {
  return lines.map((l) => {
    const syl = l.words.map(syllables), total = syl.reduce((a, b) => a + b, 0);
    let span = (l.next ?? l.start + total * 0.3) - l.start;
    span = Math.min(span, total * maxSyl);
    const out = []; let acc = 0;
    for (const s of syl) { out.push(l.start + span * acc / total); acc += s; }
    return out;
  });
}
