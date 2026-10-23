const $ = (id) => document.getElementById(id);

const audio = new Audio();
const ui = {
  coverImg: $('cover-img'),
  info: $('info'),
  title: $('title'),
  artist: $('artist'),
  play: $('play'),
  playIcon: $('play-icon'),
  shuffle: $('shuffle'),
  repeat: $('repeat'),
  repeatIcon: $('repeat-icon'),
  fx: $('fx'),
  progress: $('progress'),
  timeCur: $('time-cur'),
  timeDur: $('time-dur'),
  mute: $('mute'),
  muteIcon: $('mute-icon'),
  volume: $('volume'),
  ytUrl: $('yt-url'),
  ytStatus: $('yt-status'),
};

let folder = null;
let tracks = [];   // { path, url, name }
let order = [];    // indices de `tracks` dans l'ordre de lecture
let pos = -1;      // position courante dans `order`
let shuffle = false;
let repeat = 'off'; // 'off' | 'all' | 'one'
let seeking = false;
let errorStreak = 0;
let lastPositionSave = 0;

const sound = createSound(audio);
const ambiance = createAmbiance(audio, $('bar'), api.readAudio, sound);
let visualsOn = false;
let soundLabel = null; // effet sonore actif, s'il y en a un

const current = () => (pos >= 0 ? tracks[order[pos]] : null);

// ---------- Ordre de lecture ----------

function buildOrder(keepIdx = null) {
  order = tracks.map((_, i) => i);
  if (shuffle) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    if (keepIdx != null) {
      order.splice(order.indexOf(keepIdx), 1);
      order.unshift(keepIdx);
    }
  }
  if (keepIdx != null) pos = order.indexOf(keepIdx);
  else pos = order.length ? 0 : -1;
}

function setTracks(list, lastPath = null, startAt = 0, autoplay = false) {
  audio.pause();
  tracks = list;
  const idx = tracks.findIndex((t) => t.path === lastPath);
  buildOrder(idx >= 0 ? idx : null);
  document.body.classList.toggle('empty', tracks.length === 0);
  if (pos >= 0) loadTrack(pos, { autoplay, startAt: idx >= 0 ? startAt : 0 });
  else showEmpty();
}

// ---------- Chargement d'un morceau ----------

async function loadTrack(newPos, { autoplay = false, startAt = 0 } = {}) {
  pos = newPos;
  const track = current();
  if (!track) return;

  audio.src = track.url;
  ambiance.setTrack(track.path);
  lastPositionSave = Date.now(); // évite d'écraser la position restaurée avant le saut
  if (startAt > 0) {
    audio.addEventListener('loadedmetadata', () => {
      audio.currentTime = Math.min(startAt, audio.duration || startAt);
    }, { once: true });
  }
  if (autoplay) audio.play().catch(() => {});

  showInfo(track, {});
  api.saveState({ lastTrack: track.path, position: startAt });

  const meta = await api.getMetadata(track.path);
  if (current() === track) showInfo(track, meta);
}

function showInfo(track, meta) {
  const title = meta.title || track.name;
  const artist = meta.artist || meta.album || 'Artiste inconnu';
  ui.title.textContent = title;
  ui.artist.textContent = artist;
  ui.info.title = `${title}\n${artist}`;
  ui.info.classList.remove('clickable');

  if (meta.cover) {
    ui.coverImg.src = meta.cover;
    ui.coverImg.hidden = false;
  } else {
    ui.coverImg.hidden = true;
    ui.coverImg.removeAttribute('src');
    ambiance.setColor(null);
  }
  api.reportPlayback({ title: meta.artist ? `${title} — ${meta.artist}` : title });
}

function showEmpty() {
  audio.removeAttribute('src');
  audio.load();
  ui.coverImg.hidden = true;
  ambiance.setColor(null);
  ui.title.textContent = folder ? 'Aucun morceau trouvé' : 'Aucun dossier';
  ui.artist.textContent = folder ? folder : 'Cliquez ici pour choisir un dossier de musique';
  ui.info.title = 'Choisir un dossier de musique';
  ui.info.classList.add('clickable');
  ui.timeCur.textContent = '0:00';
  ui.timeDur.textContent = '0:00';
  setRange(ui.progress, 0);
  api.reportPlayback({ title: '', playing: false });
}

// ---------- Commandes ----------

function togglePlay() {
  if (!tracks.length) return chooseFolder();
  if (pos < 0) return loadTrack(0, { autoplay: true });
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

function next(auto = false) {
  if (!order.length) return;
  if (auto && repeat === 'one') {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  let p = pos + 1;
  if (p >= order.length) {
    const playedIdx = order[pos];
    if (shuffle) {
      buildOrder();
      // évite de rejouer immédiatement le même morceau
      if (order.length > 1 && order[0] === playedIdx) [order[0], order[1]] = [order[1], order[0]];
    }
    p = 0;
    if (auto && repeat === 'off') return loadTrack(p); // fin de liste : on s'arrête sur le premier
  }
  loadTrack(p, { autoplay: true });
}

function prev() {
  if (!order.length) return;
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  loadTrack(pos > 0 ? pos - 1 : order.length - 1, { autoplay: true });
}

function seekBy(seconds) {
  if (!isFinite(audio.duration)) return;
  audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + seconds));
}

function toggleShuffle() {
  shuffle = !shuffle;
  buildOrder(pos >= 0 ? order[pos] : null);
  renderModes();
  api.saveState({ shuffle });
}

function cycleRepeat() {
  repeat = { off: 'all', all: 'one', one: 'off' }[repeat];
  renderModes();
  api.saveState({ repeat });
}

function setVolume(v) {
  audio.volume = Math.max(0, Math.min(1, v));
  if (audio.volume > 0) audio.muted = false;
  renderVolume();
  api.saveState({ volume: audio.volume, muted: audio.muted });
}

function toggleMute() {
  audio.muted = !audio.muted;
  renderVolume();
  api.saveState({ muted: audio.muted });
}

function setEffects(config) {
  ambiance.setConfig(config);
  visualsOn = config.pulse || config.pressure || config.halo;
  renderFx();
}

function setSoundEffect({ name, label }) {
  sound.setEffect(name);
  soundLabel = name === 'none' ? null : label;
  renderFx();
}

function renderFx() {
  ui.fx.classList.toggle('active', visualsOn || !!soundLabel);
  ui.fx.title = soundLabel ? `Effets (son : ${soundLabel})` : 'Effets';
}

async function chooseFolder() {
  const result = await api.chooseFolder();
  if (!result) return;
  folder = result.folder;
  setTracks(result.tracks);
}

function savePosition() {
  if (current()) api.saveState({ position: audio.currentTime || 0 });
}

// ---------- YouTube → audio ----------

const YT_HINT = 'Entrée pour télécharger l\'audio';
const isYoutubeUrl = (s) => /^(https?:\/\/)?([\w-]+\.)?(youtube\.com|youtu\.be)\/\S+$/i.test(s.trim());
let ytBusy = false;

function setYtStatus(text, error = false) {
  ui.ytStatus.textContent = text;
  ui.ytStatus.title = text;
  ui.ytStatus.classList.toggle('error', error);
}

async function openYoutube(url = null) {
  if (ytBusy) return ui.ytUrl.focus();
  if (url == null) {
    const clip = (await api.readClipboard()).trim();
    url = isYoutubeUrl(clip) ? clip : '';
  }
  document.body.classList.add('yt');
  ui.ytUrl.readOnly = false;
  ui.ytUrl.value = url;
  setYtStatus(YT_HINT);
  ui.ytUrl.focus();
  ui.ytUrl.select();
}

function closeYoutube() {
  if (ytBusy) {
    setYtStatus('Annulation…');
    return api.cancelYoutube();
  }
  document.body.classList.remove('yt');
  ui.ytUrl.blur();
}

async function convertYoutube() {
  const url = ui.ytUrl.value.trim();
  if (ytBusy || !url) return;
  if (!isYoutubeUrl(url)) return setYtStatus('Ce n\'est pas un lien YouTube', true);

  ytBusy = true;
  ui.ytUrl.readOnly = true;
  setYtStatus('Préparation…');
  const result = await api.convertYoutube(url);
  ytBusy = false;

  if (result.error) {
    ui.ytUrl.readOnly = false;
    ui.ytUrl.value = url;
    return setYtStatus(result.error, true);
  }
  closeYoutube();
  if (result.cancelled) return;
  folder = result.folder;
  setTracks(result.tracks, result.file, 0, true);
}

function showYoutubeProgress({ title, status }) {
  if (!ytBusy) return;
  if (title) ui.ytUrl.value = title;
  if (status) setYtStatus(status);
}

// ---------- Tags et pochette ----------

let coverBusy = false;

// Écrit les tags d'un fichier (titre, artiste, pochette). S'il est en cours de lecture, on le libère
// le temps de la réécriture, puis on reprend la lecture au même endroit.
async function saveTags(file, changes) {
  const track = current();
  const loaded = track && track.path === file;
  const time = audio.currentTime;
  const wasPlaying = !audio.paused;
  if (loaded) {
    audio.removeAttribute('src');
    audio.load();
  }
  const result = await api.writeTags(file, changes);
  if (loaded && current() === track) await loadTrack(pos, { autoplay: wasPlaying, startAt: time });
  return result;
}

function flashArtist(text) {
  const previous = ui.artist.textContent;
  ui.artist.textContent = text;
  setTimeout(() => {
    if (ui.artist.textContent === text) ui.artist.textContent = previous;
  }, 3000);
}

async function pasteCover(blob) {
  const track = current();
  if (!track || coverBusy) return;
  coverBusy = true;
  try {
    let jpeg;
    try {
      jpeg = await squareCover(blob);
    } catch {
      return flashArtist('Image illisible');
    }
    const result = await saveTags(track.path, { cover: jpeg });
    if (current() === track) flashArtist(result.error || 'Pochette enregistrée dans le fichier');
  } finally {
    coverBusy = false;
  }
}

// ---------- Affichage ----------

const fmt = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

function setRange(input, fraction) {
  input.value = Math.round(fraction * Number(input.max));
  input.style.setProperty('--pct', `${fraction * 100}%`);
}

function renderProgress() {
  const d = audio.duration;
  ui.timeCur.textContent = fmt(audio.currentTime);
  ui.timeDur.textContent = fmt(d);
  if (!seeking) setRange(ui.progress, isFinite(d) && d > 0 ? audio.currentTime / d : 0);
}

function renderModes() {
  ui.shuffle.classList.toggle('active', shuffle);
  ui.shuffle.title = shuffle ? 'Lecture aléatoire : activée' : 'Lecture aléatoire : désactivée';
  ui.repeat.classList.toggle('active', repeat !== 'off');
  ui.repeatIcon.setAttribute('href', repeat === 'one' ? '#i-repeat-one' : '#i-repeat');
  ui.repeat.title = {
    off: 'Répétition : désactivée',
    all: 'Répétition : toute la liste',
    one: 'Répétition : ce morceau',
  }[repeat];
}

function renderVolume() {
  const silent = audio.muted || audio.volume === 0;
  ui.muteIcon.setAttribute('href', silent ? '#i-volume-off' : '#i-volume');
  ui.mute.title = audio.muted ? 'Rétablir le son' : 'Couper le son';
  setRange(ui.volume, audio.muted ? 0 : audio.volume);
}

function renderPlayState() {
  const playing = !audio.paused;
  ui.playIcon.setAttribute('href', playing ? '#i-pause' : '#i-play');
  ui.play.title = playing ? 'Pause' : 'Lecture';
  api.reportPlayback({ playing });
}

// ---------- Événements audio ----------

audio.addEventListener('play', renderPlayState);
audio.addEventListener('pause', () => {
  renderPlayState();
  savePosition();
});
audio.addEventListener('playing', () => { errorStreak = 0; });
audio.addEventListener('loadedmetadata', renderProgress);
audio.addEventListener('timeupdate', () => {
  renderProgress();
  const now = Date.now();
  if (now - lastPositionSave > 5000) {
    lastPositionSave = now;
    savePosition();
  }
});
audio.addEventListener('ended', () => next(true));
audio.addEventListener('error', () => {
  // fichier illisible : on passe au suivant, sans boucler indéfiniment
  if (!audio.src || ++errorStreak >= tracks.length) return;
  let p = pos + 1 >= order.length ? 0 : pos + 1;
  loadTrack(p, { autoplay: true });
});

// ---------- Interface ----------

ui.play.addEventListener('click', togglePlay);
$('next').addEventListener('click', () => next());
$('prev').addEventListener('click', prev);
ui.shuffle.addEventListener('click', toggleShuffle);
ui.repeat.addEventListener('click', cycleRepeat);
$('folder').addEventListener('click', chooseFolder);
ui.fx.addEventListener('click', () => api.showEffectsMenu());
ui.coverImg.addEventListener('load', () => ambiance.setColor(ui.coverImg));
$('cover').addEventListener('click', () => {
  if (current()) api.openEditor(current().path);
});
$('youtube').addEventListener('click', () => {
  if (document.body.classList.contains('yt') && !ytBusy) closeYoutube();
  else openYoutube();
});
$('close').addEventListener('click', () => api.hideWindow());
ui.mute.addEventListener('click', toggleMute);
ui.info.addEventListener('click', () => {
  if (ui.info.classList.contains('clickable')) chooseFolder();
});

ui.progress.addEventListener('input', () => {
  seeking = true;
  const fraction = ui.progress.value / ui.progress.max;
  ui.progress.style.setProperty('--pct', `${fraction * 100}%`);
  ui.timeCur.textContent = fmt(fraction * (audio.duration || 0));
});
ui.progress.addEventListener('change', () => {
  if (isFinite(audio.duration)) audio.currentTime = (ui.progress.value / ui.progress.max) * audio.duration;
  seeking = false;
});

ui.volume.addEventListener('input', () => setVolume(ui.volume.value / ui.volume.max));
ui.volume.addEventListener('wheel', (e) => {
  e.preventDefault();
  setVolume(audio.volume + (e.deltaY < 0 ? 0.05 : -0.05));
}, { passive: false });

// Coller une image remplace la pochette du morceau en cours ;
// coller un lien YouTube n'importe où dans le lecteur lance directement la conversion.
document.addEventListener('paste', (e) => {
  const image = imageFrom(e.clipboardData);
  if (image) {
    e.preventDefault();
    return pasteCover(image);
  }
  if (e.target === ui.ytUrl || ytBusy) return;
  const text = e.clipboardData.getData('text').trim();
  if (!isYoutubeUrl(text)) return;
  e.preventDefault();
  openYoutube(text).then(convertYoutube);
});

document.addEventListener('keydown', (e) => {
  if (e.target === ui.ytUrl) {
    if (e.key === 'Enter') convertYoutube();
    else if (e.key === 'Escape') closeYoutube();
    return; // le champ de saisie garde ses touches (espace, lettres…)
  }
  if (e.target instanceof HTMLInputElement && e.key.startsWith('Arrow')) return; // le curseur gère déjà les flèches
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowRight': e.ctrlKey ? next() : seekBy(5); break;
    case 'ArrowLeft': e.ctrlKey ? prev() : seekBy(-5); break;
    case 'ArrowUp': setVolume(audio.volume + 0.05); break;
    case 'ArrowDown': setVolume(audio.volume - 0.05); break;
    case 'm': case 'M': toggleMute(); break;
    case 's': case 'S': toggleShuffle(); break;
    case 'r': case 'R': cycleRepeat(); break;
  }
});

// Clic droit : choix de l'effet sonore. (Sur les zones qui servent à déplacer la fenêtre,
// c'est le processus principal qui remplace le menu système par celui-ci.)
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  api.showSoundMenu();
});

// Commandes venant des touches multimédia et du menu de la zone de notification
api.onCommand((cmd, arg) => {
  switch (cmd) {
    case 'play-pause': togglePlay(); break;
    case 'pause': audio.pause(); break;
    case 'next': next(); break;
    case 'prev': prev(); break;
    case 'choose-folder': chooseFolder(); break;
    case 'youtube': openYoutube(); break;
    case 'yt-progress': showYoutubeProgress(arg); break;
    case 'save-tags': saveTags(arg.file, arg.changes).then((result) => api.tagsSaved(arg.id, result)); break;
    case 'effects': setEffects(arg); break;
    case 'sound': setSoundEffect(arg); break;
    case 'flush': savePosition(); break;
  }
});

// ---------- Démarrage ----------

(async () => {
  const { settings, tracks: list, sound: soundEffect } = await api.getInitialState();
  folder = settings.folder;
  shuffle = settings.shuffle;
  repeat = settings.repeat;
  audio.volume = settings.volume;
  audio.muted = settings.muted;
  setEffects({ pulse: settings.fxPulse, pressure: settings.fxPressure, halo: settings.fxHalo, intensity: settings.fxIntensity });
  setSoundEffect(soundEffect);
  renderModes();
  renderVolume();
  renderPlayState();
  setTracks(list, settings.lastTrack, settings.position);
})();
