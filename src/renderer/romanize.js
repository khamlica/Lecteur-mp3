// Romanisation des paroles : coréen (romanisation révisée, avec les règles de prononciation) et japonais (Hepburn,
// lectures des kanji par kuromoji + IPADIC). Script classique : définit globalThis.Romanize (et module.exports sous Node).
//
//   Romanize.korean(text)                → chaîne (synchrone)
//   await Romanize.japaneseInit(dictUrl) → charge le dictionnaire (une seule fois ; dictUrl = dossier des .dat.gzip)
//   await Romanize.japanese(text)        → chaîne (attend le dictionnaire s'il est en cours de chargement)
//   Romanize.japaneseSync(text)          → chaîne, une fois le dictionnaire prêt (null sinon)
//   Romanize.segments(text, {lang})      → [{ text, roman, kind, space? }] mot par mot (tableau, ou promesse tant que
//                                          le dictionnaire japonais charge ; « await » marche dans les deux cas)
//   Romanize.hasHangul / hasJapanese / isJapaneseSong(lines) / japaneseReady()
//
// Le japonais demande aussi kuromoji-core.js (Tokenizer + DynamicDictionaries de kuromoji.js, sans chargeur ni zlib),
// chargé avant ce script dans la page (ou trouvé par require sous Node), et le dossier dict/ allégé par
// shrink-dict.mjs (la surface des mots en est retirée : le dictionnaire d'origine de kuromoji marche aussi).
// Chargement : XHR (file:// dans Electron, y compris dans app.asar ; http(s) local dans la WebView Android) puis
// DecompressionStream('gzip') (Chromium 80+). Aucun accès réseau, rien à changer à la CSP « default-src 'self' ».
(function (root) {
  'use strict';

  // ───────────────────────────── Coréen ─────────────────────────────
  // Jamos en indices Unicode : initiale 0..18, voyelle 0..20, finale 0..27.
  // Consonnes manipulées par leur lettre compatible (ㄱ, ㄴ…) pour lire les règles comme dans une grammaire.
  var INI = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
  var FIN = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
  var VOW = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
  var I_ROM = { 'ㄱ': 'g', 'ㄲ': 'kk', 'ㄴ': 'n', 'ㄷ': 'd', 'ㄸ': 'tt', 'ㄹ': 'r', 'ㅁ': 'm', 'ㅂ': 'b', 'ㅃ': 'pp', 'ㅅ': 's', 'ㅆ': 'ss',
    'ㅇ': '', 'ㅈ': 'j', 'ㅉ': 'jj', 'ㅊ': 'ch', 'ㅋ': 'k', 'ㅌ': 't', 'ㅍ': 'p', 'ㅎ': 'h' };
  var F_ROM = { '': '', 'ㄱ': 'k', 'ㄴ': 'n', 'ㄷ': 't', 'ㄹ': 'l', 'ㅁ': 'm', 'ㅂ': 'p', 'ㅇ': 'ng' };
  // Finales doubles : [reste, part en liaison]
  var SPLIT = { 'ㄳ': ['ㄱ', 'ㅅ'], 'ㄵ': ['ㄴ', 'ㅈ'], 'ㄺ': ['ㄹ', 'ㄱ'], 'ㄻ': ['ㄹ', 'ㅁ'], 'ㄼ': ['ㄹ', 'ㅂ'], 'ㄽ': ['ㄹ', 'ㅅ'],
    'ㄾ': ['ㄹ', 'ㅌ'], 'ㄿ': ['ㄹ', 'ㅍ'], 'ㅄ': ['ㅂ', 'ㅅ'] };
  // Neutralisation des finales devant consonne ou en fin de mot (7 sons)
  var NEUTRAL = { 'ㄱ': 'ㄱ', 'ㄲ': 'ㄱ', 'ㅋ': 'ㄱ', 'ㄳ': 'ㄱ', 'ㄺ': 'ㄱ', 'ㄴ': 'ㄴ', 'ㄵ': 'ㄴ', 'ㄶ': 'ㄴ',
    'ㄷ': 'ㄷ', 'ㅅ': 'ㄷ', 'ㅆ': 'ㄷ', 'ㅈ': 'ㄷ', 'ㅊ': 'ㄷ', 'ㅌ': 'ㄷ', 'ㅎ': 'ㄷ',
    'ㄹ': 'ㄹ', 'ㄼ': 'ㄹ', 'ㄽ': 'ㄹ', 'ㄾ': 'ㄹ', 'ㅀ': 'ㄹ', 'ㅁ': 'ㅁ', 'ㄻ': 'ㅁ', 'ㅂ': 'ㅂ', 'ㅍ': 'ㅂ', 'ㅄ': 'ㅂ', 'ㄿ': 'ㅂ', 'ㅇ': 'ㅇ', '': '' };
  var ASPIRATE = { 'ㄱ': 'ㅋ', 'ㄷ': 'ㅌ', 'ㅈ': 'ㅊ', 'ㅂ': 'ㅍ' };
  var NASAL = { 'ㄱ': 'ㅇ', 'ㄷ': 'ㄴ', 'ㅂ': 'ㅁ' };
  var V_I = 20; // ㅣ

  function isSyl(c) { return c >= 0xAC00 && c <= 0xD7A3; }

  function hasHangul(text) { return /[가-힣]/.test(text || ''); }

  // Une suite de syllabes sans espace (un mot écrit) → romanisation prononcée
  function koreanWord(chars) {
    var n = chars.length, s = [];
    for (var k = 0; k < n; k++) {
      var c = chars[k] - 0xAC00;
      s.push({ i: INI[Math.floor(c / 588)], v: Math.floor((c % 588) / 28), f: FIN[c % 28], fBefore: '' });
    }
    var out = '';
    for (k = 0; k < n; k++) {
      var cur = s[k], nx = s[k + 1];
      var F = cur.f, L = nx ? nx.i : null;
      if (nx) {
        if (L === 'ㅇ') { // liaison (연음)
          if (F === '' || F === 'ㅇ') { /* rien */ }
          else if (F === 'ㅎ') F = '';
          else if (F === 'ㄶ') { F = ''; L = 'ㄴ'; }
          else if (F === 'ㅀ') { F = ''; L = 'ㄹ'; }
          else if (SPLIT[F]) { L = SPLIT[F][1]; F = SPLIT[F][0]; if (L === 'ㅌ' && nx.v === V_I) L = 'ㅊ'; }
          else {
            L = F; F = '';
            if (nx.v === V_I && L === 'ㄷ') L = 'ㅈ';       // 굳이 guji (구개음화)
            else if (nx.v === V_I && L === 'ㅌ') L = 'ㅊ';  // 같이 gachi
          }
        } else if (L === 'ㅎ') { // aspiration : finale + ㅎ
          var f2 = SPLIT[F] ? SPLIT[F] : null;
          var last = f2 ? f2[1] : F, keep = f2 ? f2[0] : '';
          if (last === 'ㄱ' || last === 'ㄲ' || last === 'ㅋ') { F = keep; L = 'ㅋ'; }
          else if (last === 'ㄷ') { F = keep; L = nx.v === V_I ? 'ㅊ' : 'ㅌ'; }   // 닫히다 dachida
          else if (last === 'ㅅ' || last === 'ㅆ' || last === 'ㅌ') { F = keep; L = 'ㅌ'; } // 못해 motae
          else if (last === 'ㅈ' || last === 'ㅊ') { F = keep; L = 'ㅊ'; }
          else if (last === 'ㅂ' || last === 'ㅍ') { F = keep; L = 'ㅍ'; }     // 입학 ipak
          else if (F === 'ㅎ') { F = ''; }
          else if (F === 'ㄶ') { F = 'ㄴ'; }
          else if (F === 'ㅀ') { F = 'ㄹ'; }
          // ㄴ ㄹ ㅁ ㅇ + ㅎ : h gardé (사랑해 saranghae, 말해 malhae)
        } else if (F === 'ㅎ' || F === 'ㄶ' || F === 'ㅀ') { // ㅎ final devant consonne
          var base = F === 'ㅎ' ? '' : (F === 'ㄶ' ? 'ㄴ' : 'ㄹ');
          if (ASPIRATE[L] && L !== 'ㅂ') { F = base; L = ASPIRATE[L]; }        // 좋다 jota, 많지 manchi
          else if (L === 'ㅅ') { F = base; L = 'ㅆ'; }                          // 좋습니다 josseumnida
          else if (L === 'ㄴ') { F = base === '' ? 'ㄴ' : base; }               // 좋네 jonne, 않는 anneun
          else F = base === '' ? 'ㄷ' : base;
        } else if (F) { // neutralisation, puis simplification des finales doubles
          if (F === 'ㄺ') F = (L === 'ㄱ' || L === 'ㄲ' || L === 'ㅋ') ? 'ㄹ' : 'ㄱ'; // 맑게 malkke, 읽다 ikda
          else if (F === 'ㄼ' && isBalp(chars[k])) F = 'ㅂ';                          // 밟다 bapda
          else F = NEUTRAL[F];
        }
        // assimilations entre la finale (déjà neutralisée) et l'initiale suivante
        F = NEUTRAL[F] !== undefined ? NEUTRAL[F] : F;
        if (NASAL[F] && (L === 'ㄴ' || L === 'ㅁ')) F = NASAL[F];                  // 국물 gungmul, 입니다 imnida
        else if (NASAL[F] && L === 'ㄹ') { F = NASAL[F]; L = 'ㄴ'; }              // 독립 dongnip
        else if ((F === 'ㅁ' || F === 'ㅇ') && L === 'ㄹ') L = 'ㄴ';             // 심리 simni, 종로 jongno
        else if (F === 'ㄴ' && L === 'ㄹ') F = 'ㄹ';                              // 신라 silla
        else if (F === 'ㄹ' && L === 'ㄴ') L = 'ㄹ';                              // 설날 seollal
        nx.i2 = L;
      } else {
        F = F === 'ㄺ' ? 'ㄱ' : (F === 'ㄼ' && isBalp(chars[k]) ? 'ㅂ' : NEUTRAL[F]);
      }
      var ini = cur.i2 !== undefined ? cur.i2 : cur.i;
      var iniRom = (ini === 'ㄹ' && k > 0 && cur.prevF === 'ㄹ') ? 'l' : I_ROM[ini];
      out += iniRom + VOW[cur.v] + F_ROM[F];
      if (nx) nx.prevF = F;
    }
    return out;
  }
  function isBalp(code) { return code === 0xBC1F; } // 밟

  function korean(text) {
    if (!text) return '';
    var out = '', run = [];
    function flush() { if (run.length) { out += koreanWord(run); run = []; } }
    for (var k = 0; k < text.length; k++) {
      var c = text.charCodeAt(k);
      if (isSyl(c)) run.push(c);
      else { flush(); out += text[k]; }
    }
    flush();
    return out;
  }

  // ───────────────────────────── Japonais ─────────────────────────────
  var KANA_RE = /[ぁ-ゖァ-ヺーㇰ-ㇿｦ-ﾟ]/;
  var KANJI_RE = /[㐀-䶿一-鿿豈-﫿々]/;
  function hasKana(text) { return KANA_RE.test(text || ''); }
  function hasJapanese(text) { return KANA_RE.test(text || '') || KANJI_RE.test(text || ''); }
  // Des kanji sans aucun kana peuvent être du chinois : on ne prend un morceau pour du japonais que s'il a des kana
  // (sur l'ensemble des lignes, pour romaniser aussi ses lignes faites uniquement de kanji).
  function isJapaneseSong(lines) {
    if (typeof lines === 'string') lines = [lines];
    var kana = 0, hangul = 0;
    for (var k = 0; k < (lines || []).length; k++) {
      var l = lines[k] || '';
      if (KANA_RE.test(l)) kana++;
      if (/[가-힣]/.test(l)) hangul++;
    }
    return kana > 0 && kana >= hangul;
  }

  // Kana → Hepburn (katakana, après conversion des hiragana)
  var K1 = {
    'ア': 'a', 'イ': 'i', 'ウ': 'u', 'エ': 'e', 'オ': 'o', 'カ': 'ka', 'キ': 'ki', 'ク': 'ku', 'ケ': 'ke', 'コ': 'ko',
    'サ': 'sa', 'シ': 'shi', 'ス': 'su', 'セ': 'se', 'ソ': 'so', 'タ': 'ta', 'チ': 'chi', 'ツ': 'tsu', 'テ': 'te', 'ト': 'to',
    'ナ': 'na', 'ニ': 'ni', 'ヌ': 'nu', 'ネ': 'ne', 'ノ': 'no', 'ハ': 'ha', 'ヒ': 'hi', 'フ': 'fu', 'ヘ': 'he', 'ホ': 'ho',
    'マ': 'ma', 'ミ': 'mi', 'ム': 'mu', 'メ': 'me', 'モ': 'mo', 'ヤ': 'ya', 'ユ': 'yu', 'ヨ': 'yo',
    'ラ': 'ra', 'リ': 'ri', 'ル': 'ru', 'レ': 're', 'ロ': 'ro', 'ワ': 'wa', 'ヰ': 'i', 'ヱ': 'e', 'ヲ': 'wo', 'ン': 'n',
    'ガ': 'ga', 'ギ': 'gi', 'グ': 'gu', 'ゲ': 'ge', 'ゴ': 'go', 'ザ': 'za', 'ジ': 'ji', 'ズ': 'zu', 'ゼ': 'ze', 'ゾ': 'zo',
    'ダ': 'da', 'ヂ': 'ji', 'ヅ': 'zu', 'デ': 'de', 'ド': 'do', 'バ': 'ba', 'ビ': 'bi', 'ブ': 'bu', 'ベ': 'be', 'ボ': 'bo',
    'パ': 'pa', 'ピ': 'pi', 'プ': 'pu', 'ペ': 'pe', 'ポ': 'po', 'ヴ': 'vu',
    'ァ': 'a', 'ィ': 'i', 'ゥ': 'u', 'ェ': 'e', 'ォ': 'o', 'ャ': 'ya', 'ュ': 'yu', 'ョ': 'yo', 'ヮ': 'wa', 'ヵ': 'ka', 'ヶ': 'ke',
  };
  var K2 = {
    'キャ': 'kya', 'キュ': 'kyu', 'キョ': 'kyo', 'シャ': 'sha', 'シュ': 'shu', 'ショ': 'sho', 'チャ': 'cha', 'チュ': 'chu', 'チョ': 'cho',
    'ニャ': 'nya', 'ニュ': 'nyu', 'ニョ': 'nyo', 'ヒャ': 'hya', 'ヒュ': 'hyu', 'ヒョ': 'hyo', 'ミャ': 'mya', 'ミュ': 'myu', 'ミョ': 'myo',
    'リャ': 'rya', 'リュ': 'ryu', 'リョ': 'ryo', 'ギャ': 'gya', 'ギュ': 'gyu', 'ギョ': 'gyo', 'ジャ': 'ja', 'ジュ': 'ju', 'ジョ': 'jo',
    'ヂャ': 'ja', 'ヂュ': 'ju', 'ヂョ': 'jo', 'ビャ': 'bya', 'ビュ': 'byu', 'ビョ': 'byo', 'ピャ': 'pya', 'ピュ': 'pyu', 'ピョ': 'pyo',
    'シェ': 'she', 'ジェ': 'je', 'チェ': 'che', 'ティ': 'ti', 'ディ': 'di', 'トゥ': 'tu', 'ドゥ': 'du', 'デュ': 'dyu', 'テュ': 'tyu',
    'ファ': 'fa', 'フィ': 'fi', 'フェ': 'fe', 'フォ': 'fo', 'フュ': 'fyu', 'ウィ': 'wi', 'ウェ': 'we', 'ウォ': 'wo',
    'ヴァ': 'va', 'ヴィ': 'vi', 'ヴェ': 've', 'ヴォ': 'vo', 'ヴュ': 'vyu', 'ツァ': 'tsa', 'ツィ': 'tsi', 'ツェ': 'tse', 'ツォ': 'tso',
    'イェ': 'ye', 'クァ': 'kwa', 'クィ': 'kwi', 'クェ': 'kwe', 'クォ': 'kwo', 'グァ': 'gwa', 'スィ': 'si', 'ズィ': 'zi',
  };
  var GEM = '\u0001'; // marque d'un っ final en attente du mot suivant
  function toKatakana(s) {
    return s.replace(/[ぁ-ゖゝゞ]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) + 0x60); });
  }
  // Kana → romaji. っ double la consonne suivante (ch → tch) ; ー double la voyelle précédente (スーパー suupaa) ;
  // ン s'écrit n partout (konya, shinjite : plus lisible qu'une apostrophe dans des paroles chantées).
  function kanaToRomaji(s) {
    s = toKatakana(s);
    var out = '', gem = false;
    for (var k = 0; k < s.length; k++) {
      var ch = s[k], two = s.substr(k, 2), r;
      if (ch === 'ッ') { gem = true; continue; }
      if (ch === 'ー' || ch === '〜' || ch === '～') {
        var m = /[aeiou]$/.exec(out);
        if (m && ch === 'ー') out += m[0];
        else if (ch !== 'ー') out += '~';
        continue;
      }
      if (K2[two]) { r = K2[two]; k++; }
      else if (K1[ch] !== undefined) {
        r = K1[ch]; // petite voyelle isolée (せぇ, なぁ) : sa voyelle, ce qui allonge (see, naa)
      } else { // pas un kana : tel quel
        if (gem) { gem = false; }
        out += ch; continue;
      }
      if (gem) {
        gem = false;
        if (/^ch/.test(r)) r = 't' + r;
        else if (/^[bcdfghjklmpqrstvwxyz]/.test(r)) r = r[0] + r;
      }
      out += r;
    }
    return gem ? out + GEM : out; // っ final : la gémination passe au mot collé suivant (行っ+た → itta)
  }

  var kuro = null, tokenizer = null, loading = null;
  function getCore() {
    if (kuro) return kuro;
    if (root.kuromojiCore) kuro = root.kuromojiCore;
    else if (typeof require === 'function') { try { kuro = require('./kuromoji-core.js'); } catch (e) { /* page sans Node */ } }
    if (!kuro) throw new Error('kuromoji-core.js non chargé');
    return kuro;
  }

  // Téléchargement d'un fichier binaire : XHR (marche en file:// dans Electron comme en http(s) local sur Android,
  // contrairement à fetch qui refuse file://), puis gunzip natif (DecompressionStream) si le fichier finit par .gz ou .gzip.
  function loadBinary(url) {
    if (root.__romanizeLoadBinary) return root.__romanizeLoadBinary(url); // tests sous Node
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'arraybuffer';
      xhr.onload = function () {
        if (xhr.status !== 0 && xhr.status !== 200) return reject(new Error(url + ' : HTTP ' + xhr.status));
        resolve(xhr.response);
      };
      xhr.onerror = function () { reject(new Error(url + ' : lecture impossible')); };
      xhr.send();
    }).then(function (buf) { return /\.gz(ip)?$/.test(url) ? gunzip(buf) : buf; });
  }
  function gunzip(buf) {
    if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('DecompressionStream absent'));
    var stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }

  // .gzip et non .gz : l'empaquetage Android décompresse les .gz et retire leur extension
  var DICT_FILES = ['base.dat.gzip', 'check.dat.gzip', 'tid.dat.gzip', 'tid_pos.dat.gzip', 'tid_map.dat.gzip', 'cc.dat.gzip',
    'unk.dat.gzip', 'unk_pos.dat.gzip', 'unk_map.dat.gzip', 'unk_char.dat.gzip', 'unk_compat.dat.gzip', 'unk_invoke.dat.gzip'];

  // tid_map (n° de mot du trie → mots du dictionnaire) : kuromoji en fait un objet JS de 330 000 clés (~100 Mo de tas).
  // Ici deux tableaux typés (~3 Mo), lus au travers d'un Proxy puisque l'analyse lit target_map[trie_id].
  function compactTargetMap(buf) {
    var dv = new DataView(buf), n = dv.getInt32(0, true), o = 4, k, c, i, max = 0, total = 0;
    for (i = 0, o = 4; i < n && o + 8 <= buf.byteLength; i++) {
      k = dv.getInt32(o, true); c = dv.getInt32(o + 4, true);
      if (k > max) max = k;
      total += c; o += 8 + 4 * c;
    }
    var off = new Int32Array(max + 1), cnt = new Int32Array(max + 1), vals = new Int32Array(total), v = 0;
    for (i = 0, o = 4; i < n && o + 8 <= buf.byteLength; i++) {
      k = dv.getInt32(o, true); c = dv.getInt32(o + 4, true);
      off[k] = v; cnt[k] = c;
      for (var j = 0; j < c; j++) vals[v++] = dv.getInt32(o + 8 + 4 * j, true);
      o += 8 + 4 * c;
    }
    var EMPTY = new Int32Array(0);
    return new Proxy({}, {
      get: function (t, p) {
        var key = +p;
        if (!(key >= 0 && key <= max)) return undefined;
        return cnt[key] ? vals.subarray(off[key], off[key] + cnt[key]) : EMPTY;
      },
    });
  }

  // dictUrl : dossier du dictionnaire, absolu ou relatif à la page (ex. 'dict/kuromoji/').
  function japaneseInit(dictUrl) {
    if (loading) return loading;
    var core = getCore();
    var base = String(dictUrl || 'dict/');
    if (!/\/$/.test(base)) base += '/';
    loading = Promise.all(DICT_FILES.map(function (f) { return loadBinary(base + f); })).then(function (b) {
      var dic = new core.DynamicDictionaries();
      dic.loadTrie(new Int32Array(b[0]), new Int32Array(b[1]));
      dic.loadTokenInfoDictionaries(new Uint8Array(b[2]), new Uint8Array(b[3]), new Uint8Array(0));
      dic.token_info_dictionary.target_map = compactTargetMap(b[4]);
      dic.loadConnectionCosts(new Int16Array(b[5]));
      dic.loadUnknownDictionaries(new Uint8Array(b[6]), new Uint8Array(b[7]), new Uint8Array(b[8]),
        new Uint8Array(b[9]), new Uint32Array(b[10]), new Uint8Array(b[11]));
      tokenizer = new core.Tokenizer(dic);
      return true;
    });
    loading.catch(function () { loading = null; }); // nouvel essai possible
    return loading;
  }
  function japaneseReady() { return !!tokenizer; }

  // Analyse : comme Tokenizer.tokenize de kuromoji, mais la surface vient du texte (nœud du treillis) et non du
  // dictionnaire, ce qui permet de l'ôter du dictionnaire allégé (voir shrink-dict.mjs). Traits gardés : catégorie,
  // sous-catégories 1-2, lecture.
  function tokenizeJa(text) {
    var out = [], sentences = kuro.Tokenizer.splitByPunctuation(text);
    for (var i = 0; i < sentences.length; i++) {
      var path = tokenizer.viterbi_searcher.search(tokenizer.getLattice(sentences[i]));
      for (var j = 0; j < path.length; j++) {
        var node = path[j], line = null;
        if (node.type === 'KNOWN') line = tokenizer.token_info_dictionary.getFeatures(node.name);
        else if (node.type === 'UNKNOWN') line = tokenizer.unknown_dictionary.getFeatures(node.name);
        var f = line ? line.split(',') : [];
        out.push({ surface_form: node.surface_form, pos: f[1], pos_detail_1: f[2], pos_detail_2: f[3],
          reading: node.type === 'KNOWN' && f[8] ? f[8] : undefined });
      }
    }
    return out;
  }

  // Japonais : mots collés au précédent (auxiliaires, terminaisons, suffixes) → « tabetai », « shiteta », « kimi-tachi »
  function attaches(t, prev) {
    if (!prev) return false;
    var p = t.pos, d = t.pos_detail_1;
    if (p === '助動詞') return true;
    if (p === '助詞' && d === '接続助詞' && /^(て|で|ば|ちゃ|じゃ)$/.test(t.surface_form)) return true;
    if ((p === '動詞' || p === '形容詞' || p === '名詞') && d === '接尾') return !suffixAlone(t, prev);
    if (p === '動詞' && d === '非自立' && /^(て|で|ちゃ|じゃ|と[くいけこっ])/.test(t.surface_form)) return true; // してる, しちゃう
    if (prev.pos === '接頭詞') return true;
    return false;
  }

  // Ponctuation japonaise : forme dans la chaîne romanisée (espacée) et forme courte d'un segment
  var PUNCT = { '、': ', ', '。': '. ', '・': ' ', '「': ' "', '」': '" ', '『': ' "', '』': '" ', '…': '...', '‥': '..', '〜': '~', '♪': ' ♪ ' };
  function punctRoman(s, spaced) {
    var p = '';
    for (var j = 0; j < s.length; j++) {
      var v = PUNCT[s[j]];
      p += v === undefined ? s[j] : (spaced ? v : v.trim());
    }
    return p;
  }

  // Lectures propres aux chansons, ou que l'analyse rate (kanji rares, rendaku, mots que le dictionnaire lit
  // autrement). Remplacements avant l'analyse : la partie remplacée passe en kana.
  var NUM = '0-9一二三四五六七八九十百千万何';
  var LYRIC_FIX = [
    // Lecture chantée donnée entre parenthèses après les kanji (幻(ゆめ), 時間（とき）) : elle remplace la lecture du dictionnaire
    [/[一-鿿々]+[(（][ぁ-ゖァ-ヺー]+[)）]/g, function (m) { return m.replace(/^[^(（]+[(（]|[)）]$/g, ''); }],
    [/繫/g, '繋'], [/來/g, '来'],                                         // variantes que NFKC ne ramène pas
    [/一途/g, 'いちず'], [/彷徨/g, 'さまよ'], [/一(?=粒|掴|握)/g, 'ひと'], [/(?:腹|肚)の中/g, 'ハラの中'],
    [/(?<=[0-9])月/g, 'ガツ'], [/十色/g, 'といろ'],
    [new RegExp('(?<![' + NUM + '])[一1]人(?![' + NUM + '])', 'g'), 'ひとり'],
    [new RegExp('(?<![' + NUM + '])[二2]人(?![' + NUM + '])', 'g'), 'ふたり'],
    [/(?<=(?:雨|雪|涙|星|灰|光|花|雫|雷)[^、。\s]{0,3}?)降(?=[らりるれろっ])/g, 'ふ'],    // 雨が降る furu (et non oriru)
    [/(?<![一-鿿゠-ヿう])側(?=に|で|を|へ|から|まで|にい)/g, 'そば'],       // 君の側に soba ni
    [/楽して/g, 'らくして'], [/口遊/g, '口ずさ'], [/真っ新/g, 'まっさら'], [/強張/g, 'こわば'], [/失く/g, 'なく'],
    [/拗ら/g, 'こじら'], [/苛(?=[つ立])/g, 'いら'], [/昏(?=[いく])/g, '暗'], [/肚/g, 'ハラ'], [/^唱$|唱(?=[ ゠-ヿ])/g, 'しょう'], [/見惚れ/g, 'みとれ'], [/一言一句/g, 'いちごんいっく'],
    [/(?<=[たる])間(?![違])/g, 'あいだ'], [/手繰/g, 'たぐ'],
    [/何千/g, 'なんぜん'], [/一番星/g, 'いちばんぼし'], [/痛み止め/g, 'いたみどめ'], [/愛し(?=[てたちま合方])/g, 'あいし'], [/他の/g, 'ほかの'], [/歪(?=[まみむめもん])/g, 'ゆが'],
    [/擦り(?=[減切剥寄抜])/g, 'すり'], [/行っ(?=[てた])/g, 'いっ'], [/微笑/g, 'ほほえ'], [/目一杯/g, 'めいっぱい'],
    [/何色/g, 'なにいろ'], [/敵わ/g, 'かなわ'], [/柄じゃ/g, 'がらじゃ'], [/気儘/g, 'きまま'], [/儘/g, 'まま'],
    [/何(?=[のでだてとど])/g, 'なん'], [/明後日/g, 'あさって'], [/身体/g, 'からだ'], [/火傷/g, 'やけど'],
    [/春風/g, 'はるかぜ'], [/桜色/g, 'さくらいろ'], [/如何(?=[しなか])/g, 'どう'], [/(?<![一-鿿])棺/g, 'ひつぎ'],
  ];
  // Lectures par mot entier (surface → lecture en katakana)
  var WORD_READING = { '後': 'アト', '油': 'アブラ', '君': 'キミ', '貴方': 'アナタ', '貴女': 'アナタ', '何処': 'ドコ', '此処': 'ココ', '其処': 'ソコ' };

  // Petites voyelles d'allongement (くせぇ, なぁ) → voyelle normale, pour que l'analyse ne les colle pas au mot suivant
  function fixSmallVowels(s) {
    return s.replace(/([ぁ-ゖ])([ぁぃぅぇぉ])/g, function (m, a, v) {
      return /[ふてでうしじちつゔくぐ]/.test(a) ? m : a + String.fromCharCode(v.charCodeAt(0) + 1);
    });
  }

  // Suffixes qui suivent autre chose qu'un nom (いつか日, 僕ら手) : mot autonome
  var SUFFIX_ALONE = { '日': 'ヒ', '手': 'テ' };
  function suffixAlone(t, prev) {
    return t.pos === '名詞' && t.pos_detail_1 === '接尾' && SUFFIX_ALONE[t.surface_form] && !(prev && (prev.pos === '名詞' && !/^(代名詞|副詞可能)$/.test(prev.pos_detail_1) || prev.pos === '接頭詞'));
  }

  function readingOf(t, prev) {
    var s = t.surface_form;
    if (suffixAlone(t, prev)) return kanaToRomaji(SUFFIX_ALONE[s]);
    if (t.pos === '助詞' && (s === 'は' || s === 'へ')) return s === 'は' ? 'wa' : 'e';
    // 君 après un nom propre : kun ; 後 après un nom (上京後) : go
    var keepDict = prev && ((s === '君' && prev.pos_detail_2 === '人名') || (s === '後' && prev.pos === '名詞' && prev.pos_detail_1 !== '代名詞'));
    var reading = WORD_READING[s] && !keepDict ? WORD_READING[s] : t.reading;
    var r = reading && reading !== '*' && KANJI_RE.test(s) ? kanaToRomaji(reading) : kanaToRomaji(s);
    // mots finissant par la particule は (時には, 本当は, では, こんにちは) : wa
    if (s.length > 1 && /は$/.test(s) && /^(助詞|接続詞|副詞|感動詞)$/.test(t.pos) && /ha$/.test(r)) r = r.slice(0, -2) + 'wa';
    return r;
  }

  // Texte de travail (NFKC, remplacements) et correspondance vers l'original : cur[i] vient de orig[map[i][0] .. map[i][1])
  function mapText(text) {
    var cur = '', map = [], i = 0;
    while (i < text.length) {
      var ch = String.fromCodePoint(text.codePointAt(i)), n = ch.length;
      var norm = ch.normalize ? ch.normalize('NFKC') : ch;
      if (/^[゙゚]$/.test(norm) && cur) { // ﾞ ﾟ demi-chasse : se combine au kana précédent
        var comb = (cur.slice(-1) + norm).normalize('NFC');
        if (comb.length === 1) { cur = cur.slice(0, -1) + comb; map[map.length - 1] = [map[map.length - 1][0], i + n]; i += n; continue; }
      }
      for (var k = 0; k < norm.length; k++) { cur += norm[k]; map.push([i, i + n]); }
      i += n;
    }
    return { orig: text, cur: cur, map: map };
  }
  function mapReplace(st, re, rep) {
    var cur = '', map = [], last = 0, found = false, m;
    re.lastIndex = 0;
    while ((m = re.exec(st.cur))) {
      if (!m[0].length) { re.lastIndex++; continue; }
      found = true;
      var a = m.index, b = a + m[0].length, span = [st.map[a][0], st.map[b - 1][1]];
      cur += st.cur.slice(last, a); map = map.concat(st.map.slice(last, a));
      var r = typeof rep === 'function' ? rep(m[0]) : rep;
      for (var k = 0; k < r.length; k++) { cur += r[k]; map.push(span); }
      last = b;
    }
    if (!found) return st;
    cur += st.cur.slice(last); map = map.concat(st.map.slice(last));
    return { orig: st.orig, cur: cur, map: map };
  }

  // Ligne japonaise → groupes { s, e (indices dans la ligne d'origine), kind: word|latin|punct|space, roman }.
  // Un groupe « word » = un mot de l'analyse avec ses auxiliaires collés (tabetai, shimattari).
  var LATIN_WORD = /[A-Za-z]+(?:['’\-][A-Za-z]+)*'?/g;
  function analyzeJa(text) {
    var st = mapText(text);
    st.cur = fixSmallVowels(st.cur); // même longueur : la correspondance reste valable
    for (var f = 0; f < LYRIC_FIX.length; f++) st = mapReplace(st, LYRIC_FIX[f][0], LYRIC_FIX[f][1]);
    var groups = [], re = /\s+|\S+/g, m;
    while ((m = re.exec(st.cur))) {
      if (/^\s/.test(m[0])) { groups.push({ a: m.index, b: m.index + m[0].length, kind: 'space', roman: ' ' }); continue; }
      // Chaque groupe entre espaces est analysé à part : l'espace sépare des phrases dans les paroles, et l'analyse
      // lit mal le mot qui suit un espace (君 → kun, 愛し → itoshi). Les mots latins sont mis de côté.
      var chunk = m[0], base = m.index, lw, last = 0;
      LATIN_WORD.lastIndex = 0;
      while ((lw = LATIN_WORD.exec(chunk))) {
        if (lw.index > last) tokensToGroups(tokenizeJa(chunk.slice(last, lw.index)), base + last, groups);
        dropGem(groups);
        groups.push({ a: base + lw.index, b: base + lw.index + lw[0].length, kind: 'latin', roman: lw[0] });
        last = lw.index + lw[0].length;
      }
      if (last < chunk.length) tokensToGroups(tokenizeJa(chunk.slice(last)), base + last, groups);
      dropGem(groups);
    }
    // vers l'original ; deux groupes issus d'un même remplacement (何千 → なん|ぜん) sont fusionnés
    var segs = [], end = 0;
    for (var g = 0; g < groups.length; g++) {
      var G = groups[g], s = st.map[G.a][0], e = st.map[G.b - 1][1], p = segs[segs.length - 1];
      if (p && s < p.e) {
        p.e = Math.max(p.e, e);
        p.roman += G.roman;
        if (G.kind === 'word') p.kind = 'word';
        end = p.e;
        continue;
      }
      if (s > end) segs.push({ s: end, e: s, kind: 'punct', roman: text.slice(end, s) }); // (ne devrait pas arriver)
      segs.push({ s: s, e: e, kind: G.kind, roman: G.roman });
      end = e;
    }
    if (end < text.length) segs.push({ s: end, e: text.length, kind: 'punct', roman: text.slice(end) });
    return segs;
  }
  function dropGem(groups) {
    var l = groups[groups.length - 1];
    if (l && l.roman.slice(-1) === GEM) l.roman = l.roman.slice(0, -1);
  }
  function tokensToGroups(tokens, pos, groups) {
    var prev = null;
    for (var k = 0; k < tokens.length; k++) {
      var t = tokens[k], s = t.surface_form, a = pos, b = pos + s.length;
      pos = b;
      if (!hasJapanese(s)) { // chiffres, ponctuation
        dropGem(groups);
        groups.push({ a: a, b: b, kind: /[0-9]/.test(s) ? 'latin' : 'punct', roman: s });
        prev = null;
        continue;
      }
      var r = readingOf(t, prev), l = groups[groups.length - 1];
      // collé au mot précédent : auxiliaires, terminaisons, et tout mot qui suit un っ final (しまっ+たり → shimattari)
      if (l && l.kind === 'word' && l.b === a && ((prev && attaches(t, prev)) || l.roman.slice(-1) === GEM)) {
        l.roman = joinGem(l.roman, r); l.b = b;
      } else {
        dropGem(groups);
        groups.push({ a: a, b: b, kind: 'word', roman: r });
      }
      prev = t;
    }
  }

  // Groupes → chaîne : espaces entre les mots, ponctuation japonaise convertie
  function renderJa(segs) {
    var out = '';
    for (var k = 0; k < segs.length; k++) {
      var g = segs[k];
      if (g.kind === 'space') out += ' ';
      else if (g.kind === 'word') { if (out && !/[\s"(\[~]$/.test(out)) out += ' '; out += g.roman; }
      else if (g.kind === 'latin') { if (/[A-Za-z0-9]$/.test(out)) out += ' '; out += g.roman; }
      else out += punctRoman(g.roman, true);
    }
    return out.replace(/ +/g, ' ').replace(/ ([,.!?)\]])/g, '$1').replace(/" "/g, '""').trim();
  }

  function japaneseSync(text) {
    if (!tokenizer) return null;
    if (!text) return '';
    return renderJa(analyzeJa(text));
  }

  // Collage avec gémination laissée en suspens par un っ final (marqué GEM par kanaToRomaji)
  function joinGem(out, r) {
    if (out.slice(-1) === GEM) {
      out = out.slice(0, -1);
      if (/^ch/.test(r)) r = 't' + r; else if (/^[bcdfghjklmpqrstvwxyz]/.test(r)) r = r[0] + r;
    }
    return out + r;
  }

  // ───────────────────────────── Segments (surlignage mot à mot, alignement audio) ─────────────────────────────
  // [{ text, roman, kind }] dans l'ordre ; la concaténation des text redonne exactement la ligne.
  // kind : 'word' (coréen : un mot écrit ; japonais : un mot de l'analyse avec ses auxiliaires), 'latin' (un mot
  // latin ou un nombre, roman = tel quel), 'punct' (roman = ponctuation convertie), 'space' (space: true, roman ' ').
  var KO_SEG = /(\s+)|([가-힣]+)|([A-Za-z]+(?:['’\-][A-Za-z]+)*'?|[0-9]+(?:[.,:][0-9]+)*)|([^\sA-Za-z0-9가-힣]+)/g;
  function segmentsKo(text) {
    var out = [], m;
    KO_SEG.lastIndex = 0;
    while ((m = KO_SEG.exec(text))) {
      if (m[1]) out.push({ text: m[1], roman: ' ', kind: 'space', space: true });
      else if (m[2]) out.push({ text: m[2], roman: korean(m[2]), kind: 'word' });
      else if (m[3]) out.push({ text: m[3], roman: m[3], kind: 'latin' });
      else out.push({ text: m[4], roman: m[4], kind: 'punct' });
    }
    return out;
  }
  function segmentsJaSync(text) {
    return analyzeJa(text).map(function (g) {
      var seg = { text: text.slice(g.s, g.e), roman: g.kind === 'punct' ? punctRoman(g.roman, false) : g.roman, kind: g.kind };
      if (g.kind === 'space') seg.space = true;
      return seg;
    });
  }
  // opts.lang : 'ko' | 'ja' pour forcer (ex. ligne de kanji seuls dans un morceau japonais, voir isJapaneseSong)
  function segmentsSync(text, opts) {
    text = text || '';
    var lang = opts && opts.lang;
    if (!lang) lang = hasHangul(text) ? 'ko' : (hasKana(text) || KANJI_RE.test(text) ? 'ja' : 'ko');
    if (lang === 'ja') return tokenizer ? segmentsJaSync(text) : null;
    return segmentsKo(text);
  }
  // Synchrone (tableau) sans japonais ou une fois le dictionnaire prêt ; sinon une promesse. « await » marche dans les deux cas.
  function segments(text, opts) {
    var r = segmentsSync(text, opts);
    if (r) return r;
    if (!loading) return Promise.reject(new Error('Romanize.japaneseInit(dictUrl) non appelé'));
    return loading.then(function () { return segmentsSync(text, opts); });
  }

  function japanese(text) {
    if (tokenizer) return Promise.resolve(japaneseSync(text));
    if (!loading) return Promise.reject(new Error('Romanize.japaneseInit(dictUrl) non appelé'));
    return loading.then(function () { return japaneseSync(text); });
  }

  var Romanize = {
    hasHangul: hasHangul, hasJapanese: hasJapanese, hasKana: hasKana, isJapaneseSong: isJapaneseSong,
    korean: korean, kana: kanaToRomaji,
    japaneseInit: japaneseInit, japaneseReady: japaneseReady, japanese: japanese, japaneseSync: japaneseSync,
    segments: segments, segmentsSync: segmentsSync,
  };
  root.Romanize = Romanize;
  if (typeof module !== 'undefined' && module.exports) module.exports = Romanize;
})(typeof globalThis !== 'undefined' ? globalThis : this);
