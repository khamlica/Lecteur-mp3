const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, screen, globalShortcut, clipboard, net } = require('electron');
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
  bounds: null,
  fxPulse: true,           // le lecteur pulse sur les basses
  fxPressure: true,        // lumière qui monte du bas sur les basses longues et lourdes
  fxHalo: true,            // halo lumineux sur tout le lecteur
  fxIntensity: 'normal',   // 'low' | 'normal' | 'high'
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

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8').replace(/^﻿/, '');
    settings = { ...DEFAULTS, ...JSON.parse(raw) };
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
const ytTempDir = () => path.join(app.getPath('temp'), 'lecteur-mp3-youtube');
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
      '--print', 'after_move:F %(id)s %(filepath)s',
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
        const space = value.indexOf(' '); // identifiant de la vidéo, puis chemin du fichier
        files.push({ id: value.slice(0, space), path: value.slice(space + 1) });
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
  const base = path.join(app.getPath('temp'), `lecteur-mp3-tags-${Date.now()}`);
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
function editorBounds() {
  const p = win.getBounds();
  const a = screen.getDisplayMatching(p).workArea;
  let y = p.y - EDITOR_HEIGHT - 8;
  if (y < a.y) y = Math.min(p.y + p.height + 8, a.y + a.height - EDITOR_HEIGHT);
  const x = Math.max(a.x, Math.min(p.x + p.width - EDITOR_WIDTH, a.x + a.width - EDITOR_WIDTH));
  return { x, y, width: EDITOR_WIDTH, height: EDITOR_HEIGHT };
}

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
    backgroundMaterial: 'acrylic',
    backgroundColor: '#00000000',
    show: false,
    icon: ICON_PATH,
    title: 'Lecteur MP3',
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
  });
  win.on('hide', updateTray);
  // Clic droit sur une zone de déplacement : notre menu à la place du menu système de Windows
  win.on('system-context-menu', (e) => {
    e.preventDefault();
    showSoundMenu();
  });

  startHoverWatcher();
}

// Fondu discret : opacité réduite quand la souris n'est pas sur le lecteur.
// (On interroge la position du curseur car les zones "drag" ne reçoivent pas les événements souris.)
function startHoverWatcher() {
  setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    const target = inside ? 1 : IDLE_OPACITY;
    const current = win.getOpacity();
    if (Math.abs(current - target) < 0.01) return;
    const step = 0.1 * Math.sign(target - current);
    win.setOpacity(Math.abs(target - current) <= 0.1 ? target : current + step);
  }, 30);
}

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

function send(cmd, arg) {
  if (win && !win.isDestroyed()) win.webContents.send('command', cmd, arg);
}

// ---------- Effets d'ambiance ----------

const FX_INTENSITIES = [['low', 'Douce'], ['normal', 'Normale'], ['high', 'Forte']];

function setEffects(partial) {
  Object.assign(settings, partial);
  saveSettings();
  send('effects', { pulse: settings.fxPulse, pressure: settings.fxPressure, halo: settings.fxHalo, intensity: settings.fxIntensity });
  updateTray();
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
  Menu.buildFromTemplate([{ label: 'Effet sonore', enabled: false }, ...soundMenu()]).popup({ window: win });
}

// Même menu depuis le bouton ✨ du lecteur et depuis la zone de notification
function effectsMenu() {
  return [
    { label: 'Effet sonore', submenu: soundMenu() },
    { type: 'separator' },
    { label: 'Pulsation sur les basses', type: 'checkbox', checked: settings.fxPulse, click: (item) => setEffects({ fxPulse: item.checked }) },
    { label: 'Pression des basses lourdes', type: 'checkbox', checked: settings.fxPressure, click: (item) => setEffects({ fxPressure: item.checked }) },
    { label: 'Halo d\'ambiance', type: 'checkbox', checked: settings.fxHalo, click: (item) => setEffects({ fxHalo: item.checked }) },
    { type: 'separator' },
    { label: 'Intensité', enabled: false },
    ...FX_INTENSITIES.map(([value, label]) => ({
      label,
      type: 'radio',
      checked: settings.fxIntensity === value,
      enabled: settings.fxPulse || settings.fxPressure || settings.fxHalo,
      click: () => setEffects({ fxIntensity: value }),
    })),
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
    { label: playback.title || 'Lecteur MP3', enabled: false },
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
    { label: 'Effets', submenu: effectsMenu() },
    { label: 'Changer de dossier…', click: () => { showWindow(); send('choose-folder'); } },
    { label: 'Télécharger depuis YouTube…', click: () => { showWindow(); send('youtube'); } },
    { type: 'separator' },
    { label: 'Quitter', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  const tip = playback.title ? `Lecteur MP3 — ${playback.title}` : 'Lecteur MP3';
  tray.setToolTip(tip.length > 127 ? tip.slice(0, 126) + '…' : tip);
}

// ---------- IPC ----------

ipcMain.handle('get-initial-state', async () => {
  let tracks = [];
  if (settings.folder && fs.existsSync(settings.folder)) tracks = await scanFolder(settings.folder);
  return { settings, tracks, sound: soundEffect() };
});

ipcMain.handle('choose-folder', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choisir le dossier de musique',
    defaultPath: settings.folder || app.getPath('music'),
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  settings.folder = result.filePaths[0];
  settings.lastTrack = null;
  settings.position = 0;
  saveSettings();
  return { folder: settings.folder, tracks: await scanFolder(settings.folder) };
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
ipcMain.on('editor-close', () => editor?.close());

ipcMain.on('save-state', (_e, partial) => {
  Object.assign(settings, partial);
  saveSettings();
});

ipcMain.on('hide-window', () => win.hide());
ipcMain.on('effects-menu', () => Menu.buildFromTemplate(effectsMenu()).popup({ window: win }));
ipcMain.on('sound-menu', showSoundMenu);

ipcMain.on('playback', (_e, info) => {
  playback = { ...playback, ...info };
  updateTray();
});

// ---------- Cycle de vie ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => win && showWindow());

  app.whenReady().then(() => {
    app.setAppUserModelId('com.khamlichi.lecteurmp3');
    loadSettings();
    createWindow();
    createTray();
    registerMediaKeys();
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
