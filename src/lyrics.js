// Paroles d'un morceau sur le bureau : fichier .lrc posé à côté, paroles enregistrées dans le fichier, ou LRCLIB (voir
// renderer/lyrics-search.js, partagé avec le téléphone). Le résultat est gardé dans <données>/lyrics : le service
// n'est interrogé qu'une fois par morceau.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fromText, searchLrclib, notFound, isStale } = require('./renderer/lyrics-search');

function createLyrics({ dataDir, fetch, readTags, isOnline }) {
  const cacheDir = path.join(dataDir, 'lyrics');
  const key = (file) => path.resolve(file).toLowerCase();
  const cacheFile = (file) => path.join(cacheDir, crypto.createHash('sha1').update(key(file)).digest('hex') + '.json');

  function readCache(file) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile(file), 'utf8'));
    } catch {
      return null;
    }
  }

  function writeCache(file, entry) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cacheFile(file), JSON.stringify(entry));
    } catch (err) {
      console.warn('Paroles non gardées en cache :', err.message);
    }
  }

  // Décalage réglé à la main pour chaque morceau (s, positif : paroles plus tard), quelle que soit la source des
  // paroles. Un clip a souvent une intro que la version de l'album n'a pas.
  const offsetsFile = path.join(cacheDir, 'offsets.json');
  let offsets = null;

  function offset(file) {
    if (!offsets) {
      try {
        offsets = JSON.parse(fs.readFileSync(offsetsFile, 'utf8'));
      } catch {
        offsets = {};
      }
    }
    return offsets[key(file)] || 0;
  }

  function setOffset(file, value) {
    offset(file);
    if (value) offsets[key(file)] = value;
    else delete offsets[key(file)];
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(offsetsFile, JSON.stringify(offsets));
    } catch (err) {
      console.warn('Décalage des paroles non enregistré :', err.message);
    }
  }

  // Paroles enregistrées dans le fichier (tags USLT / SYLT / LYRICS), synchronisées ou non
  function fromTags(tags) {
    for (const l of tags.lyrics || []) {
      if (l.syncText?.length && l.timeStampFormat === 2) {
        return { lines: l.syncText.map((s) => ({ time: s.timestamp / 1000, text: (s.text || '').trim(), words: null })), synced: true };
      }
      const found = fromText(typeof l === 'string' ? l : l.text);
      if (found) return found;
    }
    return null;
  }

  function fromSidecar(file) {
    try {
      const found = fromText(fs.readFileSync(path.join(path.dirname(file), path.basename(file, path.extname(file)) + '.lrc'), 'utf8'));
      return found?.synced ? found : null;
    } catch {
      return null;
    }
  }

  // → { lines: [{ time, text, words }], synced, source, … } ou { missing: true, reason }. Ne lève jamais d'erreur.
  // `refresh` : ignorer le cache (nouvelle recherche demandée par l'utilisateur).
  async function find(file, { refresh = false } = {}) {
    const local = fromSidecar(file);
    if (local) return { ...local, source: 'lrc' };
    const tags = await readTags(file).catch(() => ({}));
    const embedded = fromTags(tags);
    if (embedded?.synced) return { ...embedded, source: 'tags' };
    const fallback = embedded ? { ...embedded, source: 'tags' } : null;

    const cached = !refresh && readCache(file);
    if (cached && !isStale(cached)) return cached.missing && fallback ? fallback : cached;
    if (!isOnline()) return fallback || { missing: true, reason: 'offline' };

    try {
      const found = await searchLrclib(fetch, {
        title: tags.title,
        artist: tags.artist,
        album: tags.album,
        duration: tags.duration,
        name: path.basename(file, path.extname(file)),
      });
      // paroles du fichier non synchronisées : gardées si LRCLIB n'a mieux (synchronisé)
      const entry = found?.synced || !fallback ? found || notFound() : fallback;
      writeCache(file, entry === fallback ? notFound() : entry);
      return entry;
    } catch (err) {
      console.warn('Recherche des paroles impossible :', err.message);
      return fallback || { missing: true, reason: 'error' };
    }
  }

  return { find, offset, setOffset };
}

module.exports = { createLyrics };
