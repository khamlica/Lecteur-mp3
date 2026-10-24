// Fenêtre des paroles : la ligne en cours au milieu, les autres autour ; mot à mot seulement quand la source des
// paroles donne l'instant de chaque mot (LRC étendu). Le temps vient du lecteur (renderer.js), qui envoie sa position
// à chaque changement (lecture, pause, saut) puis chaque seconde ; entre deux, on la prolonge avec l'horloge.
const $ = (id) => document.getElementById(id);
const ui = {
  lines: $('lines'),
  message: $('message'),
  status: $('status'),
  roman: $('roman'),
  offset: document.querySelector('.offset'),
  offsetValue: $('offset-value'),
};

const OFFSET_STEP = 0.1;
const TOUCH = document.documentElement.classList.contains('android'); // sur le téléphone, l'appui long remplace le clic droit
const MIN_FILL = 0.18; // un mot très court se remplit quand même sur ~0,2 s (sinon il clignote)

let data = null;     // paroles du morceau en cours (voir lyrics-load dans main.js)
let rows = [];       // { el, line, words: [{ el, start, end }] }
let track = null;
let current = -1;
let nowWord = null;
let clock = { time: 0, playing: false, rate: 1, at: Date.now() };
let syncMs = 0;      // retard de la sortie audio (réglage des effets), en ms

const position = () => clock.time + (clock.playing ? ((Date.now() - clock.at) / 1000) * clock.rate : 0);
// Instant des paroles qui correspond à ce qu'on entend
const lyricsTime = () => position() + syncMs / 1000 - (data?.offset || 0);

const formatOffset = (s) => `${s > 0 ? '+' : s < 0 ? '−' : ''}${Math.abs(s).toFixed(1).replace('.', ',')} s`;
const ROMANIZE_DICT = 'romanize-dict/'; // dictionnaire japonais (lectures des kanji), chargé pour les seuls morceaux japonais
let japaneseSong = false;
// Lignes à romaniser : le coréen, et le japonais d'un morceau japonais (des kanji seuls peuvent être du chinois)
const needsRoman = (text) => Romanize.hasHangul(text) || (japaneseSong && Romanize.hasJapanese(text));

// ---------- Affichage ----------

function setMessage(text) {
  ui.message.textContent = text || '';
}

// Les mots calés d'une ligne, retrouvés dans son texte : les espaces et la ponctuation d'origine restent en place.
function renderWords(el, line) {
  let cursor = 0;
  const words = [];
  for (const w of line.words) {
    const at = line.text.indexOf(w.text, cursor);
    if (at < 0) continue;
    if (at > cursor) el.append(line.text.slice(cursor, at));
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = w.text;
    el.append(span);
    words.push({ el: span, start: w.time, end: null });
    cursor = at + w.text.length;
  }
  if (cursor < line.text.length) el.append(line.text.slice(cursor));
  // un mot se remplit jusqu'au début du suivant, sans dépasser la durée moyenne d'un mot de la ligne
  const avg = words.length > 1 ? (words.at(-1).start - words[0].start) / (words.length - 1) : 0.5;
  words.forEach((w, k) => { w.end = Math.max(w.start + MIN_FILL, Math.min(words[k + 1]?.start ?? Infinity, w.start + Math.max(avg, 0.3) * 1.5)); });
  return words;
}

async function render() {
  ui.lines.textContent = '';
  rows = [];
  current = -1;
  nowWord = null;
  track = document.createElement('div');
  track.id = 'track';
  ui.lines.append(track);
  ui.lines.classList.toggle('plain', !!data?.lines && !data.synced);
  ui.lines.scrollTop = 0;
  if (!data?.lines) return;

  japaneseSong = Romanize.isJapaneseSong(data.lines.map((l) => l.text));
  for (const line of data.lines) {
    const el = document.createElement('div');
    el.className = 'line';
    const text = document.createElement('span');
    let words = [];
    if (!line.text) {
      el.classList.add('blank');
      text.textContent = data.synced ? '♪' : '';
    } else if (line.words?.length) {
      el.classList.add('words');
      words = renderWords(text, line);
    } else {
      text.textContent = line.text;
    }
    el.append(text);
    const row = { el, line, words };
    if (line.text && needsRoman(line.text)) {
      const roman = document.createElement('span');
      roman.className = 'roman';
      el.append(roman);
      row.roman = roman;
    }
    if (data.synced && line.time != null) {
      // clic : aller à cette ligne ; clic droit : « cette ligne est chantée maintenant » (recale tout le morceau)
      el.addEventListener('click', () => lyricsApi.seek(Math.max(0, line.time + (data.offset || 0) - syncMs / 1000 + 0.01)));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        // arrondi vers le bas : la ligne visée doit être la ligne en cours, pas encore la précédente
        setOffset(Math.floor((position() + syncMs / 1000 - line.time) * 10) / 10);
      });
      el.title = 'Clic : aller à cette ligne · Clic droit : elle est chantée maintenant (recale les paroles)';
    }
    track.append(el);
    rows.push(row);
  }
  update(true);
  // La romanisation (le japonais demande son dictionnaire, ~0,3 s) arrive ensuite, ligne par ligne
  const lyrics = data;
  if (japaneseSong) Romanize.japaneseInit(ROMANIZE_DICT).catch((err) => console.warn('Dictionnaire japonais illisible :', err));
  for (const row of rows) {
    if (!row.roman) continue;
    try {
      const text = japaneseSong && Romanize.hasJapanese(row.line.text)
        ? await Romanize.japanese(row.line.text)
        : Romanize.korean(row.line.text);
      if (data !== lyrics) return;
      row.roman.textContent = text;
    } catch (err) {
      console.warn('Romanisation impossible :', err);
    }
  }
  update(true);
}

// Ligne et mot en cours ; `force` : recentrer même si la ligne n'a pas changé (nouvelles paroles, taille)
function update(force = false) {
  if (!data?.synced || !rows.length) return;
  const t = lyricsTime();
  let i = -1;
  for (let k = 0; k < rows.length; k++) {
    if (rows[k].line.time != null && rows[k].line.time <= t) i = k;
    else if (rows[k].line.time > t) break;
  }
  if (i !== current || force) {
    rows[current]?.el.classList.remove('current');
    rows.forEach((r, k) => r.el.classList.toggle('done', k < i));
    rows[i]?.el.classList.add('current');
    if (nowWord) nowWord.el.classList.remove('now');
    nowWord = null;
    current = i;
    const target = rows[Math.max(0, i)].el;
    const y = ui.lines.clientHeight / 2 - (target.offsetTop + target.offsetHeight / 2);
    track.style.transform = `translateY(${Math.round(y)}px)`;
  }
  const row = rows[i];
  if (!row?.words.length) return;
  let now = null;
  for (const w of row.words) {
    const sung = t >= w.end;
    w.el.classList.toggle('sung', sung);
    if (!sung && t >= w.start) now = w;
  }
  if (nowWord && nowWord !== now) nowWord.el.classList.remove('now');
  nowWord = now;
  if (now) {
    now.el.classList.add('now');
    now.el.style.setProperty('--p', `${Math.min(100, (100 * (t - now.start)) / (now.end - now.start)).toFixed(1)}%`);
  }
}

function frame() {
  if (clock.playing) update();
  requestAnimationFrame(frame);
}

function renderToolbar() {
  const synced = !!data?.lines && data.synced;
  ui.roman.hidden = !rows.some((r) => r.roman);
  ui.roman.classList.toggle('active', document.body.classList.contains('show-roman'));
  ui.offset.hidden = !synced;
  ui.offsetValue.textContent = formatOffset(data?.offset || 0);


  const parts = [];
  if (data?.source === 'lrclib') parts.push('Paroles : LRCLIB');
  else if (data?.source === 'tags') parts.push('Paroles du fichier');
  else if (data?.source === 'lrc') parts.push('Fichier .lrc');
  if (data?.lines && !data.synced) parts.push('non synchronisées');
  if (data?.match?.title) parts.push(`${data.match.artist} – ${data.match.title}`);
  ui.status.textContent = parts.join(' · ');
  ui.status.title = synced ? `Paroles en décalage ? ${TOUCH ? 'Appui long' : 'Clic droit'} sur une ligne au moment où elle est chantée` : '';
}

function show(next) {
  const same = data && next && data.file === next.file && data.lines === next.lines;
  data = next;
  if (next?.syncMs != null) syncMs = next.syncMs;
  document.body.classList.toggle('show-roman', !!next?.options?.roman);
  if (!next || next.status === 'empty') setMessage('');
  else if (next.status === 'loading') setMessage('Recherche des paroles…');
  else if (next.missing) {
    const retry = TOUCH ? 'Toucher pour réessayer' : 'Cliquer pour réessayer';
    setMessage({
      offline: `Pas de connexion Internet. ${retry}`,
      error: `Le service de paroles ne répond pas. ${retry}`,
    }[next.reason] || 'Pas de paroles trouvées pour ce morceau');
  } else setMessage('');
  ui.message.classList.toggle('retry', !!next?.missing && (next.reason === 'offline' || next.reason === 'error'));
  if (!same) render();
  renderToolbar();
}

// ---------- Commandes ----------

ui.roman.addEventListener('click', () => {
  const on = !document.body.classList.contains('show-roman');
  document.body.classList.toggle('show-roman', on);
  lyricsApi.setOption('roman', on);
  renderToolbar();
  update(true);
});

function setOffset(value) {
  if (!data) return;
  data.offset = Math.round(value * 10) / 10;
  lyricsApi.setOffset(data.offset);
  renderToolbar();
  update(true);
}
$('earlier').addEventListener('click', () => setOffset((data?.offset || 0) - OFFSET_STEP));
$('later').addEventListener('click', () => setOffset((data?.offset || 0) + OFFSET_STEP));
ui.offsetValue.addEventListener('dblclick', () => setOffset(0));

ui.message.addEventListener('click', () => {
  if (ui.message.classList.contains('retry')) lyricsApi.research();
});
$('close').addEventListener('click', () => lyricsApi.close());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') lyricsApi.close();
});
window.addEventListener('resize', () => update(true));

lyricsApi.onLyrics(show);
lyricsApi.onClock((c) => {
  const jumped = Math.abs(c.time - position()) > 0.5;
  clock = c;
  if (c.syncMs != null) syncMs = c.syncMs;
  if (!c.playing || jumped) update(jumped);
});
lyricsApi.onTransparent((flag) => document.body.classList.toggle('opaque', !flag));

lyricsApi.load().then((initial) => {
  if (initial.clock) clock = initial.clock;
  document.body.classList.toggle('opaque', initial.transparent === false);
  show(initial.lyrics);
  requestAnimationFrame(frame);
});
