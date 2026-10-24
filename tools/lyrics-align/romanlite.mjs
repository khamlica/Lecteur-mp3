// Romanisation minimale pour l'alignement (provisoire) : hangul syllabe par syllabe, kana en Hepburn.
const I = ['g','kk','n','d','tt','r','m','b','pp','s','ss','','j','jj','ch','k','t','p','h'];
const V = ['a','ae','ya','yae','eo','e','yeo','ye','o','wa','wae','oe','yo','u','wo','we','wi','yu','eu','ui','i'];
const F = ['','k','k','k','n','n','n','t','l','k','m','l','l','l','p','l','m','p','p','t','t','ng','t','t','k','t','p','t'];
const KANA = { あ:'a',い:'i',う:'u',え:'e',お:'o',か:'ka',き:'ki',く:'ku',け:'ke',こ:'ko',さ:'sa',し:'shi',す:'su',せ:'se',そ:'so',た:'ta',ち:'chi',つ:'tsu',て:'te',と:'to',な:'na',に:'ni',ぬ:'nu',ね:'ne',の:'no',は:'ha',ひ:'hi',ふ:'fu',へ:'he',ほ:'ho',ま:'ma',み:'mi',む:'mu',め:'me',も:'mo',や:'ya',ゆ:'yu',よ:'yo',ら:'ra',り:'ri',る:'ru',れ:'re',ろ:'ro',わ:'wa',を:'o',ん:'n',が:'ga',ぎ:'gi',ぐ:'gu',げ:'ge',ご:'go',ざ:'za',じ:'ji',ず:'zu',ぜ:'ze',ぞ:'zo',だ:'da',ぢ:'ji',づ:'zu',で:'de',ど:'do',ば:'ba',び:'bi',ぶ:'bu',べ:'be',ぼ:'bo',ぱ:'pa',ぴ:'pi',ぷ:'pu',ぺ:'pe',ぽ:'po',ゃ:'ya',ゅ:'yu',ょ:'yo',ぁ:'a',ぃ:'i',ぅ:'u',ぇ:'e',ぉ:'o',ゔ:'vu' };
export function romanLite(text) {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c >= 0xac00 && c <= 0xd7a3) { const s = c - 0xac00; out += I[Math.floor(s / 588)] + V[Math.floor((s % 588) / 28)] + F[s % 28]; continue; }
    let k = ch;
    if (c >= 0x30a1 && c <= 0x30f6) k = String.fromCodePoint(c - 0x60);
    if (k === 'っ' || k === 'ッ') { out += '~'; continue; }
    if (k === 'ー') { out += out.slice(-1); continue; }
    if (KANA[k]) { if (/[ゃゅょ]/.test(k) && /i$/.test(out)) { out = out.slice(0, -1); out += /(ch|sh|j)$/.test(out) ? KANA[k].slice(1) : KANA[k]; } else out += KANA[k]; if (out.includes('~')) out = out.replace(/~(.)/, '$1$1'); continue; }
    out += ch;
  }
  return out.replace(/~/g, '');
}
