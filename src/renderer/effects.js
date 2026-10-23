// Effets d'ambiance : un effet par sensation du morceau, chacun avec un mouvement qui lui ressemble.
//  - pulsation : coups de basse (kick)        → le cadre s'illumine, retombe en ~250 ms
//  - pression  : basse longue et lourde (808)  → une lumière monte du bas, suit l'ondulation ;
//                elle ne prend le relais que quand les coups de basse se sont tus
//  - halo      : énergie et brillance du passage → teinte d'ambiance qui évolue sur plusieurs secondes

const FX_INTENSITY = { low: 0.6, normal: 1, high: 1.6 };
const FX_FALLBACK_COLOR = [150, 180, 255]; // bleu nuit éclairci de la pochette par défaut
const FX_STEP = 1 / 60;                    // pas d'analyse fixe, quelle que soit la fréquence de l'écran
const dbToAmp = (db) => 10 ** (db / 20);
// Planchers absolus : sous ces niveaux, une respiration ou une plosive dans un morceau calme
// ne doit rien déclencher, et un break doit rester sombre au lieu d'être renormalisé.
const FX_SILENCE = dbToAmp(-60);
const FX_SUB_FLOOR = dbToAmp(-55);
const FX_ENERGY_FLOOR = dbToAmp(-75);

// Bandes de fréquences analysées (Hz). La bande « sub » s'arrête à 90 Hz : au-delà,
// les notes graves d'un piano ou d'une voix passeraient pour une basse lourde.
// « body » sert à l'énergie perçue : sans le grave, qui sinon écraserait tout.
const FX_BANDS = { kick: [40, 150], sub: [30, 90], mid: [250, 2000], high: [1500, 6000], body: [150, 6000] };

// Plages de bins de chaque bande, pour une analyse donnée
function bandBins(sampleRate, fftSize) {
  const bin = (hz) => Math.max(1, Math.round((hz / sampleRate) * fftSize));
  return Object.entries(FX_BANDS).map(([name, [from, to]]) => [name, bin(from), bin(to)]);
}

// Niveau moyen (amplitude) de chaque bande, multiplié par `gain`
function readBands(analyser, spectrum, bins, gain = 1) {
  analyser.getFloatFrequencyData(spectrum);
  const levels = {};
  for (const [name, from, to] of bins) {
    let sum = 0;
    for (let i = from; i <= to; i++) sum += 10 ** (spectrum[i] / 20); // dB → amplitude
    levels[name] = (sum / (to - from + 1)) * gain;
  }
  return levels;
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Rapproche `value` de `target` avec un temps de réponse `tau` (s), différent à la montée et à la descente.
const follow = (value, target, dt, up, down) =>
  value + (target - value) * (1 - Math.exp(-dt / (target > value ? up : down)));

// Détecteur d'attaques : une attaque, c'est une montée brusque du niveau, nettement plus forte
// que les variations habituelles du morceau. Une note tenue, elle, ne déclenche rien.
// Renvoie la montée relative (0 si pas d'attaque) : un accent compte plus qu'une note fantôme.
function onsetDetector(minGap) {
  return { prev: 0, rise: 0, peak: FX_SILENCE, lastHit: -Infinity, minGap };
}

function detectOnset(d, value, now, dt) {
  const rise = Math.max(0, value - d.prev) / d.peak; // montée depuis l'image précédente, relative au niveau du morceau
  const usual = d.rise;
  d.prev = value;
  d.peak = Math.max(value, d.peak * Math.exp(-dt / 4), FX_SILENCE);
  d.rise += (1 - Math.exp(-dt / 1)) * (rise - d.rise); // moyenne glissante sur ~1 s
  if (value < FX_SILENCE || now - d.lastHit < d.minGap) return 0;
  if (rise < 0.18 || rise < usual * 3) return 0; // plus bas, les entrées de notes d'un orchestre passeraient pour des kicks
  d.lastHit = now;
  return rise;
}

// Analyse du ressenti, indépendante de l'affichage : reçoit les niveaux des bandes à chaque image
// (ou null en pause) et renvoie la force de chaque effet, entre 0 et 1.
// Avec un profil du morceau (voir analyseTrack), les références sont celles du morceau entier ;
// sans, elles se construisent pendant l'écoute.
function createFeel() {
  let s;
  let profile = null;

  function reset(nextProfile = null) {
    profile = nextProfile;
    s = {
      kick: onsetDetector(0.25), // 4 flashs par seconde au plus
      subHistory: [],   // niveaux « sub » des 400 dernières ms
      subRef: profile ? profile.subRef : FX_SUB_FLOOR,
      dominance: 0,
      held: 0,
      calm: 0,          // 1 quand aucun coup de basse ne s'est fait entendre depuis ~1 s
      pressureShare: 0, // part du temps récent où la pression est active
      energy: 0,
      energyRef: profile ? profile.energyRef : FX_ENERGY_FLOOR,
      brightness: 0.5,
      kickEnv: 0,       // enveloppe du dernier coup de basse
      pulse: 0,
      pressure: 0,
      glow: 0,
    };
  }

  // Le profil arrive en cours de lecture : on garde l'état, seules les références changent.
  function setProfile(next) {
    profile = next;
    s.subRef = next.subRef;
    s.energyRef = next.energyRef;
  }

  function update(levels, now, dt) {
    let hit = 0, pressure = 0, energy = 0, floor = 0, steadyPressure = 0;

    if (levels) {
      hit = detectOnset(s.kick, levels.kick, now, dt);

      // Basse tenue : la basse reste-t-elle présente sur les 400 dernières ms ?
      // Un kick retombe entre deux coups (~30 % du temps), une 808 ou un wobble beaucoup moins.
      const hist = s.subHistory;
      hist.push([now, levels.sub]);
      while (hist[0][0] < now - 0.4) hist.shift();
      const values = hist.map(([, v]) => v).sort((a, b) => a - b);
      const max = values[values.length - 1];
      const duty = values.filter((v) => v > max * 0.35).length / values.length;
      // Le « plancher » de la basse : ce qui reste entre les kicks, la basse qui porte le morceau.
      floor = values[Math.floor(values.length * 0.3)];
      if (!profile) s.subRef = Math.max(floor, s.subRef * Math.exp(-dt / 20), FX_SUB_FLOOR); // la basse la plus lourde du morceau
      const full = now - hist[0][0] > 0.3; // au début d'un morceau, la fenêtre n'est pas encore remplie
      s.held = follow(s.held, full && max > FX_SUB_FLOOR ? smoothstep(0.4, 0.75, duty) : 0, dt, 0.25, 0.5);

      // Lourde : la basse domine nettement les médiums (cordes, voix, guitares).
      s.dominance = follow(s.dominance, levels.sub / (levels.mid + 1e-9), dt, 0.3, 0.3);
      const heavy = smoothstep(1.5, 4, s.dominance);

      // Pendant un passage rythmé, ce sont les pulsations qui portent la basse : la pression ne
      // prend le relais qu'après ~1 s sans coup de basse, et s'efface aussitôt qu'un coup revient.
      s.calm = follow(s.calm, smoothstep(0.5, 1.1, now - s.kick.lastHit), dt, 0.3, 0.05);
      steadyPressure = s.held * heavy * Math.min(1, floor / s.subRef) * s.calm;
      // Une pression présente en permanence ne dit plus rien : on l'atténue pour garder le contraste.
      s.pressureShare = follow(s.pressureShare, steadyPressure > 0.3 ? 1 : 0, dt, 30, 30);
      pressure = steadyPressure * (profile ? profile.pressureGain : 1 - 0.5 * smoothstep(0.6, 0.9, s.pressureShare));

      // Énergie du passage : niveau perçu sur ~1,5 s, sur 10 dB sous le passage le plus fort du morceau
      // (un couplet et un refrain diffèrent de 3 à 6 dB). La référence redescend en ~30 s :
      // un break reste sombre, un drop ressort. Le niveau absolu compte aussi : un morceau
      // calme d'un bout à l'autre ne doit pas briller autant qu'un morceau puissant.
      s.energy = follow(s.energy, levels.body, dt, 1.5, 1.5);
      if (!profile) s.energyRef = Math.max(s.energy, s.energyRef * Math.exp(-dt / 30), FX_ENERGY_FLOOR);
      const relative = smoothstep(-10, 0, 20 * Math.log10(s.energy / s.energyRef));
      const absolute = smoothstep(-72, -50, 20 * Math.log10(s.energy + 1e-12));
      energy = relative * (0.3 + 0.7 * absolute);

      // Brillance : part des aigus face aux médiums (son sombre et chaud ou clair et tranchant).
      const tilt = 20 * Math.log10((levels.high + 1e-9) / (levels.mid + 1e-9));
      s.brightness = follow(s.brightness, smoothstep(-26, -8, tilt), dt, 1, 1);
    }

    // Pulsation proportionnelle à la force de l'attaque (compressée) ; elle monte en ~30 ms
    // au lieu d'apparaître d'un coup, et retombe en ~250 ms.
    s.kickEnv = hit ? Math.max(s.kickEnv, 0.55 + 0.45 * smoothstep(0.18, 0.7, hit)) : s.kickEnv * Math.exp(-dt / 0.22);
    s.pulse = follow(s.pulse, s.kickEnv, dt, 0.03, 0.01);
    s.pressure = follow(s.pressure, pressure, dt, 0.06, 0.12);
    s.glow = follow(s.glow, energy, dt, 0.3, 0.6);
    return {
      pulse: s.pulse, pressure: s.pressure, glow: s.glow, brightness: s.brightness,
      // mesures brutes, pour établir le profil d'un morceau
      energy: s.energy, subFloor: floor, steadyPressure,
    };
  }

  reset();
  return { reset, setProfile, update };
}

// ---------- Pré-analyse du morceau entier ----------
// Le fichier est local : on l'analyse en ~1 s au chargement. Les références du morceau
// (passage le plus fort, basse la plus lourde, part de basses tenues) sont alors justes dès
// la première seconde, au lieu de se construire pendant l'écoute : une intro calme reste
// calme, et le premier drop n'est pas exagéré.

const FX_PROFILE_RATE = 22050;  // suffisant jusqu'à 11 kHz, et deux fois moins de mémoire
const FX_PROFILE_STEP = 0.05;   // 20 mesures par seconde suffisent pour des références
const FX_PROFILE_MAX = 15 * 60; // au-delà (mix d'une heure…), on reste en mode adaptatif

async function analyseTrack(data) {
  const decoded = await new OfflineAudioContext(1, 1, FX_PROFILE_RATE).decodeAudioData(data);
  const ctx = new OfflineAudioContext(1, decoded.length, FX_PROFILE_RATE);
  const source = ctx.createBufferSource();
  source.buffer = decoded;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;                // même résolution qu'en direct (~21 Hz par bin)
  analyser.smoothingTimeConstant = 0.125; // le lissage 0,5 du direct à 60 mesures/s, ramené à 20 mesures/s
  source.connect(analyser);
  analyser.connect(ctx.destination);

  const spectrum = new Float32Array(analyser.frequencyBinCount);
  const bins = bandBins(FX_PROFILE_RATE, analyser.fftSize);
  const quantum = 128 / FX_PROFILE_RATE; // le rendu ne s'interrompt qu'entre deux blocs de 128 échantillons
  const frames = [];
  for (let t = FX_PROFILE_STEP; t < decoded.duration - quantum; t += FX_PROFILE_STEP) {
    ctx.suspend(Math.floor(t / quantum) * quantum).then(() => {
      frames.push(readBands(analyser, spectrum, bins));
      ctx.resume();
    });
  }
  source.start();
  await ctx.startRendering();
  return trackProfile(frames, FX_PROFILE_STEP);
}

function trackProfile(frames, dt) {
  if (frames.length < 40) return null; // moins de 2 s : rien de fiable
  const percentile = (values, p) => values.slice().sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];
  const run = (feel, each) => frames.forEach((levels, i) => each(feel.update(levels, i * dt, dt)));

  // 1re passe : énergie et plancher de basse tout au long du morceau
  const energies = [], floors = [];
  run(createFeel(), (o) => { energies.push(o.energy); floors.push(o.subFloor); });
  const profile = {
    energyRef: Math.max(percentile(energies, 0.95), FX_ENERGY_FLOOR), // le passage fort, sans les pics isolés
    subRef: Math.max(percentile(floors, 0.95), FX_SUB_FLOOR),
    pressureGain: 1,
  };

  // 2e passe avec ces références : quelle part du morceau porte une basse lourde ?
  const feel = createFeel();
  feel.reset(profile);
  let active = 0;
  run(feel, (o) => { if (o.steadyPressure > 0.3) active++; });
  profile.pressureGain = 1 - 0.5 * smoothstep(0.5, 0.85, active / frames.length);
  return profile;
}

// `readFile(chemin)` renvoie le contenu du MP3 (ou null) pour la pré-analyse.
// `sound` : la chaîne audio partagée (sound.js), dont on analyse la sortie.
function createAmbiance(audio, bar, readFile, sound) {
  let config = { pulse: false, pressure: false, halo: false, intensity: 'normal' };
  let ctx = null;
  let analyser = null;
  let spectrum = null;
  let bands = null;
  let frame = 0;
  let last = 0;
  const feel = createFeel();
  let fx = { pulse: 0, pressure: 0, glow: 0, brightness: 0.5 };
  let color = FX_FALLBACK_COLOR;
  let track = null;            // chemin du morceau en cours
  const profiles = new Map();  // chemin → profil (null : analyse impossible), pour ne pas réanalyser
  let analysing = false;

  const enabled = () => config.pulse || config.pressure || config.halo;

  // Le son passe par Web Audio uniquement une fois les effets utilisés (voir sound.js).
  function ensureGraph() {
    if (ctx) return;
    ctx = sound.context();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.5;
    sound.output().connect(analyser);
    spectrum = new Float32Array(analyser.frequencyBinCount);
    bands = bandBins(ctx.sampleRate, analyser.fftSize);
  }

  // Le volume du lecteur s'applique avant l'analyse : on le compense pour que les effets
  // décrivent le morceau, pas la position du curseur de volume.
  const readLevels = () => readBands(analyser, spectrum, bands, 1 / Math.max(0.05, audio.volume));

  // Un seul morceau analysé à la fois : si on enchaîne les morceaux, seul le dernier compte.
  async function requestProfile() {
    const path = track;
    if (!path || !enabled() || analysing || profiles.has(path)) return;
    if (!(audio.duration > 0)) {
      audio.addEventListener('loadedmetadata', requestProfile, { once: true });
      return;
    }
    if (audio.duration > FX_PROFILE_MAX) return profiles.set(path, null);
    analysing = true;
    let profile = null;
    try {
      const data = await readFile(path);
      if (data) profile = await analyseTrack(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    } catch (err) {
      console.warn('Pré-analyse impossible :', err);
    }
    analysing = false;
    profiles.set(path, profile);
    if (path === track && profile) feel.setProfile(profile);
    requestProfile(); // le morceau a peut-être changé entre-temps
  }

  function tick(t) {
    frame = requestAnimationFrame(tick);
    const now = t / 1000;
    if (last && now - last < FX_STEP * 0.9) return; // écran à 120/144 Hz : on garde 60 analyses par seconde
    const dt = Math.min(0.1, now - last || FX_STEP);
    last = now;
    fx = feel.update(audio.paused ? null : readLevels(), now, dt);
    render();
    if (audio.paused && fx.pulse < 0.005 && fx.pressure < 0.005 && fx.glow < 0.005) stop();
  }

  // Les effets couvrent tout le lecteur : style.css lit ces valeurs sur #bar.
  // Une seule couche domine à la fois : le flash d'un kick estompe la pression,
  // et la pression estompe le halo, pour que la barre ne devienne pas une tache.
  function render() {
    const m = FX_INTENSITY[config.intensity] || 1;
    const pulse = config.pulse ? fx.pulse * m : 0;
    const pressure = config.pressure ? Math.min(1, fx.pressure * m) * (1 - 0.5 * Math.min(1, pulse)) : 0;
    const glow = config.halo ? Math.min(1, fx.glow * m) * (1 - 0.4 * pressure) : 0;
    bar.style.setProperty('--fx-pulse', pulse.toFixed(3));
    bar.style.setProperty('--fx-pressure', pressure.toFixed(3));
    bar.style.setProperty('--fx-glow', glow.toFixed(3));
    // Teinte du halo : plus claire quand le son est brillant, plus profonde quand il est sombre.
    const b = fx.brightness;
    const halo = color.map((c) => Math.round(c * (0.7 + 0.3 * b) + (255 - c) * 0.35 * b));
    bar.style.setProperty('--fx-halo-color', halo.join(' '));
  }

  function start() {
    if (frame || !enabled() || audio.paused) return;
    ensureGraph();
    if (ctx.state === 'suspended') ctx.resume();
    last = 0;
    frame = requestAnimationFrame(tick);
  }

  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    fx = { pulse: 0, pressure: 0, glow: 0, brightness: 0.5 };
    render();
  }

  audio.addEventListener('play', () => {
    if (ctx && ctx.state === 'suspended') ctx.resume();
    start();
  });
  return {
    setConfig(next) {
      config = { ...config, ...next };
      if (enabled()) {
        start();
        requestProfile();
      } else {
        stop();
      }
    },

    // Nouveau morceau : ses références si on les connaît déjà, sinon on repart de zéro
    // en attendant la pré-analyse.
    setTrack(path) {
      track = path;
      feel.reset(profiles.get(path) || null);
      requestProfile();
    },

    // Couleur des effets : teinte dominante de la pochette, ou celle par défaut.
    setColor(img) {
      color = img ? dominantColor(img) : FX_FALLBACK_COLOR;
      bar.style.setProperty('--fx-color', color.join(' '));
      render();
    },
  };
}

// Moyenne des pixels pondérée par la saturation, puis éclaircie : un halo doit rester lumineux.
function dominantColor(img) {
  const size = 16;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, size, size);
  const data = g.getImageData(0, 0, size, size).data;
  let r = 0, gr = 0, b = 0, total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const max = Math.max(data[i], data[i + 1], data[i + 2]);
    const min = Math.min(data[i], data[i + 1], data[i + 2]);
    const w = 0.02 + ((max - min) / 255) ** 2 * (max / 255);
    r += data[i] * w;
    gr += data[i + 1] * w;
    b += data[i + 2] * w;
    total += w;
  }
  const rgb = [r / total, gr / total, b / total];
  const k = 255 / Math.max(1, ...rgb);
  return rgb.map((c) => Math.round(c * k * 0.8 + 255 * 0.2));
}
