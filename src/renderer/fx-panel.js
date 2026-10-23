const $ = (id) => document.getElementById(id);

const EFFECT_KEYS = {
  pulse: ['fxPulse', 'fxPulseLevel'],
  pressure: ['fxPressure', 'fxPressureLevel'],
  halo: ['fxHalo', 'fxHaloLevel'],
  notes: ['fxNotes', 'fxNotesLevel'],
};

const DEFAULTS = {
  fxPulse: true, fxPressure: true, fxHalo: true, fxNotes: true,
  fxPulseLevel: 1, fxPressureLevel: 1, fxHaloLevel: 1, fxNotesLevel: 1,
  fxTheme: 'aurora', fxColorMode: 'theme', fxCustomColor: '#ff7a3d', fxSyncMs: 0,
};

let config = null;      // réglages en cours (même forme que pour le lecteur)
let hovered = null;     // thème survolé : seul lui et le thème choisi s'animent
let focusedEffect = null; // effet dont on règle l'intensité : on ne montre que lui
let coverColor = null;  // couleur de la pochette du morceau en cours
const previews = {};    // thème → élément d'aperçu

// ---------- Construction ----------

for (const [name, theme] of Object.entries(FX_THEMES)) {
  const card = document.createElement('button');
  card.className = 'theme';
  card.dataset.theme = name;
  card.innerHTML = `
    <div class="preview fx-surface" data-fx-theme="${name}">
      <div class="fx-bass"></div>
      <div class="fx-lift"></div><div class="fx-sparkles"><i></i><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b></div>
      <div class="fx-notes"></div>
      <div class="fx-melody"></div>
      <div class="mini-cover fx-cover"></div>
      <div class="lines"><i></i><i></i></div>
    </div>
    <span></span>`;
  card.querySelector('span').textContent = theme.label;
  card.addEventListener('click', () => fxPanel.set({ fxTheme: name }));
  card.addEventListener('pointerenter', () => { hovered = name; });
  card.addEventListener('pointerleave', () => { if (hovered === name) hovered = null; });
  $('themes').append(card);
  previews[name] = card.querySelector('.preview');
}

// ---------- Affichage des réglages ----------

function setRange(input, value) {
  if (document.activeElement !== input) input.value = value;
  input.style.setProperty('--pct', `${((input.value - input.min) / (input.max - input.min)) * 100}%`);
}

const syncLabel = (ms) => (ms == 0 ? 'calé' : ms > 0 ? `avance ${ms} ms` : `retard ${-ms} ms`);

function render() {
  document.querySelectorAll('.theme').forEach((card) => card.classList.toggle('selected', card.dataset.theme === config.theme));

  const theme = FX_THEMES[config.theme] || FX_THEMES.aurora;
  $('color-section').classList.toggle('disabled', !!theme.colorless);
  document.querySelectorAll('#color-mode button').forEach((b) => b.classList.toggle('selected', b.dataset.mode === config.colorMode));
  if (document.activeElement !== $('custom-color')) $('custom-color').value = config.customColor;
  $('color-hint').textContent = theme.colorless ? 'Monochrome : lumière blanche uniquement.'
    : config.colorMode === 'custom' ? 'La couleur choisie, déclinée selon le thème.'
    : config.colorMode === 'cover' || !theme.colors ? 'La couleur dominante de la pochette du morceau.'
    : `Les couleurs propres au thème ${theme.label}.`;

  for (const row of document.querySelectorAll('.effect')) {
    const effect = row.dataset.effect;
    row.querySelector('input[type="checkbox"]').checked = config[effect];
    row.classList.toggle('off', !config[effect]);
    const range = row.querySelector('input[type="range"]');
    setRange(range, Math.round(config.levels[effect] * 100));
    row.querySelector('output').textContent = `${range.value} %`;
  }
}

let audioDevice = null; // sortie audio en cours : le réglage de synchronisation lui est propre

function renderSync() {
  setRange($('sync'), config.syncMs);
  $('sync-value').textContent = syncLabel($('sync').value);
  $('sync-device').textContent = audioDevice ? `Réglage retenu pour « ${audioDevice} ».` : '';
}

function update(state) {
  config = state.config;
  coverColor = state.coverColor;
  audioDevice = state.audioDevice;
  render();
  renderSync();
}

// ---------- Réglages ----------

document.querySelectorAll('#color-mode button').forEach((b) => b.addEventListener('click', () => fxPanel.set({ fxColorMode: b.dataset.mode })));
$('custom-color').addEventListener('input', (e) => fxPanel.set({ fxColorMode: 'custom', fxCustomColor: e.target.value }));

for (const row of document.querySelectorAll('.effect')) {
  const [onKey, levelKey] = EFFECT_KEYS[row.dataset.effect];
  row.addEventListener('pointerenter', () => { focusedEffect = row.dataset.effect; });
  row.addEventListener('focusin', () => { focusedEffect = row.dataset.effect; });
  row.addEventListener('focusout', () => { if (focusedEffect === row.dataset.effect) focusedEffect = null; });
  row.addEventListener('pointerleave', () => { if (focusedEffect === row.dataset.effect) focusedEffect = null; });
  row.querySelector('input[type="checkbox"]').addEventListener('change', (e) => fxPanel.set({ [onKey]: e.target.checked }));
  const range = row.querySelector('input[type="range"]');
  range.addEventListener('input', () => {
    range.style.setProperty('--pct', `${(range.value / range.max) * 100}%`);
    row.querySelector('output').textContent = `${range.value} %`;
    fxPanel.set({ [levelKey]: range.value / 100 });
  });
}

$('sync').addEventListener('input', () => {
  $('sync').style.setProperty('--pct', `${(($('sync').value - $('sync').min) / ($('sync').max - $('sync').min)) * 100}%`);
  $('sync-value').textContent = syncLabel($('sync').value);
  fxPanel.set({ fxSyncMs: Number($('sync').value) });
});

$('reset').addEventListener('click', () => fxPanel.set(DEFAULTS));
$('done').addEventListener('click', () => fxPanel.close());
$('close').addEventListener('click', () => fxPanel.close());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') fxPanel.close();
});

// ---------- Aperçus animés ----------
// Un morceau imaginaire de 8 s, comme une pop : coups graves sur les temps 1 et 3, aigus sur 2 et 4
// (plus serrés les 2 premières secondes), une mélodie qui monte puis descend (notes à droite puis à
// gauche), et une basse lourde seulement sur un passage (comme dans un vrai morceau, où elle ne
// s'allume que quand la basse ressort) ; l'énergie et la brillance évoluent lentement.

const noteEnvelope = (since) => Math.min(1, since / 0.08) * Math.exp(-since / 0.8);

function demo(t) {
  const cycle = t % 8;
  const fast = cycle < 2; // passage dense : 4 coups/s, la pulsation se réduit au contour
  const since = cycle % (fast ? 0.25 : 0.5);
  const rhythmic = cycle < 4.5;
  return {
    // crans de force comme dans le lecteur : coup ordinaire 80 %, accent (début de mesure) plein
    pulse: rhythmic && cycle % (fast ? 0.5 : 1) < (fast ? 0.25 : 0.5)
      ? (cycle % 2 < 0.25 ? 1 : 0.8) * Math.min(1, since / 0.03) * Math.exp(-since / 0.22) : 0,
    // motif signature (comme un clap sur les temps 2 et 4) : la pochette s'éclaire
    pulseHigh: rhythmic && cycle % (fast ? 0.5 : 1) >= (fast ? 0.25 : 0.5) ? 0.8 * Math.min(1, since / 0.02) * Math.exp(-since / 0.14) : 0,
    // mélodie de fond : un riff de 4 notes par mesure, de l'aigu au grave
    melody: cycle >= 2 && cycle < 7 ? Math.min(1, ((cycle - 2) % 0.5) / 0.04) * Math.exp(-((cycle - 2) % 0.5) / 0.3) : 0,
    melodyTone: cycle >= 2 ? 1 - (Math.floor((cycle - 2) / 0.5) % 4) / 3 : 0.5,
    pressure: smoothstep(4.6, 5.2, cycle) * (1 - smoothstep(7.4, 8, cycle)) * (0.75 + 0.25 * Math.sin(t * 2 * Math.PI * 1.2)),
    // flashs par seconde comptés comme dans le lecteur (un coup aigu compte pour FX_HIGH_FLASH)
    pulseRate: (fast ? 2 : rhythmic ? 1 : 0) * (1 + FX_HIGH_FLASH),
    glow: 0.5 + 0.25 * Math.sin(t * 0.9),
    // passage aigu : le haut du lecteur s'éclaire pendant la phrase la plus haute
    lift: 0.9 * smoothstep(1, 1.6, cycle) * (1 - smoothstep(2.6, 3.2, cycle)),
    // passage rêveur (sans rythme, la voix porte) : le halo d'ambiance respire dans les tons chauds
    dreamy: 0.8 * smoothstep(4.6, 5.4, cycle) * (1 - smoothstep(7.2, 8, cycle)),
    // une note toutes les 0,75 s, qui s'éteint en ~0,8 s : à droite en montant, à gauche en descendant
    noteLeft: cycle >= 3 && cycle < 6 ? noteEnvelope((cycle - 3) % 0.75) : 0,
    noteRight: cycle < 3 ? noteEnvelope(cycle % 0.75) : 0,
    // la voix chante (halo de droite doucement allumé) pendant les notes, puis se tait
    voicePresence: smoothstep(0, 0.3, cycle) * (1 - smoothstep(5.6, 6.2, cycle)),
    brightness: 0.5 + 0.5 * Math.sin(t * 0.6),
  };
}

// N'animer que le thème choisi et celui qu'on survole (les autres montrent une image fixe) ;
// quand on règle un effet, l'aperçu ne montre que lui.
const STILL = { pulse: 0.5, pulseHigh: 0, voicePresence: 0.6, dreamy: 0, lift: 0, melody: 0.5, melodyTone: 0.6, pulseRate: 1.3, pressure: 0.6, glow: 0.5, noteLeft: 0.5, noteRight: 0, brightness: 0.5 };

// Mouvements réduits : comme dans le lecteur, les pulsations deviennent des fondus (voir createAmbiance)
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const faded = {}, voiceSweeps = {};
let lastFrame = 0;

function animate(ms) {
  requestAnimationFrame(animate);
  if (!config) return;
  const t = ms / 1000;
  const dt = Math.min(0.1, t - lastFrame || FX_STEP);
  lastFrame = t;
  const shown = focusedEffect ? { ...config, pulse: false, pressure: false, halo: false, notes: false, [focusedEffect]: config[focusedEffect] } : config;
  for (const [name, el] of Object.entries(previews)) {
    const live = name === config.theme || name === hovered;
    const v = fxDose(live ? demo(t) : STILL, shown);
    if (reducedMotion.matches) {
      const f = (faded[name] ??= { pulse: 0, pulseHigh: 0 });
      v.pulse = f.pulse = follow(f.pulse, v.pulse, dt, 0.06, 0.2);
      v.percHit = f.pulseHigh = follow(f.pulseHigh, v.percHit, dt, 0.06, 0.15);
      v.melody = f.melody = follow(f.melody || 0, v.melody, dt, 0.06, 0.2);
    }
    fxVoiceSweep((voiceSweeps[name] ??= { pos: 1, target: 1 }), v, dt, reducedMotion.matches);
    v.warm = fxWarmFrom(coverColor);
    v.coverColor = coverColor || FX_FALLBACK_COLOR;
    applyFx(el, name, fxBaseColor({ ...config, theme: name }, coverColor || FX_FALLBACK_COLOR), v, t);
  }
}

fxPanel.onUpdate(update);
fxPanel.load().then(update);
requestAnimationFrame(animate);
