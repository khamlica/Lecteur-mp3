// Recherche des paroles sur LRCLIB (lrclib.net : gratuit, sans compte ni clé, paroles synchronisées ligne par ligne
// pour l'essentiel de la pop et de la K-pop) et lecture du format LRC. Partagé par le bureau (src/lyrics.js, dans le
// processus principal) et le téléphone (android/host.js) : script classique qui définit `LyricsSearch`, et module
// CommonJS sous Node.
(() => {
  const LRCLIB_API = 'https://lrclib.net/api';
  const LOOKUP_TIMEOUT = 8000;
  const RETRIES = 3;         // nouveaux essais quand LRCLIB est occupé (503, fréquent) ou lent (voir getJson)
  const RETRY_DELAY = 2000;
  // Écart de durée accepté entre le fichier et les paroles trouvées (s) : un clip est souvent plus long que le
  // morceau (intro, fin), presque jamais plus court. Comme pour la recherche des pochettes (main.js).
  const SHORTER_TOLERANCE = 6;
  const LONGER_TOLERANCE = 45;
  const CLOSE_DURATION = 4;

  // Versions différentes du morceau original : elles ne conviennent que si le fichier les mentionne aussi
  const VARIANTS = /\b(live|remix|mix|acoustic|instrumental|inst|karaoke|cover|piano|sped up|slowed|nightcore|8d|lofi|demo|orchestra|japanese|english|korean|chinese|spanish)\b/gi;
  const VERSION = /\b(ver|version)\b/i;
  const JAPANESE_VERSION =/\b(japanese|jp)\s*(ver(sion)?\.?)?\b|日本語/i;
  const KANA = /[぀-ヿ]/;

  // Minuscules, sans accents ni ponctuation, entouré d'espaces pour chercher des mots entiers.
  const words = (s) => ` ${(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/&amp;/g, '&').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  const mentions = (text, name) => words(name).trim() !== '' && text.includes(words(name));
  const stripBrackets = (s) => (s || '').replace(/\s*(\([^)]*\)|\[[^\]]*\]|【[^】]*】)/g, '').trim();
  const splitArtists = (s) => (s || '').split(/\s*(?:,|&|\band\b|\bx\b|\bfeat\.?|\bft\.?|\bwith\b)\s*/i).filter((a) => a.trim());
  // Sigle d'un nom de groupe (« TOMORROW X TOGETHER » → « txt ») : les tags et les titres de vidéos l'emploient
  // souvent. Trois lettres au moins (« MV » n'est pas un groupe) ; le titre et la durée doivent concorder aussi.
  const acronym = (name) => {
    const parts = words(name).trim().split(' ');
    return parts.length >= 3 ? parts.map((w) => w[0]).join('') : '';
  };
  // Un des artistes des paroles est nommé dans `text` : en entier (« TOMORROW X TOGETHER » n'est pas un duo), l'un
  // d'eux, ou par son sigle
  const artistMentioned = (text, artist) =>
    [artist, ...splitArtists(artist)].some((a) => mentions(text, a) || mentions(text, acronym(a)));

  // ---------- Format LRC ----------

  // « [mm:ss.xx]texte », plusieurs horodatages possibles par ligne, « [offset:+/-ms] », et les horodatages
  // de mots du LRC étendu (« <mm:ss.xx>mot ») quand il y en a.
  // → [{ time, text, words: [{ time, text }] | null }] trié, ou null si le texte n'est pas synchronisé.
  function parseLrc(lrc) {
    if (!lrc) return null;
    const stamp = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g;
    const seconds = (m, s) => Number(m) * 60 + Number(s.replace(':', '.'));
    const offset = /\[offset:\s*([+-]?\d+)\]/i.exec(lrc);
    const shift = offset ? -Number(offset[1]) / 1000 : 0; // un offset positif avance les paroles
    const lines = [];
    for (const raw of lrc.split(/\r?\n/)) {
      const times = [];
      let m, last = 0;
      stamp.lastIndex = 0;
      while ((m = stamp.exec(raw)) && m.index === last) {
        times.push(seconds(m[1], m[2]) + shift);
        last = stamp.lastIndex;
      }
      if (!times.length) continue;
      let text = raw.slice(last);
      let wordTimes = null;
      if (/<\d+:\d+(?:\.\d+)?>/.test(text)) {
        wordTimes = [];
        const re = /<(\d+):(\d+(?:\.\d+)?)>([^<]*)/g;
        while ((m = re.exec(text))) if (m[3].trim()) wordTimes.push({ time: seconds(m[1], m[2]) + shift, text: m[3].trim() });
        text = text.replace(/<\d+:\d+(?:\.\d+)?>/g, '');
      }
      text = text.replace(/\s+/g, ' ').trim();
      for (const time of times) lines.push({ time: Math.max(0, time), text, words: wordTimes });
    }
    if (!lines.length) return null;
    lines.sort((a, b) => a.time - b.time);
    return lines;
  }

  // Paroles non synchronisées → lignes sans horodatage
  const plainLines = (text) => (text || '').split(/\r?\n/).map((t) => ({ time: null, text: t.trim(), words: null }));

  // Paroles d'un texte quelconque (tag du fichier, .lrc) : synchronisées si possible
  function fromText(text) {
    const lines = parseLrc(text);
    if (lines) return { lines, synced: true };
    return text && text.trim() ? { lines: plainLines(text), synced: false } : null;
  }

  // ---------- LRCLIB ----------

  // Serveur occupé, trop lent ou connexion coupée un instant : on réessaie un peu plus tard
  async function getJson(fetch, url) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT) });
      } catch (err) {
        if (attempt >= RETRIES) throw err;
      }
      if (res?.status === 404) return null;
      if (res && res.status !== 503 && res.status !== 429) {
        if (!res.ok) throw new Error(`LRCLIB : ${res.status}`);
        return res.json();
      }
      if (attempt >= RETRIES) throw new Error(`LRCLIB : ${res.status}`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY * (attempt + 1)));
    }
  }

  // Paroles de LRCLIB qui correspondent vraiment au morceau : même titre, un artiste en commun, pas une autre
  // version, durée compatible. `text` : tout ce qu'on sait du fichier. Sans artiste en commun, on ne prend rien :
  // un autre morceau du même nom et de même durée (« Over The Moon ») afficherait des paroles fausses. Un sigle suffit
  // (« TXT », voir artistMentioned).
  function accept(r, { text, duration, japanese }) {
    if (!r || r.instrumental || !(r.syncedLyrics || r.plainLyrics)) return false;
    // le titre, ou son autre écriture entre parenthèses (« セツナハナビ (Setsuna Hanabi) »)
    const titles = [stripBrackets(r.trackName), ...[...(r.trackName || '').matchAll(/\(([^)]*)\)/g)].map((m) => m[1])
      .filter((t) => !/^\s*(feat|ft|with|prod)\b/i.test(t))];
    if (!titles.some((t) => mentions(text, t))) return false;
    const variants = `${r.trackName} ${r.albumName || ''}`.match(VARIANTS) || [];
    if (variants.some((v) => !mentions(text, v))) return false;
    // une version nommée (« [夏宵 Ver.] ») : seulement si le fichier parle aussi d'une version
    if (VERSION.test(r.trackName) && !VERSION.test(text)) return false;
    // version japonaise d'un morceau coréen : il faut des paroles en japonais
    if (japanese && !KANA.test(r.syncedLyrics || r.plainLyrics)) return false;
    if (!artistMentioned(text, r.artistName)) return false;
    if (!duration || !r.duration) return true;
    const diff = duration - r.duration;
    return diff >= -SHORTER_TOLERANCE && diff <= LONGER_TOLERANCE;
  }

  // Le meilleur résultat acceptable : synchronisé de préférence, durée la plus proche
  function pick(results, info) {
    const ok = (results || []).filter((r) => accept(r, info));
    const gap = (r) => (info.duration && r.duration ? Math.abs(info.duration - r.duration) : 0);
    ok.sort((a, b) => (!!b.syncedLyrics - !!a.syncedLyrics) || (gap(a) > CLOSE_DURATION) - (gap(b) > CLOSE_DURATION) || gap(a) - gap(b));
    return ok[0] || null;
  }

  // Paroles du morceau sur LRCLIB : { lines, synced, source, id, match, at }, ou null si rien de sûr. `name` : nom du
  // fichier sans extension (un titre de vidéo YouTube en dit souvent plus que les tags : « Japanese ver. »).
  // Lève une erreur si le service ne répond pas.
  async function searchLrclib(fetch, { title, artist, album, duration, name }) {
    const text = [title, artist, album, name].filter(Boolean).join(' ');
    const info = { text: words(text), duration, japanese: JAPANESE_VERSION.test(text) };
    const cleanTitle = stripBrackets(title || name);
    const mainArtist = splitArtists(artist)[0] || '';
    const queries = [];
    if (cleanTitle && mainArtist) {
      const exact = new URLSearchParams({ track_name: cleanTitle, artist_name: mainArtist });
      if (album) exact.set('album_name', album);
      if (duration) exact.set('duration', String(Math.round(duration)));
      queries.push(`${LRCLIB_API}/get?${exact}`);
      queries.push(`${LRCLIB_API}/search?${new URLSearchParams({ track_name: cleanTitle, artist_name: mainArtist })}`);
      queries.push(`${LRCLIB_API}/search?${new URLSearchParams({ q: `${mainArtist} ${cleanTitle}` })}`);
    }
    // titre seul : l'artiste est peut-être écrit autrement (« TXT » pour « TOMORROW X TOGETHER ») ; la recherche sur le
    // titre exact trouve des morceaux que la recherche libre noie parmi les homonymes
    if (cleanTitle) queries.push(`${LRCLIB_API}/search?${new URLSearchParams({ track_name: cleanTitle })}`);
    if (cleanTitle) queries.push(`${LRCLIB_API}/search?${new URLSearchParams({ q: cleanTitle })}`);
    for (const url of queries) {
      const res = await getJson(fetch, url);
      const found = pick(Array.isArray(res) ? res : [res], info);
      if (!found) continue;
      const lyrics = found.syncedLyrics ? { lines: parseLrc(found.syncedLyrics), synced: true } : { lines: plainLines(found.plainLyrics), synced: false };
      return {
        ...lyrics,
        source: 'lrclib',
        id: found.id,
        match: { title: found.trackName, artist: found.artistName, album: found.albumName, duration: found.duration },
        at: Date.now(),
      };
    }
    return null;
  }

  // « Introuvable » se redemande au bout de 3 jours (les paroles sont ajoutées au fil du temps), et tout de suite après
  // une amélioration de la recherche (SEARCH_VERSION : à augmenter quand elle trouve plus de morceaux)
  const MISS_TTL = 3 * 24 * 3600 * 1000;
  const SEARCH_VERSION = 2;
  const notFound = () => ({ missing: true, reason: 'not-found', at: Date.now(), v: SEARCH_VERSION });
  const isStale = (entry) => !!entry?.missing && (Date.now() - entry.at > MISS_TTL || entry.v !== SEARCH_VERSION);

  const LyricsSearch = { parseLrc, fromText, searchLrclib, notFound, isStale };
  globalThis.LyricsSearch = LyricsSearch;
  if (typeof module !== 'undefined') module.exports = LyricsSearch;
})();
