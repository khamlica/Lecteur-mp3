const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, screen, globalShortcut, clipboard, net } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { pathToFileURL } = require('url');

const WIN_WIDTH = 540;
const WIN_HEIGHT = 88;
const IDLE_OPACITY = 0.6; // opacité quand la souris n'est pas sur le lecteur
const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');

const DEFAULTS = {
  folder: null,
  lastTrack: null,
  position: 0,
  volume: 0.8,
  muted: false,
  shuffle: false,
  repeat: 'off', // 'off' | 'all' | 'one'
  alwaysOnTop: true,
  transparent: true,       // fond de verre (acrylic Windows) et fondu au repos ; false : opaque, fond sombre plein
  bounds: null,
  fxPulse: true,           // le lecteur pulse sur les basses
  fxPressure: true,        // lumière qui monte du bas sur les basses longues et lourdes
  fxHalo: true,            // halo lumineux sur tout le lecteur
  fxNotes: true,           // halo à gauche ou à droite sur les notes (piano, cordes, voix…)
  fxPulseLevel: 1,         // intensité de chaque effet, de 0 à 1,5
  fxPressureLevel: 1,
  fxHaloLevel: 1,
  fxNotesLevel: 1,
  fxSyncMs: 0,             // avance (+) ou retard (−) des effets sur le son, réglée à l'oreille
  fxSyncByDevice: {},      // la même, retenue pour chaque sortie audio (un casque Bluetooth a son propre retard)
  fxTheme: 'glass',        // 'glass' | 'savage' | 'savage-meshy' | 'aurora' | 'neon' | 'ember' | 'mono' (voir FX_THEMES)
  fxColorMode: 'theme',    // 'theme' | 'cover' | 'custom'
  fxCustomColor: '#ff7a3d',
  soundFx: 'none',         // effet sonore à l'écoute (voir SOUND_EFFECTS)
};

let settings = { ...DEFAULTS };
let win = null;
let tray = null;
let quitting = false;
let flushed = false;
let playback = { playing: false, title: '' };

// ---------- Réglages ----------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

// L'app s'appelait « Lecteur MP3 » et ses données étaient rangées sous ce nom :
// au premier lancement sous le nouveau nom, on reprend ses réglages et yt-dlp.
function migrateOldData() {
  const old = path.join(app.getPath('appData'), 'Lecteur MP3');
  if (fs.existsSync(settingsFile()) || !fs.existsSync(path.join(old, 'settings.json'))) return;
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.copyFileSync(path.join(old, 'settings.json'), settingsFile());
    const bin = path.join(old, 'bin');
    if (fs.existsSync(bin)) fs.cpSync(bin, path.join(app.getPath('userData'), 'bin'), { recursive: true });
  } catch (err) {
    console.warn('Reprise des anciens réglages impossible :', err.message);
  }
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8').replace(/^﻿/, '');
    const saved = JSON.parse(raw);
    settings = { ...DEFAULTS, ...saved };
    // Ancienne intensité unique (douce / normale / forte) → intensité de chaque effet
    if (saved.fxIntensity && saved.fxPulseLevel === undefined) {
      const level = { low: 0.6, high: 1.5 }[saved.fxIntensity] || 1;
      settings.fxPulseLevel = settings.fxPressureLevel = settings.fxHaloLevel = settings.fxNotesLevel = level;
    }
    delete settings.fxIntensity;
  } catch {
    settings = { ...DEFAULTS };
  }
}

let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeSettings, 500);
}

function writeSettings() {
  clearTimeout(saveTimer);
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Impossible d\'enregistrer les réglages :', err);
  }
}

// ---------- Bibliothèque ----------

async function scanFolder(dir) {
  const files = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      return; // dossier illisible : on l'ignore
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && /\.(mp3|opus|m4a)$/i.test(entry.name)) files.push(full);
    }
  }
  await walk(dir);
  files.sort((a, b) => a.localeCompare(b, 'fr', { numeric: true, sensitivity: 'base' }));
  return files.map((p) => ({
    path: p,
    url: pathToFileURL(p).href,
    name: path.basename(p, path.extname(p)),
  }));
}

let mm = null;
async function readMetadata(file) {
  try {
    mm ??= await import('music-metadata');
    const { common } = await mm.parseFile(file, { duration: false });
    const pic = mm.selectCover(common.picture);
    return {
      title: common.title || null,
      artist: common.artist || null,
      album: common.album || null,
      cover: pic ? `data:${pic.format};base64,${Buffer.from(pic.data).toString('base64')}` : null,
    };
  } catch {
    return {};
  }
}

// ---------- YouTube → audio ----------

// yt-dlp est téléchargé au premier usage plutôt qu'embarqué : YouTube change souvent
// et une version figée dans l'installeur cesserait vite de fonctionner.
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const ytDlpPath = () => path.join(app.getPath('userData'), 'bin', 'yt-dlp.exe');
const ytTempDir = () => path.join(app.getPath('temp'), 'hanabi-player-youtube');
// Une fois l'app installée, un exécutable ne peut pas être lancé depuis l'archive asar.
const FFMPEG_PATH = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

let ytJob = null; // { proc, cancelled }

async function ensureYtDlp() {
  const exe = ytDlpPath();
  if (fs.existsSync(exe)) return;
  send('yt-progress', { status: 'Installation de yt-dlp…' });
  const res = await net.fetch(YTDLP_URL);
  if (!res.ok) throw new Error(`téléchargement de yt-dlp impossible (HTTP ${res.status})`);
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  await fs.promises.writeFile(exe + '.part', Buffer.from(await res.arrayBuffer()));
  await fs.promises.rename(exe + '.part', exe);
}

function onLines(stream, cb) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const lines = (buf + chunk).split(/\r?\n/);
    buf = lines.pop();
    lines.forEach(cb);
  });
  stream.on('end', () => buf && cb(buf));
}

function runYtDlp(args, onLine = () => {}) {
  return new Promise((resolve) => {
    const proc = spawn(ytDlpPath(), args, {
      windowsHide: true,
      // yt-dlp a besoin d'un moteur JavaScript pour YouTube : Electron fait office de Node.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    ytJob.proc = proc;
    let errors = '';
    onLines(proc.stdout, onLine);
    onLines(proc.stderr, (line) => { errors += line + '\n'; });
    proc.on('error', (err) => resolve({ code: -1, errors: err.message }));
    proc.on('close', (code) => resolve({ code, errors }));
  });
}

function ytErrorMessage(errors) {
  const line = errors.split('\n').reverse().find((l) => l.startsWith('ERROR:'));
  if (!line) return 'la conversion a échoué';
  return line.replace(/^ERROR:\s*(\[[^\]]+\]\s*[\w-]+:\s*)?/, '');
}

// Dossier de destination : le dossier de musique, ou Musique\YouTube s'il n'y en a pas encore.
function downloadFolder() {
  if (settings.folder && fs.existsSync(settings.folder)) return settings.folder;
  const dir = path.join(app.getPath('music'), 'YouTube');
  fs.mkdirSync(dir, { recursive: true });
  settings.folder = dir;
  settings.lastTrack = null;
  settings.position = 0;
  saveSettings();
  return dir;
}

async function convertYoutube(url) {
  if (ytJob) return { error: 'Une conversion est déjà en cours' };
  ytJob = { proc: null, cancelled: false };
  try {
    await ensureYtDlp();
    if (ytJob.cancelled) return { cancelled: true };
    const folder = downloadFolder();
    const files = [];
    const args = [
      '--encoding', 'utf-8',
      '--no-playlist',
      // Meilleure piste audio disponible, gardée telle quelle (Opus le plus souvent, sinon AAC) :
      // aucun réencodage, donc aucune perte, et environ deux fois plus léger qu'un MP3 équivalent.
      '-f', 'bestaudio/best',
      '-x',
      '--embed-metadata', '--embed-thumbnail', '--convert-thumbnails', 'jpg',
      '--ffmpeg-location', FFMPEG_PATH,
      '--js-runtimes', `node:${process.execPath}`,
      '-P', folder, '-P', `temp:${ytTempDir()}`,
      '-o', '%(title)s.%(ext)s',
      '--quiet', '--no-warnings', '--progress', '--newline',
      '--progress-template', 'download:P %(progress._percent_str)s',
      '--print', 'before_dl:T %(title)s',
      // Infos du fichier obtenu, pour le nettoyer et retrouver le morceau (track et artist ne sont
      // connus que si YouTube a identifié la musique)
      '--print', 'after_move:F %(.{id,filepath,title,track,artist,channel})j',
      url,
    ];
    const onLine = (line) => {
      const value = line.slice(2).trim();
      if (line.startsWith('T ')) {
        send('yt-progress', { title: value, status: 'Téléchargement…' });
      } else if (line.startsWith('P ')) {
        const pct = parseFloat(value);
        if (isNaN(pct)) return;
        send('yt-progress', { status: pct >= 100 ? 'Finalisation…' : `Téléchargement… ${Math.floor(pct)} %` });
      } else if (line.startsWith('F ')) {
        try {
          const info = JSON.parse(value);
          files.push({ ...info, path: info.filepath });
        } catch {
          // ligne illisible : le fichier est quand même dans le dossier, seulement pas nettoyé
        }
      }
    };

    let result = await runYtDlp(args, onLine);
    if (result.code !== 0 && !ytJob.cancelled) {
      // Souvent dû à un changement côté YouTube : on met yt-dlp à jour et on réessaie une fois.
      send('yt-progress', { status: 'Mise à jour de yt-dlp…' });
      await runYtDlp(['-U']);
      if (!ytJob.cancelled) result = await runYtDlp(args, onLine);
    }
    if (ytJob.cancelled) return { cancelled: true };
    if (result.code !== 0 || !files.length) return { error: `Échec : ${ytErrorMessage(result.errors)}` };

    send('yt-progress', { status: 'Nettoyage du début et de la fin…' });
    for (const file of files) {
      await trimNonMusic(file.path, file.id);
      await trimSilence(file.path);
    }
    send('yt-progress', { status: 'Recherche du titre et de la pochette…' });
    for (const file of files) await tagDownload(file);

    const tracks = await scanFolder(folder);
    const wanted = path.resolve(files[0].path).toLowerCase();
    const track = tracks.find((t) => path.resolve(t.path).toLowerCase() === wanted);
    return { folder, tracks, file: track ? track.path : null };
  } catch (err) {
    return { error: `Échec : ${err.message}` };
  } finally {
    ytJob = null;
    fs.rm(ytTempDir(), { recursive: true, force: true }, () => {});
  }
}

function cancelYoutube() {
  if (!ytJob) return;
  ytJob.cancelled = true;
  // yt-dlp.exe lance lui-même d'autres processus (Python, ffmpeg) : on arrête toute l'arborescence.
  if (ytJob.proc) execFile('taskkill', ['/pid', String(ytJob.proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
}

// ---------- Pochette ----------

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG_PATH, args, { windowsHide: true }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr.trim().split('\n').pop() || err.message));
      else resolve(stderr);
    });
  });
}

// L'interface vient de libérer le fichier : Windows peut mettre un instant à le déverrouiller.
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.promises.rename(from, to);
    } catch (err) {
      if (attempt >= 10 || !['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

// Bloc PICTURE au format FLAC : c'est sous cette forme qu'un fichier Opus stocke sa pochette.
function pictureBlock({ data, format }) {
  const { width, height } = nativeImage.createFromBuffer(Buffer.from(data)).getSize();
  const mime = Buffer.from(format);
  const desc = Buffer.from('Cover (front)');
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  // type 3 = couverture ; profondeur 24 bits ; 0 = pas de palette
  return Buffer.concat([u32(3), u32(mime.length), mime, u32(desc.length), desc,
    u32(width), u32(height), u32(24), u32(0), u32(data.length), data]);
}

async function currentCover(file) {
  mm ??= await import('music-metadata');
  const { common } = await mm.parseFile(file, { duration: false });
  return mm.selectCover(common.picture);
}

// Réécrit le fichier sans réencoder l'audio. `changes` peut contenir title, artist, cover (JPEG)
// et trim ({ start, end } en secondes, pour ne garder que cette partie) : ce qui est absent
// reste tel quel, comme tous les autres tags.
async function writeTags(file, { title, artist, cover, trim }) {
  const base = path.join(app.getPath('temp'), `hanabi-player-tags-${Date.now()}`);
  const tmp = `${file}.tags.tmp`;
  const ogg = /\.(opus|ogg)$/i.test(file);
  const mp3 = /\.mp3$/i.test(file);
  // Dans un fichier Ogg, les tags sont portés par le flux audio ; ailleurs, par le fichier.
  const tagOption = ogg ? '-metadata:s:a:0' : '-metadata';
  const tags = [];
  if (title != null) tags.push(tagOption, `title=${title}`);
  if (artist != null) tags.push(tagOption, `artist=${artist}`);
  // Découpe au paquet près, sans réencodage. En Ogg, elle n'est précise qu'en sortie ; ailleurs,
  // elle se fait en entrée pour ne pas perdre la pochette jointe (image placée au tout début).
  // Pas de -ss quand le début est gardé : il retirerait le premier paquet Opus (horodatage négatif).
  // Sans `end`, on garde jusqu'à la fin.
  const cut = trim ? [
    ...(trim.start > 0 ? ['-ss', trim.start.toFixed(3)] : []),
    ...(trim.end != null ? ['-to', trim.end.toFixed(3)] : []),
  ] : [];
  const input = ['-y', '-v', 'error', ...(ogg ? [] : cut), '-i', file];
  try {
    if (ogg) {
      // Ogg n'accepte pas d'image jointe : la pochette est un tag texte, ajouté aux tags existants.
      await runFfmpeg([...input, '-map_metadata', '0:s:a:0', '-f', 'ffmetadata', `${base}.txt`]);
      const picture = cover ? { data: cover, format: 'image/jpeg' } : await currentCover(file);
      if (picture) {
        const block = pictureBlock(picture).toString('base64').replace(/=/g, '\\=');
        await fs.promises.appendFile(`${base}.txt`, `METADATA_BLOCK_PICTURE=${block}\n`);
      }
      await runFfmpeg([
        ...input, '-i', `${base}.txt`,
        '-map', '0:a', '-c', 'copy',
        '-map_metadata', '-1', '-map_metadata:s:a:0', '1:g', ...tags, ...cut,
        '-f', 'ogg', tmp,
      ]);
    } else {
      let streams = ['-map', '0']; // pochette existante conservée telle quelle
      if (cover) {
        await fs.promises.writeFile(`${base}.jpg`, cover);
        streams = [
          '-i', `${base}.jpg`, '-map', '0:a', '-map', '1:0',
          '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)',
          '-disposition:v', 'attached_pic',
        ];
      }
      await runFfmpeg([
        ...input, ...streams, '-c', 'copy',
        '-map_metadata', '0', ...(mp3 ? ['-id3v2_version', '3'] : []), ...tags,
        '-f', mp3 ? 'mp3' : 'ipod', tmp,
      ]);
    }
    await renameWithRetry(tmp, file);
    return {};
  } catch (err) {
    return { error: `Modifications non enregistrées : ${err.message}` };
  } finally {
    for (const f of [`${base}.jpg`, `${base}.txt`, tmp]) fs.rm(f, { force: true }, () => {});
  }
}

// ---------- Silences en début et fin de piste ----------

const SILENCE_DB = -50;   // en dessous de ce niveau, c'est du silence
const SILENCE_MIN = 0.3;  // durée minimale d'un silence pour être coupé (s)
const SILENCE_KEEP = 0.2; // marge gardée avant le premier son et après le dernier (s)

// Retourne la partie à garder { start, end }, ou null s'il n'y a rien à couper.
async function audibleRange(file) {
  const log = await runFfmpeg([
    '-hide_banner', '-nostats', '-i', file,
    '-map', '0:a:0', '-af', `silencedetect=noise=${SILENCE_DB}dB:d=${SILENCE_MIN}`, '-f', 'null', '-',
  ]);
  const d = log.match(/Duration: (\d+):(\d+):([\d.]+)/);
  if (!d) return null;
  const duration = d[1] * 3600 + d[2] * 60 + Number(d[3]);
  const starts = [...log.matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  if (!starts.length) return null;

  let start = 0;
  let end = duration;
  if (starts[0] <= 0.05) start = Math.max(0, ends[0] - SILENCE_KEEP);
  // Un silence qui dure jusqu'à la fin du fichier (sa fin manque ou tombe sur la fin du fichier)
  const lastEnd = ends.length === starts.length ? ends[ends.length - 1] : duration;
  if (lastEnd >= duration - 0.05 && starts[starts.length - 1] > start) {
    end = Math.min(duration, starts[starts.length - 1] + SILENCE_KEEP);
  }
  if (start < 0.1 && end > duration - 0.1) return null;
  if (end - start < 1) return null; // piste entièrement silencieuse : on n'y touche pas
  return { start, end };
}

// Coupe les silences au début et à la fin, sans réencodage. En cas d'échec, le fichier reste intact.
async function trimSilence(file) {
  try {
    const range = await audibleRange(file);
    if (range) await writeTags(file, { trim: range });
  } catch (err) {
    console.warn('Silences non coupés :', err.message);
  }
}

// ---------- Passages hors musique (intro et outro des clips) ----------

// SponsorBlock est une base communautaire qui repère notamment les passages hors musique des clips
// (catégorie « music_offtopic ») : saynète, bruitages, écran de fin… qui ne sont pas silencieux.
// Comme yt-dlp, on n'envoie que le début de l'empreinte de l'identifiant : le serveur renvoie
// toutes les vidéos qui la partagent, sans savoir laquelle nous intéresse.
const SPONSORBLOCK_API = 'https://sponsor.ajay.app/api/skipSegments/';
const EDGE_TOLERANCE = 1; // un passage à moins d'1 s du début ou de la fin est une intro / une outro
const MIN_MUSIC = 10;     // en dessous, les données sont sûrement fausses : on ne coupe pas

async function nonMusicSegments(videoId) {
  const prefix = crypto.createHash('sha256').update(videoId).digest('hex').slice(0, 4);
  const categories = encodeURIComponent('["music_offtopic"]');
  const res = await net.fetch(`${SPONSORBLOCK_API}${prefix}?categories=${categories}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return []; // 404 : aucun passage connu
  const video = (await res.json()).find((v) => v.videoID === videoId);
  return video ? video.segments : [];
}

// Partie à garder sans l'intro ni l'outro hors musique { start, end }, ou null s'il n'y en a pas.
// (Les passages au milieu du morceau ne sont pas retirés.)
async function musicRange(videoId) {
  const segments = (await nonMusicSegments(videoId))
    .map((s) => ({ start: s.segment[0], end: s.segment[1], duration: s.videoDuration || 0 }))
    .sort((a, b) => a.start - b.start);
  if (!segments.length) return null;

  let start = 0;
  for (const s of segments) if (s.start <= start + EDGE_TOLERANCE) start = Math.max(start, s.end);
  // Sans durée connue, on ne peut pas savoir si un passage touche la fin
  const duration = Math.max(...segments.map((s) => s.duration));
  let end = duration || null;
  if (end) for (const s of [...segments].reverse()) if (s.end >= end - EDGE_TOLERANCE) end = Math.min(end, s.start);

  const cutsEnd = end != null && end < duration - EDGE_TOLERANCE;
  if (start < 0.1 && !cutsEnd) return null;
  if (end != null && end - start < MIN_MUSIC) return null;
  return { start, end: cutsEnd ? end : null };
}

async function trimNonMusic(file, videoId) {
  try {
    const range = await musicRange(videoId);
    if (range) await writeTags(file, { trim: range });
  } catch (err) {
    console.warn('Passages hors musique non coupés :', err.message);
  }
}

// ---------- Titre, artiste et pochette du morceau ----------

// Le catalogue iTunes est interrogeable sans compte ni clé et fournit des pochettes carrées.
// Tout ce qui suit est facultatif : sans Internet, ou si le service ne répond pas ou ne trouve
// rien de sûr, le fichier garde simplement les infos de la vidéo, nettoyées.
const ITUNES_API = 'https://itunes.apple.com/search';
const LOOKUP_TIMEOUT = 5000;
const COVER_SIZE = 600; // comme les pochettes choisies à la main (cover.js)
// Écart de durée accepté entre le fichier et le morceau trouvé (s) : un clip est souvent plus long
// que le morceau (intro, fin) même après nettoyage, presque jamais plus court.
const SHORTER_TOLERANCE = 6;
const LONGER_TOLERANCE = 45;
const CLOSE_DURATION = 8; // en dessous, c'est sûrement la même version

// Mentions qui ne font pas partie du nom du morceau
const NOISE = /\b(official|officiel(le)?|music\s+video|lyric\s+video|video|vidéo|clip|mv|m\/v|audio|lyrics?|paroles|visuali[sz]er|hd|hq|4k|full\s+ver(sion)?)\b/i;
const TRAILING_NOISE = /[\s\-–—|:]*\b(official|officiel(le)?)?\s*(music\s+video|lyric\s+video|video|vidéo|clip|mv|m\/v|audio|lyrics|visuali[sz]er|hd|4k)\s*$/i;
// Versions différentes du morceau original : on ne les retient que si la vidéo les mentionne aussi.
const VARIANTS = /\b(live|remix|mix|acoustic|instrumental|inst|karaoke|cover|piano|music box|sped up|slowed|nightcore|8d|lofi|demo|orchestra)\b/i;

// Minuscules, sans accents ni ponctuation, entouré d'espaces pour chercher des mots entiers.
const words = (s) => ` ${(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
const mentions = (text, name) => words(name).trim() !== '' && text.includes(words(name));

const stripBrackets = (s) => s.replace(/\s*(\([^)]*\)|\[[^\]]*\]|【[^】]*】)/g, '').trim();

// Nom de chaîne qui désigne clairement l'artiste (« ArtisteVEVO », « Artiste - Topic »), ou null.
function channelArtist(channel) {
  const name = (channel || '').replace(/\s*-\s*topic$|vevo$|\s+official$/i, '').trim();
  return name && name !== channel ? name : null;
}

// Devine l'artiste et le titre à partir du titre d'une vidéo. `sure` : l'artiste et le titre
// étaient clairement séparés (« Artiste - Titre », « Artiste 'Titre' »).
function guessFromTitle(raw, channel) {
  let t = raw
    .replace(/\s*(\[[^\]]*\]|【[^】]*】)\s*/g, ' ')
    // Parenthèses de mentions (« (Official Video) ») ou de traduction (« IU(아이유) ») ;
    // celles qui comptent, comme « (feat. …) » ou « (Remix) », restent.
    .replace(/\s*\(([^)]*)\)/g, (m, inside) => (NOISE.test(inside) || !/\p{Script=Latin}/u.test(inside) ? '' : m))
    .replace(/\s+/g, ' ').trim();
  while (TRAILING_NOISE.test(t)) t = t.replace(TRAILING_NOISE, '').trim();

  const quoted = t.match(/^(.+?)\s*['‘’"“”「『](.+?)['‘’"“”」』]\s*(.*)$/);
  if (quoted) return { artist: quoted[1].trim(), title: `${quoted[2]} ${quoted[3]}`.trim(), sure: true };
  const parts = t.split(/\s[-–—_|]\s/);
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim(), sure: true };
  return { artist: channelArtist(channel), title: t || raw, sure: false };
}

async function audioDuration(file) {
  try {
    mm ??= await import('music-metadata');
    return (await mm.parseFile(file, { duration: true })).format.duration || null;
  } catch {
    return null;
  }
}

async function searchItunes(term) {
  const query = new URLSearchParams({ term, media: 'music', entity: 'song', limit: '15' });
  const res = await net.fetch(`${ITUNES_API}?${query}`, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT) });
  if (!res.ok) return [];
  return (await res.json()).results || [];
}

// Résultat qui correspond vraiment au morceau : son artiste et son titre apparaissent dans `text`
// (titre de la vidéo, chaîne…), ce n'est pas une autre version, et la durée concorde.
function bestMatch(results, text, duration) {
  const matches = results.filter((r) => {
    if (r.kind !== 'song' || !r.trackName || !r.artistName) return false;
    const title = stripBrackets(r.trackName.replace(/\s+-\s+.*$/, ''));
    if (!mentions(text, title)) return false;
    if (!r.artistName.split(/\s*(?:,|&|\band\b|\bx\b|\bfeat\.?|\bft\.?|\bwith\b)\s*/i).some((a) => mentions(text, a))) return false;
    const variant = r.trackName.match(new RegExp(VARIANTS.source, 'gi')) || [];
    if (variant.some((v) => !mentions(text, v))) return false;
    if (!duration || !r.trackTimeMillis) return true;
    const diff = duration - r.trackTimeMillis / 1000;
    return diff >= -SHORTER_TOLERANCE && diff <= LONGER_TOLERANCE;
  });
  // Dans l'ordre de pertinence d'iTunes, en préférant une durée presque identique
  const close = (r) => duration && r.trackTimeMillis && Math.abs(duration - r.trackTimeMillis / 1000) <= CLOSE_DURATION;
  return matches.find(close) || matches[0] || null;
}

async function fetchCover(url) {
  try {
    const res = await net.fetch(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT) });
    if (!res.ok) return null;
    const image = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()));
    return image.isEmpty() ? null : image.toJPEG(85);
  } catch {
    return null;
  }
}

// Cherche le morceau en ligne : { title, artist, cover (JPEG ou null) }, ou null si rien de sûr
// n'a été trouvé, si le service ne répond pas ou s'il n'y a pas de connexion. Ne lève jamais d'erreur.
async function lookupTrack({ text, artist, title, duration }) {
  if (!net.isOnline() || !title) return null;
  const terms = [...new Set([artist && `${stripBrackets(artist)} ${stripBrackets(title)}`, stripBrackets(title)])]
    .filter((t) => t && t.trim());
  for (const term of terms) {
    try {
      const found = bestMatch(await searchItunes(term), words(text), duration);
      if (!found) continue;
      const cover = found.artworkUrl100
        ? await fetchCover(found.artworkUrl100.replace(/\/\d+x\d+bb\./, `/${COVER_SIZE}x${COVER_SIZE}bb.`))
        : null;
      return { title: found.trackName, artist: found.artistName, cover };
    } catch (err) {
      console.warn('Recherche du morceau impossible :', err.message);
      return null; // hors délai ou réponse illisible : inutile d'insister
    }
  }
  return null;
}

// Miniature de la vidéo recadrée en carré centré, comme une pochette, ou null si inutile.
async function squareThumbnail(file) {
  const pic = await currentCover(file);
  if (!pic) return null;
  const image = nativeImage.createFromBuffer(Buffer.from(pic.data));
  const { width, height } = image.getSize();
  if (!width || width === height) return null;
  const side = Math.min(width, height);
  const size = Math.min(side, COVER_SIZE);
  return image
    .crop({ x: Math.round((width - side) / 2), y: Math.round((height - side) / 2), width: side, height: side })
    .resize({ width: size, height: size, quality: 'best' })
    .toJPEG(85);
}

// Après un téléchargement : vrai titre, artiste et pochette si le morceau est trouvé, sinon titre
// de la vidéo débarrassé de ses mentions et miniature recadrée. En cas d'échec, le fichier reste tel quel.
async function tagDownload(file) {
  try {
    const guess = file.track
      ? { artist: file.artist, title: file.track, sure: true }
      : guessFromTitle(file.title || '', file.channel);
    const found = await lookupTrack({
      text: [file.title, file.channel, file.track, file.artist].join(' '),
      artist: guess.artist,
      title: guess.title,
      duration: await audioDuration(file.path),
    });
    const changes = {};
    if (found) {
      changes.title = found.title;
      changes.artist = found.artist;
      if (found.cover) changes.cover = found.cover;
    } else if (!file.track) {
      // YouTube n'a rien fourni : yt-dlp a mis le titre de la vidéo et le nom de la chaîne.
      if (guess.title !== file.title) changes.title = guess.title;
      if (guess.artist && (guess.sure || !file.artist)) changes.artist = guess.artist;
    }
    if (!changes.cover) {
      const thumb = await squareThumbnail(file.path);
      if (thumb) changes.cover = thumb;
    }
    if (Object.keys(changes).length) await writeTags(file.path, changes);
  } catch (err) {
    console.warn('Infos du morceau non complétées :', err.message);
  }
}

// Recherche lancée depuis la fenêtre d'édition, à partir de ce qui y est saisi.
async function lookupForEditor(file, { title, artist }) {
  const name = path.basename(file, path.extname(file));
  const guess = title && artist ? { title, artist } : guessFromTitle(title || name, null);
  if (!guess.artist && artist) guess.artist = artist;
  if (!net.isOnline()) return { error: 'Pas de connexion Internet' };
  const found = await lookupTrack({
    text: [title, artist, name].join(' '),
    artist: guess.artist,
    title: guess.title,
    duration: await audioDuration(file),
  });
  return found || { error: 'Morceau introuvable' };
}

// Le fichier peut être en cours de lecture : c'est l'interface du lecteur qui le libère le temps
// de l'écriture puis reprend la lecture (saveTags dans renderer.js). On passe donc par elle.
const tagRequests = new Map();
let tagRequestId = 0;

function saveTagsViaPlayer(file, changes) {
  return new Promise((resolve) => {
    const id = ++tagRequestId;
    tagRequests.set(id, resolve);
    send('save-tags', { id, file, changes });
  });
}

// ---------- Fenêtre d'édition (titre, artiste, pochette) ----------

const EDITOR_WIDTH = 340;
const EDITOR_HEIGHT = 450;
let editor = null;
let editorFile = null;

// Au-dessus du lecteur si la place le permet, sinon en dessous.
function besidePlayer(width, height) {
  const p = win.getBounds();
  const a = screen.getDisplayMatching(p).workArea;
  let y = p.y - height - 8;
  if (y < a.y) y = Math.min(p.y + p.height + 8, a.y + a.height - height);
  const x = Math.max(a.x, Math.min(p.x + p.width - width, a.x + a.width - width));
  return { x, y, width, height };
}

const editorBounds = () => besidePlayer(EDITOR_WIDTH, EDITOR_HEIGHT);

function openEditor(file) {
  editorFile = file;
  if (editor) {
    editor.webContents.send('editor-reload');
    editor.show();
    editor.focus();
    return;
  }
  editor = new BrowserWindow({
    ...editorBounds(),
    parent: win,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    backgroundMaterial: 'acrylic',
    backgroundColor: '#00000000',
    show: false,
    icon: ICON_PATH,
    title: 'Modifier le morceau',
    webPreferences: {
      preload: path.join(__dirname, 'editor-preload.js'),
    },
  });
  editor.loadFile(path.join(__dirname, 'renderer', 'editor.html'));
  editor.once('ready-to-show', () => editor.show());
  // Même souci de première image que le lecteur avec le fond acrylic.
  editor.on('show', () => setTimeout(() => editor && editor.webContents.invalidate(), 50));
  editor.on('closed', () => { editor = null; });
}

// ---------- Fenêtre ----------

function initialBounds() {
  const b = settings.bounds;
  if (b) {
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      b.x >= a.x && b.y >= a.y && b.x + 40 <= a.x + a.width && b.y + 20 <= a.y + a.height);
    if (visible) return { x: b.x, y: b.y };
  }
  const a = screen.getPrimaryDisplay().workArea;
  return { x: a.x + a.width - WIN_WIDTH - 16, y: a.y + a.height - WIN_HEIGHT - 16 };
}

function createWindow() {
  win = new BrowserWindow({
    ...initialBounds(),
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: settings.alwaysOnTop,
    backgroundMaterial: settings.transparent ? 'acrylic' : 'none',
    backgroundColor: '#00000000',
    show: false,
    icon: ICON_PATH,
    title: 'Hanabi Player',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.on('moved', () => {
    const { x, y } = win.getBounds();
    settings.bounds = { x, y };
    saveSettings();
  });
  win.on('move', () => frameWin && !frameWin.isDestroyed() && frameWin.setBounds(frameBounds(frameSkin || settings.fxTheme)));

  // ✕ ou Alt+F4 : on cache au lieu de quitter
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('show', () => {
    // Avec le fond acrylic, Electron n'affiche pas toujours la première image : on force un repaint.
    setTimeout(() => !win.isDestroyed() && win.webContents.invalidate(), 50);
    updateTray();
    updateFrameWindow();
  });
  win.on('hide', () => {
    updateTray();
    updateFrameWindow();
  });
  // Clic droit sur une zone de déplacement : notre menu à la place du menu système de Windows
  win.on('system-context-menu', (e) => {
    e.preventDefault();
    showSoundMenu();
  });

  startHoverWatcher();
}

// Fondu discret : opacité réduite quand la souris n'est pas sur le lecteur (réglage « Transparence » ;
// sans lui, le lecteur reste pleinement opaque).
// (On interroge la position du curseur car les zones "drag" ne reçoivent pas les événements souris.)
function startHoverWatcher() {
  setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    const target = inside || !settings.transparent ? 1 : IDLE_OPACITY;
    const current = win.getOpacity();
    if (Math.abs(current - target) < 0.01) return;
    const step = 0.1 * Math.sign(target - current);
    win.setOpacity(Math.abs(target - current) <= 0.1 ? target : current + step);
    if (frameWin && !frameWin.isDestroyed()) frameWin.setOpacity(win.getOpacity());
  }, 30);
}

// ---------- Fenêtre-cadre (contour qui déborde du lecteur) ----------

// Une personnalisation dont le contour déborde du lecteur (SAVAGE (Meshy) : le cadre du modèle 3D, ses épines
// vers l'extérieur) : il est posé dans une fenêtre transparente plus grande, au-dessus du lecteur, qui laisse
// passer les clics et le suit (déplacement, masquage, fondu). `left`, `top` : position du lecteur dans
// l'image du cadre (renderer/skins/<nom>-frame.png, 3×), `width`, `height` : taille du cadre (px).
const FRAME_SKINS = {
  'savage-meshy': { left: 82, top: 35, width: 703, height: 171 },
};
let frameWin = null;
let frameSkin = null;

function frameBounds(skin) {
  const b = win.getBounds(), f = FRAME_SKINS[skin];
  return { x: b.x - f.left, y: b.y - f.top, width: f.width, height: f.height };
}

function updateFrameWindow() {
  const skin = FRAME_SKINS[settings.fxTheme] ? settings.fxTheme : null;
  const wanted = skin && win && !win.isDestroyed() && win.isVisible();
  if (!wanted) {
    if (frameWin && !frameWin.isDestroyed()) frameWin.hide();
    return;
  }
  if (!frameWin || frameWin.isDestroyed()) {
    frameWin = new BrowserWindow({
      ...frameBounds(skin),
      parent: win, // toujours au-dessus du lecteur
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      show: false,
      webPreferences: { preload: path.join(__dirname, 'frame-preload.js') },
    });
    frameWin.setIgnoreMouseEvents(true); // les clics vont au lecteur dessous
    frameWin.loadFile(path.join(__dirname, 'renderer', 'frame.html'));
    frameWin.webContents.on('did-finish-load', () => frameWin.webContents.send('frame-skin', frameSkin));
    frameWin.on('closed', () => { frameWin = null; });
    frameSkin = null;
  }
  if (frameSkin !== skin) {
    frameSkin = skin;
    if (!frameWin.webContents.isLoading()) frameWin.webContents.send('frame-skin', skin);
  }
  frameWin.setBounds(frameBounds(skin));
  frameWin.setOpacity(win.getOpacity());
  if (!frameWin.isVisible()) frameWin.showInactive();
}

// le reflet du cadre, animé par le lecteur à chaque image
ipcMain.on('frame-fx', (_e, fx) => {
  if (frameWin && !frameWin.isDestroyed() && frameWin.isVisible()) frameWin.webContents.send('frame-fx', fx);
});


function showWindow() {
  win.show();
  win.focus();
}

function toggleWindow() {
  if (win.isVisible()) win.hide();
  else showWindow();
}

function setAlwaysOnTop(flag) {
  settings.alwaysOnTop = flag;
  win.setAlwaysOnTop(flag);
  saveSettings();
  updateTray();
}

// Transparence du lecteur, au choix (menu) : fond de verre (acrylic Windows) et fondu quand la souris n'est
// pas dessus, ou fond sombre plein et pleinement opaque en permanence
function setTransparent(flag) {
  settings.transparent = flag;
  send('transparent', flag); // le fond plein ne dépend que de la page : il s'applique quoi qu'il arrive
  try {
    win.setBackgroundMaterial(flag ? 'acrylic' : 'none');
  } catch (err) {
    console.warn('Changement du fond de verre impossible :', err.message);
  }
  saveSettings();
  updateTray();
}

function send(cmd, arg) {
  if (win && !win.isDestroyed()) win.webContents.send('command', cmd, arg);
}

// ---------- Effets d'ambiance ----------

// Mêmes noms que FX_THEMES dans renderer/effects.js
const FX_THEMES = [['glass', 'Verre liquide'], ['savage', 'SAVAGE'], ['savage-meshy', 'SAVAGE (Meshy)'], ['aurora', 'Aurore'], ['neon', 'Néon'], ['ember', 'Braise'], ['mono', 'Monochrome']];

// Réglages modifiables depuis la fenêtre de personnalisation, avec leurs valeurs admises
const FX_SETTINGS = {
  fxPulse: (v) => typeof v === 'boolean',
  fxPressure: (v) => typeof v === 'boolean',
  fxHalo: (v) => typeof v === 'boolean',
  fxNotes: (v) => typeof v === 'boolean',
  fxNotesLevel: (v) => typeof v === 'number' && v >= 0 && v <= 1.5,
  fxSyncMs: (v) => Number.isInteger(v) && v >= -200 && v <= 200,
  fxPulseLevel: (v) => typeof v === 'number' && v >= 0 && v <= 1.5,
  fxPressureLevel: (v) => typeof v === 'number' && v >= 0 && v <= 1.5,
  fxHaloLevel: (v) => typeof v === 'number' && v >= 0 && v <= 1.5,
  fxTheme: (v) => FX_THEMES.some(([name]) => name === v),
  fxColorMode: (v) => ['theme', 'cover', 'custom'].includes(v),
  fxCustomColor: (v) => /^#[0-9a-f]{6}$/i.test(v),
};

function fxConfig() {
  return {
    pulse: settings.fxPulse,
    pressure: settings.fxPressure,
    halo: settings.fxHalo,
    notes: settings.fxNotes,
    levels: { pulse: settings.fxPulseLevel, pressure: settings.fxPressureLevel, halo: settings.fxHaloLevel, notes: settings.fxNotesLevel },
    syncMs: settings.fxSyncMs,
    theme: settings.fxTheme,
    colorMode: settings.fxColorMode,
    customColor: settings.fxCustomColor,
  };
}

function setEffects(partial) {
  for (const [key, value] of Object.entries(partial)) {
    if (FX_SETTINGS[key]?.(value)) settings[key] = value;
  }
  if (typeof partial.fxSyncMs === 'number' && playback.audioDevice) settings.fxSyncByDevice[playback.audioDevice] = settings.fxSyncMs;
  saveSettings();
  send('effects', fxConfig());
  sendFxPanel();
  updateTray();
  updateFrameWindow();
}

// ---------- Fenêtre « Personnaliser les effets » ----------

const FX_PANEL_WIDTH = 360;
const FX_PANEL_HEIGHT = 840; // cinq thèmes (trois rangées), descriptions des effets sur deux lignes, boutons du bas compris
let fxPanel = null;

function openFxPanel() {
  if (fxPanel) {
    fxPanel.show();
    fxPanel.focus();
    return;
  }
  fxPanel = new BrowserWindow({
    ...besidePlayer(FX_PANEL_WIDTH, FX_PANEL_HEIGHT),
    parent: win,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    backgroundMaterial: 'acrylic',
    backgroundColor: '#00000000',
    show: false,
    icon: ICON_PATH,
    title: 'Personnaliser les effets',
    webPreferences: {
      preload: path.join(__dirname, 'fx-panel-preload.js'),
    },
  });
  fxPanel.loadFile(path.join(__dirname, 'renderer', 'fx-panel.html'));
  fxPanel.once('ready-to-show', () => fxPanel.show());
  // Même souci de première image que le lecteur avec le fond acrylic.
  fxPanel.on('show', () => setTimeout(() => fxPanel && fxPanel.webContents.invalidate(), 50));
  fxPanel.on('closed', () => { fxPanel = null; });
}

// Réglages et couleur de la pochette en cours, pour les aperçus
const fxPanelState = () => ({ config: fxConfig(), coverColor: playback.fxColor || null, audioDevice: playback.audioDevice || null });

function sendFxPanel() {
  if (fxPanel && !fxPanel.isDestroyed()) fxPanel.webContents.send('fx-panel-update', fxPanelState());
}

// ---------- Effets sonores (appliqués à l'écoute par sound.js) ----------

const SOUND_EFFECTS = [
  ['none', 'Aucun'],
  null,
  ['room', 'Réverbération : salle'],
  ['cathedral', 'Réverbération : cathédrale'],
  ['slowed', 'Slowed + reverb'],
  ['speedup', 'Speed up'],
  null,
  ['bass', 'Bass boost'],
  ['8d', '8D (au casque)'],
  ['echo', 'Écho'],
  ['lofi', 'Lo-fi / radio'],
  null,
  ['night', 'Mode nuit (volume lissé)'],
  ['karaoke', 'Karaoké (voix atténuée)'],
];

function soundEffect() {
  const found = SOUND_EFFECTS.find((e) => e && e[0] === settings.soundFx) || SOUND_EFFECTS[0];
  return { name: found[0], label: found[1] };
}

function setSoundEffect(name) {
  settings.soundFx = name;
  saveSettings();
  send('sound', soundEffect());
}

function soundMenu() {
  return SOUND_EFFECTS.map((e) => (e
    ? { label: e[1], type: 'radio', checked: settings.soundFx === e[0], click: () => setSoundEffect(e[0]) }
    : { type: 'separator' }));
}

// Clic droit sur le lecteur : uniquement l'effet sonore
function showSoundMenu() {
  popupGlassMenu([{ label: 'Effet sonore', enabled: false }, ...soundMenu()]);
}

// ---------- Menus en verre ----------

// Les menus du lecteur (bouton ✨, bouton dossier, clic droit) : une petite fenêtre de verre sombre sous le
// bouton (renderer/menu.html), au lieu du menu natif de Windows, impossible à styler. Le menu de la zone de
// notification, lui, reste natif.
// `template` : comme pour Menu.buildFromTemplate (label, type 'checkbox' | 'radio' | 'separator', checked,
// enabled, click(item), submenu : une rangée « libellé — choix en cours › » qui ouvre sa liste dans le même
// menu, avec un retour) ; un libellé désactivé sans type devient un titre de section. `anchor` : rectangle du bouton dans la page du lecteur ({ x, y, width, height }) ; sans,
// le menu s'ouvre sous la souris. → promesse résolue à la fermeture du menu (après le clic éventuel).
const MENU_WIDTH = 232;
const MENU_ROW = { normal: 28, checkbox: 28, radio: 28, submenu: 28, separator: 9, header: 24 }; // voir menu.css
let glassMenu = null; // { window, items, clicks }

function popupGlassMenu(template, anchor = null) {
  glassMenu?.window.close();
  const clicks = [], rows = [];
  const build = (list) => {
    const items = [];
    for (const it of list) {
      if (it.type === 'separator') {
        if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' });
      } else if (it.submenu) {
        const chosen = it.submenu.find((sub) => sub.checked && sub.type === 'radio');
        items.push({ type: 'submenu', label: it.label, value: chosen?.label || '', enabled: true, items: build(it.submenu) });
      } else if (it.enabled === false && !it.type && !it.click) {
        items.push({ type: 'header', label: it.label });
      } else {
        const row = { id: clicks.length, label: it.label, type: it.type || 'normal', checked: !!it.checked, enabled: it.enabled !== false };
        items.push(row);
        rows.push(row);
        clicks.push(it);
      }
    }
    while (items.length && items[items.length - 1].type === 'separator') items.pop();
    return items;
  };
  const items = build(template);
  const height = 12 + items.reduce((sum, it) => sum + MENU_ROW[it.type], 0);

  // Sous le bouton, aligné sur son bord droit ; au-dessus s'il n'y a pas la place en bas
  const page = win.getContentBounds();
  const cursor = screen.getCursorScreenPoint();
  const point = anchor
    ? { x: page.x + anchor.x + anchor.width - MENU_WIDTH, y: page.y + anchor.y + anchor.height + 4, top: page.y + anchor.y - 4 }
    : { x: cursor.x, y: cursor.y, top: cursor.y };
  const area = screen.getDisplayNearestPoint(point).workArea;
  const x = Math.max(area.x, Math.min(point.x, area.x + area.width - MENU_WIDTH));
  const y = point.y + height <= area.y + area.height ? point.y : Math.max(area.y, point.top - height);

  const menuWin = new BrowserWindow({
    x: Math.round(x), y: Math.round(y), width: MENU_WIDTH, height,
    parent: win,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundMaterial: 'acrylic',
    backgroundColor: '#00000000',
    show: false,
    icon: ICON_PATH,
    webPreferences: { preload: path.join(__dirname, 'menu-preload.js') },
  });
  const current = { window: menuWin, items, rows, clicks, top: Math.round(y) };
  glassMenu = current;
  menuWin.loadFile(path.join(__dirname, 'renderer', 'menu.html'));
  menuWin.once('ready-to-show', () => { menuWin.show(); menuWin.focus(); });
  // Même souci de première image que le lecteur avec le fond acrylic.
  menuWin.on('show', () => setTimeout(() => !menuWin.isDestroyed() && menuWin.webContents.invalidate(), 50));
  menuWin.on('blur', () => !menuWin.isDestroyed() && menuWin.close()); // un clic ailleurs le ferme
  return new Promise((resolve) => menuWin.on('closed', () => {
    if (glassMenu === current) glassMenu = null;
    resolve();
  }));
}

const fromMenu = (e) => glassMenu && e.sender === glassMenu.window.webContents;
ipcMain.handle('menu-items', (e) => (fromMenu(e) ? glassMenu.items : []));
ipcMain.on('menu-close', (e) => fromMenu(e) && glassMenu.window.close());
// une liste ouverte depuis le menu (ou le retour) change sa hauteur : la fenêtre suit, sans sortir de l'écran
ipcMain.on('menu-resize', (e, height) => {
  if (!fromMenu(e)) return;
  const menuWin = glassMenu.window, bounds = menuWin.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const h = Math.round(Math.min(height, area.height));
  menuWin.setBounds({ ...bounds, y: Math.max(area.y, Math.min(glassMenu.top, area.y + area.height - h)), height: h });
});
ipcMain.on('menu-click', (e, id) => {
  if (!fromMenu(e)) return;
  const { window: menuWin, rows, clicks } = glassMenu;
  const it = clicks[id], shown = rows.find((row) => row.id === id);
  // comme un menu natif : une case passe à l'état inverse, un choix parmi plusieurs devient coché ; le clic
  // compte avant la fermeture (le choix du bouton dossier attend la fermeture)
  if (it?.click && shown?.enabled) it.click({ checked: shown.type === 'checkbox' ? !shown.checked : true });
  menuWin.close();
});

// Même menu depuis le bouton ✨ du lecteur et depuis la zone de notification
function effectsMenu() {
  return [
    { label: 'Effet sonore', submenu: soundMenu() },
    { type: 'separator' },
    { label: 'Thème des effets visuels', enabled: false },
    ...FX_THEMES.map(([value, label]) => ({
      label,
      type: 'radio',
      checked: settings.fxTheme === value,
      click: () => setEffects({ fxTheme: value }),
    })),
    { type: 'separator' },
    { label: 'Rythme', type: 'checkbox', checked: settings.fxPulse, click: (item) => setEffects({ fxPulse: item.checked }) },
    { label: 'Basse', type: 'checkbox', checked: settings.fxPressure, click: (item) => setEffects({ fxPressure: item.checked }) },
    { label: 'Ambiance', type: 'checkbox', checked: settings.fxHalo, click: (item) => setEffects({ fxHalo: item.checked }) },
    { label: 'Voix', type: 'checkbox', checked: settings.fxNotes, click: (item) => setEffects({ fxNotes: item.checked }) },
    { type: 'separator' },
    { label: 'Personnaliser les effets…', click: openFxPanel },
  ];
}

// ---------- Touches multimédia ----------

// Les touches sont captées globalement : elles pilotent le lecteur même si une autre app
// (navigateur, etc.) a le focus. Chromium ne doit pas les traiter en double.
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');

function registerMediaKeys() {
  const keys = {
    MediaPlayPause: 'play-pause',
    MediaNextTrack: 'next',
    MediaPreviousTrack: 'prev',
    MediaStop: 'pause',
  };
  for (const [accelerator, cmd] of Object.entries(keys)) {
    if (!globalShortcut.register(accelerator, () => send(cmd))) {
      console.warn(`Touche ${accelerator} déjà utilisée par une autre application`);
    }
  }
}

// ---------- Zone de notification ----------

function createTray() {
  const image = nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16, quality: 'best' });
  tray = new Tray(image);
  tray.on('click', toggleWindow);
  updateTray();
}

function updateTray() {
  if (!tray || !win) return;
  const menu = Menu.buildFromTemplate([
    ...(updateReady ? [
      // Sans clic, la mise à jour s'installe de toute façon à la prochaine fermeture
      { label: `Redémarrer pour passer à la version ${updateReady}`, click: () => autoUpdater.quitAndInstall(true, true) },
      { type: 'separator' },
    ] : []),
    { label: playback.title || 'Hanabi Player', enabled: false },
    { type: 'separator' },
    { label: playback.playing ? 'Pause' : 'Lecture', click: () => send('play-pause') },
    { label: 'Suivant', click: () => send('next') },
    { label: 'Précédent', click: () => send('prev') },
    { type: 'separator' },
    { label: win.isVisible() ? 'Masquer le lecteur' : 'Afficher le lecteur', click: toggleWindow },
    {
      label: 'Toujours au premier plan',
      type: 'checkbox',
      checked: settings.alwaysOnTop,
      click: (item) => setAlwaysOnTop(item.checked),
    },
    {
      label: 'Transparence',
      type: 'checkbox',
      checked: settings.transparent,
      click: (item) => setTransparent(item.checked),
    },
    { label: 'Effets', submenu: effectsMenu() },
    { label: 'Changer de dossier…', click: () => { showWindow(); send('choose-folder'); } },
    { label: 'Télécharger depuis YouTube…', click: () => { showWindow(); send('youtube'); } },
    { type: 'separator' },
    { label: 'Quitter', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  const tip = playback.title ? `Hanabi Player — ${playback.title}` : 'Hanabi Player';
  tray.setToolTip(tip.length > 127 ? tip.slice(0, 126) + '…' : tip);
}

// ---------- IPC ----------

ipcMain.handle('get-initial-state', async () => {
  let tracks = [];
  if (settings.folder && fs.existsSync(settings.folder)) tracks = await scanFolder(settings.folder);
  return { settings, tracks, sound: soundEffect(), effects: fxConfig() };
});

// Choix de la musique : `kind` 'folder' (un dossier entier), 'track' (une piste : on lit son dossier en
// commençant par elle), ou rien pour le demander dans un petit menu (sous le bouton `anchor`, ou la souris).
// Windows ne sait pas proposer pistes et dossiers dans une même fenêtre de choix.
// → { folder, tracks, file } (file : la piste choisie, ou null), ou null si annulé.
ipcMain.handle('choose-folder', async (_e, kind, anchor) => {
  if (!kind) {
    await popupGlassMenu([
      { label: 'Choisir une piste…', click: () => { kind = 'track'; } },
      { label: 'Choisir un dossier…', click: () => { kind = 'folder'; } },
    ], anchor);
  }
  if (!kind) return null;
  const result = await dialog.showOpenDialog(win, kind === 'track'
    ? {
        title: 'Choisir une piste',
        defaultPath: settings.folder || app.getPath('music'),
        properties: ['openFile'],
        filters: [{ name: 'Pistes audio', extensions: ['mp3', 'opus', 'm4a'] }],
      }
    : {
        title: 'Choisir le dossier de musique',
        defaultPath: settings.folder || app.getPath('music'),
        properties: ['openDirectory'],
      });
  if (result.canceled || !result.filePaths[0]) return null;
  const file = kind === 'track' ? result.filePaths[0] : null;
  settings.folder = file ? path.dirname(file) : result.filePaths[0];
  settings.lastTrack = file;
  settings.position = 0;
  saveSettings();
  return { folder: settings.folder, tracks: await scanFolder(settings.folder), file };
});

ipcMain.handle('get-metadata', (_e, file) => readMetadata(file));

// Contenu d'un MP3 pour la pré-analyse des effets d'ambiance : uniquement dans le dossier de musique,
// et pas les fichiers énormes (un mix de plusieurs heures saturerait la mémoire une fois décodé).
ipcMain.handle('read-audio', async (_e, file) => {
  if (!settings.folder || !/\.(mp3|opus|m4a)$/i.test(file)) return null;
  const full = path.resolve(file).toLowerCase();
  if (!full.startsWith(path.resolve(settings.folder).toLowerCase() + path.sep)) return null;
  try {
    if ((await fs.promises.stat(file)).size > 40 * 1024 * 1024) return null;
    return await fs.promises.readFile(file);
  } catch {
    return null;
  }
});

// Effets ratés signalés pendant l'écoute (touches F et C du lecteur) : une ligne JSON par signalement,
// pour retrouver les passages où la détection se trompe.
ipcMain.on('fx-report', (_e, r) => {
  if (typeof r?.file !== 'string' || !Number.isFinite(r.time) || !['faux', 'manque'].includes(r.kind)) return;
  const line = JSON.stringify({ file: r.file, time: r.time, kind: r.kind, source: String(r.source), at: new Date().toISOString() });
  fs.appendFile(path.join(app.getPath('userData'), 'fx-reports.jsonl'), line + '\n', (err) => err && console.warn('Signalement non gardé :', err));
});

ipcMain.handle('convert-youtube', (_e, url) => convertYoutube(url));
ipcMain.on('cancel-youtube', cancelYoutube);
ipcMain.handle('read-clipboard', () => clipboard.readText());
ipcMain.handle('write-tags', (_e, file, changes) => writeTags(file, changes));
ipcMain.on('tags-saved', (_e, id, result) => {
  tagRequests.get(id)?.(result);
  tagRequests.delete(id);
});

ipcMain.on('open-editor', (_e, file) => openEditor(file));
ipcMain.handle('editor-load', async () => ({
  file: editorFile,
  name: path.basename(editorFile),
  ...await readMetadata(editorFile),
}));
ipcMain.handle('editor-save', (_e, changes) => saveTagsViaPlayer(editorFile, changes));
ipcMain.handle('editor-lookup', (_e, fields) => lookupForEditor(editorFile, fields));
ipcMain.on('editor-close', () => editor?.close());

ipcMain.on('save-state', (_e, partial) => {
  Object.assign(settings, partial);
  saveSettings();
});

ipcMain.on('hide-window', () => win.hide());
ipcMain.on('effects-menu', (_e, anchor) => popupGlassMenu(effectsMenu(), anchor));
ipcMain.on('sound-menu', showSoundMenu);

ipcMain.on('playback', (_e, info) => {
  const deviceChanged = info.audioDevice && info.audioDevice !== playback.audioDevice;
  playback = { ...playback, ...info };
  updateTray();
  // Nouvelle sortie audio : on reprend le réglage de synchronisation retenu pour elle (0 si inconnue).
  if (deviceChanged) setEffects({ fxSyncMs: settings.fxSyncByDevice[info.audioDevice] ?? 0 });
  else if (info.fxColor) sendFxPanel();
});

ipcMain.handle('fx-panel-load', () => fxPanelState());
ipcMain.on('fx-panel-set', (_e, partial) => setEffects(partial));
ipcMain.on('fx-panel-close', () => fxPanel?.close());

// ---------- Mises à jour automatiques ----------

// Les versions sont publiées dans les Releases du dépôt GitHub (public) par
// .github/workflows/release.yml, et se lisent sans jeton.
const UPDATE_CHECK_INTERVAL = 6 * 3600 * 1000;
let updateReady = null; // version téléchargée, installée à la fermeture de l'app

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  autoUpdater.setFeedURL({ provider: 'github', owner: 'khamlica', repo: 'Lecteur-mp3' });
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = info.version;
    updateTray();
  });
  autoUpdater.on('error', (err) => console.warn('Mise à jour impossible :', err.message));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, UPDATE_CHECK_INTERVAL);
}

// ---------- Cycle de vie ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => win && showWindow());

  app.whenReady().then(() => {
    app.setAppUserModelId('com.khamlichi.lecteurmp3'); // identifiant d'origine, gardé pour les mises à jour
    migrateOldData();
    loadSettings();
    createWindow();
    createTray();
    registerMediaKeys();
    setupAutoUpdate();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    cancelYoutube();
  });

  // Avant de quitter, on laisse l'interface enregistrer la position de lecture.
  app.on('before-quit', (e) => {
    quitting = true;
    if (!flushed && win && !win.isDestroyed()) {
      e.preventDefault();
      flushed = true;
      send('flush');
      setTimeout(() => app.quit(), 300);
      return;
    }
    writeSettings();
  });
}
