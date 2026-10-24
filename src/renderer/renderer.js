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
let fxSource = 'mix';  // d'où viennent les effets du morceau en cours (voir createAmbiance, onSource)
const FX_SOURCE_LABELS = { mix: 'analyse du morceau entier', separating: 'séparation des instruments en cours…', stems: 'instruments séparés' };
ambiance.onSource((source) => { fxSource = source; renderFx(); });

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
  reportLyricsClock();
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
    api.reportPlayback({ fxColor: ambiance.setColor(null) });
  }
  api.reportPlayback({ title: meta.artist ? `${title} — ${meta.artist}` : title });
}

function showEmpty() {
  audio.removeAttribute('src');
  audio.load();
  ui.coverImg.hidden = true;
  api.reportPlayback({ fxColor: ambiance.setColor(null) });
  ui.title.textContent = folder ? 'Aucun morceau trouvé' : 'Aucun dossier';
  ui.artist.textContent = folder ? folder : 'Cliquez ici pour choisir un dossier de musique';
  ui.info.title = 'Choisir un dossier de musique';
  ui.info.classList.add('clickable');
  ui.timeCur.textContent = '0:00';
  ui.timeDur.textContent = '0:00';
  setRange(ui.progress, 0);
  api.reportPlayback({ title: '', playing: false });
  reportLyricsClock();
}

// ---------- Paroles ----------

// La fenêtre des paroles (lyrics.js) suit la position de lecture : envoyée à chaque lecture, pause, saut ou
// changement de morceau, puis chaque seconde ; entre deux, elle avance avec l'horloge.
let lastLyricsClock = 0;
function reportLyricsClock() {
  lastLyricsClock = Date.now();
  api.lyricsClock?.({
    file: current()?.path || null,
    time: audio.currentTime || 0,
    playing: !audio.paused,
    rate: audio.playbackRate,
    duration: isFinite(audio.duration) ? audio.duration : null,
    at: Date.now(),
  });
}

function seekTo(time) {
  if (!isFinite(audio.duration)) return;
  audio.currentTime = Math.max(0, Math.min(audio.duration, time));
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
  visualsOn = config.pulse || config.pressure || config.halo || config.notes;
  renderFx();
}

function setSoundEffect({ name, label }) {
  sound.setEffect(name);
  soundLabel = name === 'none' ? null : label;
  renderFx();
}

function renderFx() {
  ui.fx.classList.toggle('active', visualsOn || !!soundLabel);
  // Un point sur le bouton : pulsant pendant la séparation des instruments, plein une fois séparés
  ui.fx.dataset.source = visualsOn ? fxSource : '';
  const details = [visualsOn && FX_SOURCE_LABELS[fxSource], soundLabel && `son : ${soundLabel}`].filter(Boolean);
  ui.fx.title = details.length ? `Effets (${details.join(' ; ')})` : 'Effets';
}

// `kind` : 'folder' ou 'track' ; sans, un petit menu sous la souris demande lequel (voir choose-folder).
// Une piste choisie : on lit son dossier en commençant par elle.
async function chooseFolder(kind, anchor) {
  const result = await api.chooseFolder(kind, anchor);
  if (!result) return;
  folder = result.folder;
  if (result.file) setTracks(result.tracks, result.file, 0, true);
  else setTracks(result.tracks);
}

// Le dossier a changé sans qu'on le choisisse (morceaux reçus par la synchronisation) : la liste suit, sans couper le
// morceau en cours
function refreshTracks({ folder: dir, tracks: list }) {
  if (folder && dir !== folder) return;
  const playing = current();
  if (!playing) {
    folder = dir;
    return setTracks(list);
  }
  tracks = list;
  const idx = tracks.findIndex((t) => t.path === playing.path);
  buildOrder(idx >= 0 ? idx : null);
  document.body.classList.toggle('empty', tracks.length === 0);
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
  // barre de progression du champ : le pourcentage du téléchargement s'il est donné, sinon une attente
  const pct = /(\d+)\s?%/.exec(text);
  const yt = $('yt');
  yt.classList.toggle('busy', ytBusy && !error);
  yt.classList.toggle('waiting', ytBusy && !error && !pct);
  yt.style.setProperty('--yt-pct', pct ? `${pct[1]}%` : '');
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
  ui.muteIcon.setAttribute('href', silent ? '#i-volume-off' : audio.volume < 0.5 ? '#i-volume-low' : '#i-volume');
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

audio.addEventListener('play', () => {
  renderPlayState();
  reportLyricsClock();
});
audio.addEventListener('pause', () => {
  renderPlayState();
  savePosition();
  reportLyricsClock();
});
for (const event of ['playing', 'seeked', 'ratechange', 'loadedmetadata']) audio.addEventListener(event, reportLyricsClock);
audio.addEventListener('playing', () => { errorStreak = 0; });
audio.addEventListener('loadedmetadata', renderProgress);
audio.addEventListener('timeupdate', () => {
  renderProgress();
  if (Date.now() - lastLyricsClock > 1000) reportLyricsClock();
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
// rectangle d'un bouton, pour ouvrir son menu juste dessous
const anchorOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
$('folder').addEventListener('click', () => chooseFolder(undefined, anchorOf($('folder'))));
ui.fx.addEventListener('click', () => api.showEffectsMenu(anchorOf(ui.fx)));
ambiance.onFrameFx((fx) => api.frameFx(fx));
ui.coverImg.addEventListener('load', () => api.reportPlayback({ fxColor: ambiance.setColor(ui.coverImg) }));
$('cover').addEventListener('click', () => {
  if (current()) api.openEditor(current().path);
});
$('youtube').addEventListener('click', () => {
  if (document.body.classList.contains('yt') && !ytBusy) closeYoutube();
  else openYoutube();
});
$('close').addEventListener('click', () => api.hideWindow());
$('lyrics')?.addEventListener('click', () => api.toggleLyrics());
ui.mute.addEventListener('click', toggleMute);

// Titre ou artiste trop long : fondu sur le bord et défilement au survol (style.css, classe long), sur la
// longueur qui dépasse, à ~30 px/s
function fitText(el) {
  el.classList.remove('long');
  const overflow = el.scrollWidth - el.clientWidth;
  el.classList.toggle('long', overflow > 1);
  el.style.setProperty('--shift', `${-overflow - 4}px`);
  el.style.setProperty('--scroll-time', `${Math.max(3, overflow / 30 + 1.5).toFixed(1)}s`);
}
for (const el of [ui.title, ui.artist]) new MutationObserver(() => fitText(el)).observe(el, { childList: true, characterData: true, subtree: true });
window.addEventListener('resize', () => { fitText(ui.title); fitText(ui.artist); });
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
    case 'f': case 'F': reportFx('faux'); break;
    case 'c': case 'C': reportFx('manque'); break;
  }
});

// Signalement d'un effet raté pendant l'écoute, pour améliorer la détection : F = la pochette s'est
// allumée sans coup de batterie, C = un coup net n'a rien allumé. Gardé (main.js) avec le morceau,
// l'instant et la méthode d'analyse ; un petit message confirme.
let reportTimer = null;
function reportFx(kind) {
  const track = current();
  if (!track || !visualsOn) return;
  api.reportFx({ file: track.path, time: +audio.currentTime.toFixed(3), kind, source: fxSource });
  let note = document.getElementById('fx-report');
  if (!note) {
    note = document.createElement('div');
    note.id = 'fx-report';
    document.body.append(note);
  }
  note.textContent = kind === 'faux' ? 'Signalé : allumée sans coup' : 'Signalé : coup manqué';
  note.classList.add('shown');
  clearTimeout(reportTimer);
  reportTimer = setTimeout(() => note.classList.remove('shown'), 1200);
}

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
    case 'choose-folder': chooseFolder('folder'); break;
    case 'youtube': openYoutube(); break;
    case 'yt-progress': showYoutubeProgress(arg); break;
    case 'save-tags': saveTags(arg.file, arg.changes).then((result) => api.tagsSaved(arg.id, result)); break;
    case 'effects': setEffects(arg); break;
    case 'transparent': document.body.classList.toggle('opaque', !arg); break;
    case 'sound': setSoundEffect(arg); break;
    case 'flush': savePosition(); break;
    case 'library-changed': refreshTracks(arg); break;
    case 'seek': seekTo(arg); break;
    case 'lyrics-open': $('lyrics')?.classList.toggle('active', !!arg); break;
  }
});

// ---------- Démarrage ----------

// Sortie audio par défaut (haut-parleurs, casque Bluetooth…) : chacune garde son réglage de synchronisation.
async function reportAudioDevice() {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const output = devices.find((d) => d.kind === 'audiooutput' && d.deviceId === 'default');
  if (output && output.label) api.reportPlayback({ audioDevice: output.label.replace(/^[^-]+ - /, '') });
}
navigator.mediaDevices.addEventListener('devicechange', reportAudioDevice);

(async () => {
  const { settings, tracks: list, sound: soundEffect, effects } = await api.getInitialState();
  folder = settings.folder;
  document.body.classList.toggle('opaque', settings.transparent === false);
  $('lyrics')?.classList.toggle('active', !!settings.lyricsOpen);
  shuffle = settings.shuffle;
  repeat = settings.repeat;
  audio.volume = settings.volume;
  audio.muted = settings.muted;
  setEffects(effects);
  setSoundEffect(soundEffect);
  renderModes();
  renderVolume();
  renderPlayState();
  setTracks(list, settings.lastTrack, settings.position);
  reportAudioDevice();
})();
