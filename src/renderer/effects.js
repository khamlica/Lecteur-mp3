// Effets d'ambiance : un élément de la musique, une place dans le lecteur.
//  - basse (kick, 808)            → la pochette « saute » et s'entoure d'une lueur, retombe en ~250 ms
//  - percussions (caisse claire…) → la pochette s'éclaire, comme rétroéclairée, plus brièvement
//  - basse longue et lourde       → tout le contour du lecteur s'illumine, au rythme de son ondulation
//  - énergie et brillance         → teinte d'ambiance qui évolue sur plusieurs secondes
//  - voix (mélodie chantée)       → un large halo doux entre par la droite à chaque note (la gauche
//                                   est réservée au rythme)
// Chaque effet a sa place (pochette, contour, côtés, fond) : ils coexistent sans s'atténuer.

const FX_FALLBACK_COLOR = [150, 180, 255]; // bleu nuit éclairci de la pochette par défaut
const FX_STEP = 1 / 60;                    // pas d'analyse fixe, quelle que soit la fréquence de l'écran
const dbToAmp = (db) => 10 ** (db / 20);
// Planchers absolus : sous ces niveaux, une respiration ou une plosive dans un morceau calme
// ne doit rien déclencher, et un break doit rester sombre au lieu d'être renormalisé.
const FX_SILENCE = dbToAmp(-60);
const FX_SUB_FLOOR = dbToAmp(-55);
const FX_ENERGY_FLOOR = dbToAmp(-75);
const FX_FLUX_FLOOR = dbToAmp(-95);
// Sensibilité aux coups de basse : montée minimale et contraste avec les variations habituelles.
const FX_KICK_RISE = 0.18, FX_KICK_CONTRAST = 3;
// Écart minimal entre deux pulsations, et entre deux notes, appliqué APRÈS le classement :
// une note grave ne bloque plus le kick qui la suit.
const FX_PULSE_GAP = 0.1, FX_NOTE_GAP = 0.1;
const FX_PERC_SHARE = 0.6;       // part frappée minimale d'une percussion « générique » (voir update)
const FX_BROAD_KICK = 0.5;      // part de la bande grave qui monte d'un coup sur un vrai kick (spreadKick)
// Sécurité (photosensibilité) : ce qui compte, ce sont les flashs sur une grande surface. Le coup grave
// illumine tout le cadre ; le coup aigu, un liseré et la petite pochette : il compte pour 0,3 flash.
const FX_HIGH_FLASH = 0.3;
// Une attaque n'a de hauteur que si sa série harmonique monte nettement plus que le reste du spectre.
const FX_HARMONIC_MIN = 1.2;

// Classement d'une attaque : trois règles indépendantes (une attaque peut être à la fois un kick et
// une note, un kick sur un accord). Chacune est une combinaison linéaire des indicateurs de
// createFrameReader, apprise sur les images mêmes que classe le lecteur (déclenchement + image
// suivante) : vrais enregistrements annotés (MDB-Drums), attaques de Vague Hope (notes) et morceaux
// composés ; vérifiée sur d'autres jamais utilisés pour l'apprentissage (5 morceaux MDB, Ashitaka,
// 2 morceaux composés). Seuils relevés pour privilégier la précision (une fausse note sur un coup de
// batterie se voit plus qu'une note manquée, mais une mélodie absente aussi). Taux mesurés sur ces
// images (apprentissage / vérification) :
//   kick  : 78 / 70 % des kicks ; 8 / 3 % des notes, 17 / 9 % des caisses claires ;
//   caisse: 65 / 26 % des caisses claires ; 26 / 8 % des charlestons, 6 / 0 % des notes ;
//   note  : 73 / 96 % des notes ; 3 / 8 % des kicks, 14 / 26 % des caisses, 18 / 32 % des charlestons.
// La hauteur (`harmonicity`, `pitchSemi`) aide peu à ce stade : l'attaque vient de commencer.
const FX_RULES = {
  kick: { bias: -2.02, bassy: 11.17, airy: -1.92, concentration: -2.89, lowmid: -6.46, spread: 1.92, spreadLow: 0.35, spreadHigh: 1.76, spreadKick: 0.57, harmonicity: 1.66 },
  snare: { bias: 3.19, bassy: 3.16, airy: -5.76, concentration: -5.35, lowmid: -1.24, spread: -0.23, spreadLow: 6.13, spreadHigh: 0.46, spreadKick: 0.77, harmonicity: -0.48 },
  note: { bias: -2.05, bassy: -5.08, airy: 0.30, concentration: 3.74, lowmid: 4.41, spread: 0.25, spreadLow: -3.82, spreadHigh: -2.05, spreadKick: -1.74, harmonicity: -0.65 },
};
// Règles de la pré-analyse, qui dispose en plus des indicateurs de la séparation harmonique/percussive
// (voir hpssFeatures) : mêmes trois décisions, apprises sur 18 morceaux (MDB-Drums, Vague Hope,
// Ashitaka, morceaux composés), régularisation choisie en classant chaque morceau par un modèle qui ne
// l'a jamais vu. Seuils : 10 % de fausses détections pour les coups, 15 % pour les notes. Par rapport
// aux règles du direct, sur ce même chemin : caisses claires 27 → 36 % (MDB jamais vus), notes 34 → 42 %,
// coups fantômes 11 → 24 %, fausses pulsations 62 → 29 (morceaux composés) ; Vague Hope 0,17 pulsation/s.
let FX_RULES_FULL = {
  kick: { bias: -0.656, bassy: 9.238, airy: -5.177, concentration: -5.341, lowmid: -6.305, spread: -1.106, spreadLow: -0.157, spreadHigh: -2.115, spreadKick: 0.686, harmonicity: 0.503, perc: 0.590, percLow: 13.295, percMid: 2.016, percHigh: 11.696, harmLow: 11.273, harmMid: 1.170, sustainH: -8.840, sustainP: -6.169, logPerc: 0.792, logHarm: 2.698 },
  snare: { bias: 5.135, bassy: 5.966, airy: -2.573, concentration: -9.211, lowmid: 2.122, spread: -5.782, spreadLow: 7.249, spreadHigh: -0.254, spreadKick: 0.516, harmonicity: 0.036, perc: -11.041, percLow: 6.259, percMid: 2.518, percHigh: 12.055, harmLow: -51.035, harmMid: -21.222, sustainH: -15.290, sustainP: 1.361, logPerc: 1.359, logHarm: 3.266 },
  note: { bias: -19.063, bassy: -6.218, airy: 0.200, concentration: 7.526, lowmid: 3.194, spread: 4.171, spreadLow: -5.675, spreadHigh: 1.520, spreadKick: -1.049, harmonicity: -0.218, perc: 48.808, percLow: -4.844, percMid: 0.413, percHigh: -16.972, harmLow: -20.460, harmMid: -4.485, sustainH: 19.809, sustainP: 3.044, logPerc: -12.545, logHarm: 5.485 },
};
const FX_FEATURES = ['bassy', 'airy', 'concentration', 'lowmid', 'spread', 'spreadLow', 'spreadHigh', 'spreadKick', 'harmonicity'];
const fxRule = (rule, value) => Object.keys(rule).reduce((sum, key) => (key === 'bias' ? sum : sum + rule[key] * value(key)), rule.bias);
// Sensibilité aux notes : plus fine que pour les kicks, pour saisir une mélodie sous la batterie
// sans faire scintiller un orchestre (≈ 0,6 note/s en pop, 3 en piano solo, 5 en orchestre).
const FX_NOTE_RISE = 0.12, FX_NOTE_CONTRAST = 2;

// Bandes de fréquences analysées (Hz). La bande « sub » s'arrête à 90 Hz : au-delà,
// les notes graves d'un piano ou d'une voix passeraient pour une basse lourde.
// « body » sert à l'énergie perçue : sans le grave, qui sinon écraserait tout.
const FX_BANDS = { kick: [40, 150], sub: [30, 90], mid: [250, 2000], high: [1500, 6000], body: [150, 6000] };

// Lecture d'une image du spectre : niveau moyen (amplitude) de chaque bande, et la montée
// d'énergie depuis l'image précédente (flux), pour distinguer une percussion d'une note :
//  - une percussion fait monter tout le spectre d'un coup, aigus compris (claquement, bruit) ;
//  - une note ne fait monter que quelques harmoniques.
// `concentration` : part de la montée portée par les 6 % de bins qui montent le plus ;
// `airy` : part de la montée au-dessus de 4 kHz ;
// `bassy` : part de la montée sous 150 Hz (une 808, accordée comme une note, y met presque tout) ;
// `pitch` : hauteur moyenne de la montée entre 150 Hz et 4 kHz, en octaves au-dessus de 150 Hz ;
// `lowmid` : part de la montée entre 150 Hz et 1 kHz (corps d'une caisse claire ; un charleston n'en a pas) ;
// `spread`, `spreadLow`, `spreadHigh`, `spreadKick` : part des bins qui montent nettement (plus de 6 dB)
// sur 150 Hz-8 kHz, 150 Hz-1 kHz, 4-8 kHz et 40-150 Hz — une frappe éclaire beaucoup de bins à la fois ;
// `pitchSemi` : hauteur de la note qui commence (demi-tons MIDI), 0 si rien de net — la fondamentale
// entre 110 Hz et 2 kHz dont les 8 premiers harmoniques montent le plus (en dB, lus par interpolation
// à leur fréquence exacte : un bin fait ~21 Hz, plus d'un demi-ton sous 400 Hz) ;
// `harmonicity` : combien ces harmoniques montent plus que l'ensemble du spectre (1 : pas plus,
// comme une frappe qui monte partout ; une note monte sur sa série harmonique, bien au-delà de 1).
function createFrameReader(analyser, sampleRate) {
  const spectrum = new Float32Array(analyser.frequencyBinCount);
  const bin = (hz) => Math.max(1, Math.round((hz / sampleRate) * analyser.fftSize));
  const bands = Object.entries(FX_BANDS).map(([name, [from, to]]) => [name, bin(from), bin(to)]);
  const [bassFrom, fluxFrom, fluxTo, airFrom, lowTo] = [bin(40), bin(150), bin(8000), bin(4000), bin(1000)];
  const audible = dbToAmp(-90);
  const riseDb = new Float32Array(analyser.frequencyBinCount);
  const pitchTop = Math.min(riseDb.length - 1, bin(5000)); // harmoniques utiles à la hauteur : sous 5 kHz
  // Fondamentales candidates, au tiers de demi-ton, et les bins de leurs harmoniques
  const candidates = [];
  for (let semi = 45; semi <= 95; semi += 0.25) {
    const f0 = 440 * 2 ** ((semi - 69) / 12);
    const harmonics = [1, 2, 3, 4, 5, 6, 7, 8].map((h) => [(h * f0 / sampleRate) * analyser.fftSize, 1 / Math.sqrt(h)])
      .filter(([b]) => b < pitchTop);
    candidates.push([semi, harmonics]);
  }
  const octaves = Float32Array.from({ length: airFrom }, (_, i) => Math.log2(Math.max(i, fluxFrom) / fluxFrom));
  const amp = new Float32Array(analyser.frequencyBinCount);
  const prev = new Float32Array(analyser.frequencyBinCount);
  const rises = new Float32Array(fluxTo - fluxFrom + 1);
  const top = Math.max(4, Math.round(rises.length * 0.06));

  return (gain = 1) => {
    analyser.getFloatFrequencyData(spectrum);
    for (let i = 0; i < spectrum.length; i++) amp[i] = 10 ** (spectrum[i] / 20) * gain; // dB → amplitude
    const levels = {};
    for (const [name, from, to] of bands) {
      let sum = 0;
      for (let i = from; i <= to; i++) sum += amp[i];
      levels[name] = sum / (to - from + 1);
    }
    let flux = 0, air = 0, bass = 0, pitched = 0, low = 0;
    let jumps = 0, jumpsLow = 0, jumpsHigh = 0, jumpsKick = 0;
    const jumped = (i) => amp[i] > audible && amp[i] > 2 * prev[i]; // +6 dB d'une image à l'autre
    for (let i = bassFrom; i < fluxFrom; i++) {
      bass += Math.max(0, amp[i] - prev[i]);
      if (jumped(i)) jumpsKick++;
    }
    for (let i = 0; i <= pitchTop; i++) {
      riseDb[i] = amp[i] > audible && amp[i] > prev[i] ? Math.min(30, 20 * Math.log10(amp[i] / prev[i])) : 0;
    }
    let bestScore = 0, bestWeight = 1, pitchSemi = 0, riseSum = 0;
    for (let i = fluxFrom; i < airFrom; i++) riseSum += riseDb[i];
    const riseMean = riseSum / (airFrom - fluxFrom);
    for (const [semi, harmonics] of candidates) {
      let score = 0;
      for (const [b, weight] of harmonics) {
        const i = Math.floor(b), f = b - i;
        score += (riseDb[i] * (1 - f) + riseDb[i + 1] * f) * weight;
      }
      if (score > bestScore) { bestScore = score; pitchSemi = semi; bestWeight = harmonics.reduce((w, [, h]) => w + h, 0); }
    }
    for (let i = fluxFrom; i <= fluxTo; i++) {
      const rise = Math.max(0, amp[i] - prev[i]);
      rises[i - fluxFrom] = rise;
      flux += rise;
      if (i >= airFrom) air += rise;
      else pitched += rise * octaves[i];
      if (i <= lowTo) low += rise;
      if (jumped(i)) {
        jumps++;
        if (i <= lowTo) jumpsLow++;
        if (i >= airFrom) jumpsHigh++;
      }
    }
    prev.set(amp);
    rises.sort();
    let strongest = 0;
    for (let i = rises.length - top; i < rises.length; i++) strongest += rises[i];
    levels.flux = flux / rises.length;
    levels.concentration = flux > 0 ? strongest / flux : 0;
    levels.airy = flux > 0 ? air / flux : 0;
    levels.bassy = bass + flux > 0 ? bass / (bass + flux) : 0;
    levels.pitch = flux > air ? pitched / (flux - air) : 0;
    levels.lowmid = flux > 0 ? low / flux : 0;
    levels.pitchSemi = bestScore > 20 ? pitchSemi : 0; // il faut une montée nette (≥ 20 dB pondérés)
    levels.harmonicity = bestScore / bestWeight / (riseMean + 1);
    levels.pitchScore = bestScore;
    levels.spread = jumps / rises.length;
    levels.spreadLow = jumpsLow / (lowTo - fluxFrom + 1);
    levels.spreadHigh = jumpsHigh / (fluxTo - airFrom + 1);
    levels.spreadKick = jumpsKick / (fluxFrom - bassFrom);
    return levels;
  };
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
// `floor` : niveau sous lequel on ne détecte rien (le flux, une différence, est bien plus faible qu'un niveau).
// `minRise` et `contrast` : montée minimale (relative au morceau) et combien de fois la montée habituelle.
function onsetDetector(minGap, { floor = FX_SILENCE, minRise = 0.18, contrast = 3 } = {}) {
  return { prev: 0, rise: 0, peak: floor, lastHit: -Infinity, minGap, floor, minRise, contrast };
}

function detectOnset(d, value, now, dt) {
  const rise = Math.max(0, value - d.prev) / d.peak; // montée depuis l'image précédente, relative au niveau du morceau
  const usual = d.rise;
  d.prev = value;
  d.peak = Math.max(value, d.peak * Math.exp(-dt / 4), d.floor);
  d.rise += (1 - Math.exp(-dt / 1)) * (rise - d.rise); // moyenne glissante sur ~1 s
  if (value < d.floor || now - d.lastHit < d.minGap) return 0;
  if (rise < d.minRise || rise < usual * d.contrast) return 0; // pour les kicks : plus bas, les entrées de notes d'un orchestre passeraient pour des coups
  d.lastHit = now;
  return rise;
}

// Analyse du ressenti, indépendante de l'affichage : reçoit les niveaux des bandes à chaque image
// (ou null en pause) et renvoie la force de chaque effet, entre 0 et 1.
// Avec un profil du morceau (voir analyseTrack), les références sont celles du morceau entier ;
// sans, elles se construisent pendant l'écoute.
// `contour` : false pour ne lire les notes que sur les attaques (karaoké : la voix, que suit le contour
// de la mélodie, est retirée).
function createFeel({ contour: useContour = true } = {}) {
  let s;
  let profile = null;

  function reset(nextProfile = null, energyHint = FX_ENERGY_FLOOR) {
    profile = nextProfile;
    s = {
      kick: onsetDetector(0.06, { minRise: FX_KICK_RISE, contrast: FX_KICK_CONTRAST }),
      tone: onsetDetector(0.06, { floor: FX_FLUX_FLOOR, minRise: FX_NOTE_RISE, contrast: FX_NOTE_CONTRAST }), // attaques sur tout le spectre (notes comprises)
      lastPulse: { kick: -Infinity, snare: -Infinity }, // chaque sorte de coup a son propre écart minimal
      lastNote: -Infinity,
      lastPitch: null,  // hauteur de la note précédente (demi-tons)
      pending: null,    // attaque en attente de classement (percussion ou note), voir update
      subHistory: [],   // niveaux « sub » des 400 dernières ms
      subRef: profile ? profile.subRef : FX_SUB_FLOOR,
      dominance: 0,
      held: 0,
      pressureShare: 0, // part du temps récent où la pression est active
      energy: 0,
      energyRef: profile ? profile.energyRef : energyHint,
      brightness: 0.5,
      kickEnv: 0,       // enveloppe du dernier coup grave
      highEnv: 0,       // enveloppe du dernier coup aigu
      pulseHigh: 0,
      pulseHits: 0,     // coups récents (décroît en ~2 s) : pulsations par seconde ≈ pulseHits / 2 (voir FX_HIGH_FLASH)
      hitRises: { kick: [], snare: [] }, // montées des derniers coups, par sorte : référence des crans de force
      hitHold: { kick: 0, snare: 0 }, // temps restant au sommet avant que la pulsation retombe
      intervals: { kick: [], snare: [] }, // écarts entre les derniers coups de la même sorte
      noteHits: 0,      // idem pour les notes
      noteEnv: [0, 0],  // enveloppe des dernières notes, à gauche et à droite
      note: [0, 0],
      side: 1,          // côté de la dernière note (0 gauche, 1 droite)
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
    let lowHit = 0, highHit = 0, noteHit = 0, pressure = 0, energy = 0, floor = 0, steadyPressure = 0, signatureHit = 0;

    if (levels) {
      const kickRise = detectOnset(s.kick, levels.kick, now, dt);
      const toneRise = detectOnset(s.tone, levels.flux, now, dt);
      // Une attaque se classe sur deux images (16 ms), avec les trois règles de FX_RULES.
      if (s.pending) {
        const p = s.pending;
        const mean = (key) => (p[key] + levels[key]) / 2;
        const rules = p.perc !== undefined ? FX_RULES_FULL : FX_RULES; // pré-analyse ou direct
        // Une attaque est un coup si la règle du kick, celle de la caisse claire ou le critère « nettement
        // frappé » (plus bas) la reconnaît : on préfère un coup de trop à un coup manqué.
        // Kick seul (sans basse ni nappe autour) : la règle de la pré-analyse le prend pour une note tenue ;
        // la règle « en direct » le reconnaît, et un vrai kick monte sur toute la bande grave à la fois
        // (une note grave de piano ou de basse, sur quelques fréquences seulement).
        const strikes = (kind) => {
          if (p.time - s.lastPulse[kind] < FX_PULSE_GAP) return false;
          s.intervals[kind] = [...s.intervals[kind].slice(-2), p.time - s.lastPulse[kind]];
          s.lastPulse[kind] = p.time;
          return true;
        };
        const broadKick = rules === FX_RULES_FULL && fxRule(FX_RULES.kick, mean) > 0 && mean('spreadKick') >= FX_BROAD_KICK;
        if (p.percHit !== undefined) {
          // Pré-analyse du mix : l'attaque a déjà été jugée sur son son et sur le motif rythmique du
          // morceau (voir fxPercussionPattern). Un seul écart minimal pour toutes, comme à l'apprentissage ;
          // sa sorte (pour la force du coup et la limite de flashs) vient de la règle du kick.
          if (p.percHit && p.time - Math.max(s.lastPulse.kick, s.lastPulse.snare) >= FX_PULSE_GAP) {
            if (p.kick && (fxRule(rules.kick, mean) > 0 || broadKick)) { strikes('kick'); lowHit = p.kick; }
            else { strikes('snare'); highHit = p.tone || p.kick; }
            if (p.percSignature) signatureHit = 1; // coup du motif signature (voir fxSignature)
          }
        } else {
          if (p.kick && (fxRule(rules.kick, mean) > 0 || broadKick) && strikes('kick')) lowHit = p.kick;
          if (p.tone && fxRule(rules.snare, mean) > 0 && strikes('snare')) highHit = p.tone;
          // Percussion que les règles, apprises sur des batteries acoustiques, ne reconnaissent pas (clap,
          // rimshot, percussions électroniques de la pop…) : sur un passage rythmé, une attaque nettement
          // frappée et forte pour le morceau compte aussi.
          if (!lowHit && !highHit && p.tone && rules === FX_RULES_FULL && profile?.percRef !== undefined
              && (p.rhythmic ?? profile.rhythmic) && mean('logPerc') >= profile.percRef && mean('perc') >= FX_PERC_SHARE
              && strikes('snare')) highHit = p.tone;
        }
        // Passage rythmé : les notes viennent du contour de la mélodie (plus bas), sauf en direct, où il
        // manque (pré-analyse pas encore finie) : les attaques prennent le relais.
        const contour = fxContourNotes(useContour, profile, p);
        if (!contour && p.time - s.lastNote >= FX_NOTE_GAP && fxRule(rules.note, mean) > 0) {
          noteHit = Math.max(p.kick, p.tone);
          s.lastNote = p.time;
          // Comme sur un clavier : plus aiguë que la note précédente à droite, plus grave à gauche ;
          // la même note reste du même côté.
          // On retient l'image où la série harmonique ressort le mieux, et seulement si elle ressort
          // vraiment (une frappe qui monte partout aurait une « hauteur » sans valeur).
          const best = p.pitchScore >= levels.pitchScore ? p : levels;
          const pitch = best.harmonicity > FX_HARMONIC_MIN ? best.pitchSemi : 0;
          if (pitch > 0 && s.lastPitch !== null && Math.abs(pitch - s.lastPitch) >= 0.5) s.side = pitch > s.lastPitch ? 1 : 0;
          if (pitch > 0) s.lastPitch = pitch;
        }
        s.pending = null;
      }
      // Passage rythmé : les notes de la mélodie, lues sur son contour (pré-analyse, voir melodyContour)
      if (fxContourNotes(useContour, profile, levels) && levels.melodyHit && now - s.lastNote >= FX_NOTE_GAP) {
        noteHit = Math.max(noteHit, levels.melodyHit);
        s.side = levels.melodySide;
        s.lastNote = now;
      }
      if (kickRise || toneRise) {
        s.pending = { ...levels, kick: kickRise, tone: toneRise, time: now };
      }

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

      steadyPressure = s.held * heavy * Math.min(1, floor / s.subRef);
      // Une pression présente en permanence ne dit plus rien : on l'atténue pour garder le contraste.
      s.pressureShare = follow(s.pressureShare, steadyPressure > 0.3 ? 1 : 0, dt, 30, 30);
      pressure = profile?.bassTo !== undefined
        ? smoothstep(profile.bassFrom, profile.bassTo, steadyPressure)
        : steadyPressure * (1 - 0.5 * smoothstep(0.6, 0.9, s.pressureShare));

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
    // Deux pulsations : grave (kick, 808) et aiguë (caisse claire, clap), que la pop fait alterner.
    // Force d'un coup en trois crans, par rapport aux coups récents de la même sorte (leurs montées ne se
    // mesurent pas pareil) : un accent qui ressort donne un flash plein, un coup ordinaire 80 %, un
    // coup léger 60 %. Le coup aigu est plus bref (~150 ms contre ~250 ms).
    // La référence est la médiane des 16 derniers coups : le tout premier coup d'un morceau, qui sort du
    // silence et paraît démesuré, ne fausse pas les suivants (tant qu'il y en a moins de 3 : 80 %).
    const strike = (kind, rise) => {
      const recent = s.hitRises[kind];
      const ref = recent.length >= 3 ? [...recent].sort((a, b) => a - b)[recent.length >> 1] : 0;
      recent.push(rise);
      if (recent.length > 16) recent.shift();
      const ratio = ref ? rise / ref : 1;
      s.hitHold[kind] = 0.04; // tenue au sommet : la pulsation atteint vraiment son cran avant de retomber
      return ratio >= 1.4 ? 1 : ratio >= 0.8 ? 0.8 : 0.6;
    };
    // Coups serrés (au-delà de ~2 par seconde) : la pulsation retombe un peu plus vite pour que chaque
    // coup reste distinct, sans aller jusqu'au noir complet (photosensibilité).
    const fall = (kind, slow, fast) => {
      const gaps = [...s.intervals[kind]].sort((a, b) => a - b);
      return gaps.length ? Math.min(slow, Math.max(fast, 0.45 * gaps[gaps.length >> 1])) : slow;
    };
    // Sur la piste batterie séparée, kick et caisse claire se distinguent : le kick fait sauter la
    // pochette, la caisse claire l'éclaire. Sur le mix complet, pas de façon fiable : tout coup fait les
    // deux — mieux vaut un coup de trop qu'un coup manqué. (Sa force se mesure parmi les coups du même
    // détecteur.)
    if (profile?.stem === 'drums') {
      if (lowHit) s.kickEnv = Math.max(s.kickEnv, strike('kick', lowHit));
      else if (s.hitHold.kick > 0) s.hitHold.kick -= dt;
      else s.kickEnv *= Math.exp(-dt / fall('kick', 0.22, 0.15));
      if (highHit) s.highEnv = Math.max(s.highEnv, strike('snare', highHit));
      else if (s.hitHold.snare > 0) s.hitHold.snare -= dt;
      else s.highEnv *= Math.exp(-dt / fall('snare', 0.14, 0.1));
    } else if (lowHit || highHit) {
      const step = lowHit ? strike('kick', lowHit) : strike('snare', highHit);
      s.kickEnv = Math.max(s.kickEnv, step);
      s.highEnv = Math.max(s.highEnv, step);
      s.hitHold.kick = s.hitHold.snare = 0.04;
    } else {
      if (s.hitHold.kick > 0) s.hitHold.kick -= dt; else s.kickEnv *= Math.exp(-dt / fall('kick', 0.22, 0.15));
      if (s.hitHold.snare > 0) s.hitHold.snare -= dt; else s.highEnv *= Math.exp(-dt / fall('snare', 0.14, 0.1));
    }
    const hit = Math.max(lowHit, highHit);
    s.pulse = follow(s.pulse, s.kickEnv, dt, 0.03, 0.01);
    s.pulseHigh = follow(s.pulseHigh, s.highEnv, dt, 0.02, 0.01);
    s.pulseHits = s.pulseHits * Math.exp(-dt / 2) + (lowHit ? 1 : highHit ? FX_HIGH_FLASH : 0);
    s.noteHits = s.noteHits * Math.exp(-dt / 2) + (noteHit ? 1 : 0);
    // Notes : un halo doux de chaque côté, qui s'allume en ~80 ms et s'éteint en ~0,8 s,
    // plus vite quand elles s'enchaînent (sinon, au-delà de 2 notes/s, les deux côtés restent allumés).
    const noteFade = 0.8 - 0.45 * smoothstep(1.5, 3, s.noteHits / 2);
    for (const side of [0, 1]) {
      const struck = noteHit && side === s.side;
      s.noteEnv[side] = struck ? Math.max(s.noteEnv[side], 0.45 + 0.55 * smoothstep(0.18, 0.8, noteHit)) : s.noteEnv[side] * Math.exp(-dt / noteFade);
      s.note[side] = follow(s.note[side], s.noteEnv[side], dt, 0.08, 0.05);
    }
    s.pressure = follow(s.pressure, pressure, dt, 0.06, 0.12);
    s.glow = follow(s.glow, energy, dt, 0.3, 0.6);
    return {
      pulse: s.pulse, pulseHigh: s.pulseHigh, pressure: s.pressure, glow: s.glow, brightness: s.brightness,
      noteLeft: s.note[0], noteRight: s.note[1], pulseRate: s.pulseHits / 2,
      // mesures brutes, pour établir le profil d'un morceau
      energy: s.energy, subFloor: floor, steadyPressure, kickHit: hit, lowHit, highHit, flash: lowHit ? 1 : highHit ? FX_HIGH_FLASH : 0,
      noteHit, noteSide: s.side,
    };
  }

  reset();
  return { reset, setProfile, update };
}

// ---------- Séparation harmonique / percussive (pré-analyse seulement) ----------
// Le fichier entier est connu : on sépare ce qui dure (notes, accords : lignes horizontales du
// spectrogramme) de ce qui frappe (percussions : lignes verticales) par des filtres médians, puis on
// décrit chaque instant par la part percussive de la montée d'énergie, sa répartition en fréquence,
// et ce qui reste 70 à 130 ms plus tard. À taux de fausses détections égal (5 %), en validation par
// morceau, le classement passe de 64 à 83 % des notes et de 25 à 45 % des caisses claires.

const FX_HPSS_FEATURES = ['perc', 'percLow', 'percMid', 'percHigh', 'harmLow', 'harmMid', 'sustainH', 'sustainP', 'logPerc', 'logHarm'];
const FX_HPSS_FFT = 1024;   // même fenêtre (~46 ms) que l'analyse
const FX_HPSS_KERNEL = 17;  // médianes sur 17 images (~280 ms) et sur 17 bandes
const FX_PRINT_BANDS = 24;  // empreinte du son d'une image (voir hpssFeatures)

// Transformée de Fourier rapide (radix 2) : amplitudes d'une fenêtre de `size` échantillons.
function fftMagnitudes(size) {
  const bits = Math.log2(size);
  const rev = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = Float64Array.from({ length: size / 2 }, (_, i) => Math.cos((2 * Math.PI * i) / size));
  const sin = Float64Array.from({ length: size / 2 }, (_, i) => Math.sin((2 * Math.PI * i) / size));
  const re = new Float64Array(size), im = new Float64Array(size);
  return (input, out) => {
    for (let i = 0; i < size; i++) { re[rev[i]] = input[i]; im[rev[i]] = 0; }
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1, step = size / len;
      for (let start = 0; start < size; start += len) {
        for (let j = 0; j < half; j++) {
          const a = start + j, b = a + half, c = cos[j * step], s = sin[j * step];
          const tr = re[b] * c + im[b] * s, ti = im[b] * c - re[b] * s;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    for (let k = 0; k <= size / 2; k++) out[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  };
}

// Médiane glissante de rayon `r` sur `count` valeurs lues par `read(i)`, écrite dans `write(i, m)` :
// la fenêtre reste triée, on n'y retire et n'y ajoute qu'une valeur à chaque pas.
function fxSlidingMedian(count, r, read, write) {
  const win = new Float32Array(2 * r + 1);
  let size = 0;
  const insert = (v) => {
    let j = size++;
    while (j > 0 && win[j - 1] > v) { win[j] = win[j - 1]; j--; }
    win[j] = v;
  };
  const remove = (v) => {
    let j = 0;
    while (j < size - 1 && win[j] !== v) j++;
    for (; j < size - 1; j++) win[j] = win[j + 1];
    size--;
  };
  for (let i = 0; i < Math.min(count, r); i++) insert(read(i));
  for (let i = 0; i < count; i++) {
    if (i - r - 1 >= 0) remove(read(i - r - 1)); // retirer d'abord : la fenêtre ne dépasse jamais 2r + 1
    if (i + r < count) insert(read(i + r));
    write(i, win[size >> 1]);
  }
}

const fxYield = () => new Promise((resolve) => setTimeout(resolve, 0)); // laisse respirer l'interface

// Bandes de la séparation : chaque bin jusqu'à ~1,4 kHz, puis 64 bandes logarithmiques jusqu'à 10 kHz.
function hpssBands(sampleRate) {
  const top = Math.round((10000 / sampleRate) * FX_HPSS_FFT);
  const edges = [];
  for (let b = 1; b <= 64; b++) edges.push(b);
  for (let k = 0; k <= 64; k++) edges.push(Math.max(edges[edges.length - 1] + 1, Math.round(65 * (top / 65) ** (k / 64))));
  const B = edges.length - 1;
  const center = Array.from({ length: B }, (_, b) => ((edges[b] + edges[b + 1]) / 2) * (sampleRate / FX_HPSS_FFT));
  // Une image du spectre (amplitudes) → ses bandes, en échelle logarithmique
  const fill = (mags, L, offset) => {
    for (let b = 0; b < B; b++) {
      let sum = 0;
      for (let k = edges[b]; k < edges[b + 1]; k++) sum += mags[k];
      L[offset + b] = Math.log1p(100 * (sum / (edges[b + 1] - edges[b])));
    }
  };
  return { B, center, fill };
}

// Indicateurs harmonique/percussif pour chacune des `n` images, à partir de leurs spectres par bandes
// `L` (n × bands.B, voir hpssBands), comme FX_HPSS_FEATURES → Float32Array.
async function hpssFeatures(L, n, bands) {
  const { B, center } = bands;
  const inGroup = (lo, hi) => center.map((f) => f >= lo && f < hi);
  const low = inGroup(40, 150), mid = inGroup(150, 1000);

  // Ce qui dure (médiane dans le temps) contre ce qui frappe (médiane en fréquence) : masques doux
  const R = FX_HPSS_KERNEL >> 1;
  const H = new Float32Array(n * B), P = new Float32Array(n * B);
  for (let b = 0; b < B; b++) {
    fxSlidingMedian(n, R, (i) => L[i * B + b], (i, m) => { H[i * B + b] = m; });
    if (b % 16 === 15) await fxYield();
  }
  for (let i = 0; i < n; i++) {
    fxSlidingMedian(B, R, (b) => L[i * B + b], (b, m) => { P[i * B + b] = m; });
    if (i % 2000 === 1999) await fxYield();
  }
  const Sh = H, Sp = P; // réutilisés : Sh et Sp remplacent H et P, case par case
  for (let k = 0; k < n * B; k++) {
    const h = H[k], p = P[k], mh = (h * h) / (h * h + p * p + 1e-9);
    Sh[k] = L[k] * mh;
    Sp[k] = L[k] * (1 - mh);
  }
  // Empreinte du son de chaque image : spectre complet et part percussive sur FX_PRINT_BANDS bandes
  // logarithmiques de 40 Hz à 10 kHz (voir fxPercussionPattern)
  const group = center.map((f) => (f >= 40 && f < 10000 ? Math.floor((FX_PRINT_BANDS * Math.log(f / 40)) / Math.log(10000 / 40)) : -1));
  const groupSize = new Float32Array(FX_PRINT_BANDS);
  for (const g of group) if (g >= 0) groupSize[g]++;
  const printL = new Float32Array(n * FX_PRINT_BANDS), printP = new Float32Array(n * FX_PRINT_BANDS);
  for (let i = 0; i < n; i++) {
    for (let b = 0; b < B; b++) {
      const g = group[b];
      if (g < 0) continue;
      printL[i * FX_PRINT_BANDS + g] += L[i * B + b] / groupSize[g];
      printP[i * FX_PRINT_BANDS + g] += Sp[i * B + b] / groupSize[g];
    }
  }

  // Indicateurs : la montée sur l'attaque (image précédente à i + 2) et ce qui reste à i + 4…i + 7
  const meanOf = (S) => Float32Array.from({ length: n }, (_, i) => { let s = 0; for (let b = 0; b < B; b++) s += S[i * B + b]; return s / B; });
  const meanH = meanOf(Sh), meanP = meanOf(Sp);
  const out = Object.fromEntries(FX_HPSS_FEATURES.map((k) => [k, new Float32Array(n)]));
  const hz4k = inGroup(4000, 10001);
  for (let i = 0; i < n; i++) {
    const a = Math.max(1, i - 1), z = Math.min(n, i + 3);
    let rp = 0, rh = 0, rpLow = 0, rpMid = 0, rpHigh = 0, rhLow = 0, rhMid = 0, attackH = 0, attackP = 0;
    for (let f = a; f < z; f++) {
      for (let b = 0; b < B; b++) {
        const dp = Math.max(0, Sp[f * B + b] - Sp[(f - 1) * B + b]);
        const dh = Math.max(0, Sh[f * B + b] - Sh[(f - 1) * B + b]);
        rp += dp; rh += dh;
        if (low[b]) { rpLow += dp; rhLow += dh; }
        if (mid[b]) { rpMid += dp; rhMid += dh; }
        if (hz4k[b]) rpHigh += dp;
      }
      attackH += meanH[f]; attackP += meanP[f];
    }
    let afterH = 0, afterP = 0, count = 0;
    for (let f = Math.min(n - 1, i + 4); f < Math.min(n, i + 8); f++) { afterH += meanH[f]; afterP += meanP[f]; count++; }
    const total = rp + rh + 1e-9, span = Math.max(1, z - a);
    out.perc[i] = rp / total;
    out.percLow[i] = rpLow / total;
    out.percMid[i] = rpMid / total;
    out.percHigh[i] = rpHigh / total;
    out.harmLow[i] = rhLow / total;
    out.harmMid[i] = rhMid / total;
    out.sustainH[i] = count ? afterH / count / (attackH / span + 1e-9) : 1;
    out.sustainP[i] = count ? afterP / count / (attackP / span + 1e-9) : 1;
    out.logPerc[i] = Math.log1p(rp);
    out.logHarm[i] = Math.log1p(rh);
  }
  const melody = melodyContour(Sh, L, n, B, center);
  out.printL = printL;
  out.printP = printP;
  out.melodyHit = melody.hit;
  out.melodySide = melody.side;
  out.melodyPitch = melody.pitch;     // pour vérification (banc d'essai)
  out.melodyVoiced = melody.clarity.map((c) => (c >= melody.voicedMin ? 1 : 0));
  return out;
}

// Contour de la mélodie principale (pré-analyse) : une voix chantée glisse d'une note à l'autre sans
// attaque, et une mélodie de fond se noie sous la batterie : la détection par attaques ne les voit pas.
// On suit donc la hauteur dominante image par image (`S` : spectre logarithmique par bandes), et
// chaque nouvelle note tenue au moins FX_MELODY_HOLD images donne un événement : à droite si la
// mélodie monte, à gauche si elle descend.
const FX_MELODY_HOLD = 6;      // ~100 ms de hauteur stable pour compter une note
const FX_MELODY_STEP = 0.8;    // écart minimal avec la note précédente (demi-tons)
const FX_MELODY_GAP = 9;       // ~150 ms sans mélodie : nouvelle phrase
const FX_MELODY_ONSET = 10;    // ~170 ms : retard maximal de la part harmonique sur le début audible d'une note
const FX_MELODY_CLEAR = 3.4;     // clarté d'une série harmonique nette (voix, instrument mélodique)
const FX_MELODY_PRESENCE = 0.08; // part minimale de ces images autour d'une note de contour

// `Sh` : part harmonique du spectre, `L` : spectre complet (sans retard, pour dater le début des notes),
// tous deux logarithmiques par bandes.
function melodyContour(Sh, L, n, B, center) {
  // position (fractionnaire) d'une fréquence parmi les bandes
  const pos = (hz) => {
    if (hz <= center[0]) return 0;
    if (hz >= center[B - 1]) return B - 1;
    let lo = 0, hi = B - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (center[m] <= hz) lo = m; else hi = m; }
    return lo + (hz - center[lo]) / (center[hi] - center[lo]);
  };
  // fondamentales de 130 Hz à 1 kHz, au tiers de demi-ton : harmoniques comptés, entre-harmoniques
  // retranchés (sans quoi l'octave du dessous, qui « contient » les harmoniques pairs, gagnerait)
  const candidates = [];
  for (let semi = 48; semi <= 84; semi += 1 / 3) {
    const f0 = 440 * 2 ** ((semi - 69) / 12), taps = [];
    for (let h = 1; h <= 6; h++) {
      taps.push([pos(h * f0), 0.85 ** (h - 1)]);
      taps.push([pos((h - 0.5) * f0), -0.5 * 0.85 ** (h - 1)]);
    }
    candidates.push([semi, taps]);
  }
  const from = Math.floor(pos(100)), to = Math.ceil(pos(2000));
  // hauteur dominante de chaque image d'un spectre, et la netteté de sa série harmonique
  const track = (S) => {
    const pitch = new Float32Array(n), clarity = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const row = i * B;
      let best = -Infinity, bestSemi = 0;
      for (const [semi, taps] of candidates) {
        let sum = 0;
        for (const [x, w] of taps) { const k = Math.floor(x), f = x - k; sum += w * (S[row + k] * (1 - f) + S[row + Math.min(B - 1, k + 1)] * f); }
        if (sum > best) { best = sum; bestSemi = semi; }
      }
      let mean = 0;
      for (let b = from; b <= to; b++) mean += S[row + b];
      pitch[i] = bestSemi;
      clarity[i] = best / (mean / (to - from + 1) + 1e-6);
    }
    return { pitch, clarity };
  };
  const { pitch, clarity } = track(Sh);
  // Hauteur lissée par une médiane sur 7 images (~115 ms) : une erreur d'estimation isolée (quinte,
  // octave, harmonique d'un autre instrument) ne crée plus de fausse note.
  const raw = Float32Array.from(pitch);
  fxSlidingMedian(n, 3, (i) => raw[i], (i, m) => { pitch[i] = m; });
  // une mélodie est là quand sa série harmonique ressort nettement (au-dessus de la médiane du morceau)
  const sorted = Float32Array.from(clarity).sort();
  const voicedMin = sorted[Math.floor(0.5 * (n - 1))], strong = sorted[Math.floor(0.95 * (n - 1))];
  // Passage sans mélodie (batterie seule) : sur ±2 s, presque aucune image n'a une série harmonique
  // vraiment nette (clarté ≥ FX_MELODY_CLEAR) ; le contour s'y tait au lieu de suivre les fûts.
  const clearSum = new Float32Array(n + 1);
  for (let i = 0; i < n; i++) clearSum[i + 1] = clearSum[i] + (clarity[i] >= FX_MELODY_CLEAR ? 1 : 0);
  const reach = Math.round(2 / FX_STEP);
  const present = (i) => {
    const a = Math.max(0, i - reach), z = Math.min(n, i + reach + 1);
    return (clearSum[z] - clearSum[a]) / (z - a) >= FX_MELODY_PRESENCE;
  };
  const hit = new Float32Array(n), side = new Uint8Array(n);
  let runStart = -1, runPitch = 0, runLen = 0, runGap = Infinity, emitted = false;
  let lastPitch = null, lastSide = 1, lastVoiced = -Infinity, lastEvent = -Infinity;
  for (let i = 0; i < n; i++) {
    const isVoiced = clarity[i] >= voicedMin && present(i);
    if (isVoiced && runStart >= 0 && Math.abs(pitch[i] - runPitch) <= 0.6) {
      runLen++;
      runPitch += (pitch[i] - runPitch) / runLen;
    } else if (isVoiced) {
      runStart = i; runPitch = pitch[i]; runLen = 1; runGap = i - lastVoiced; emitted = false;
    } else {
      runStart = -1;
    }
    if (isVoiced) lastVoiced = i;
    if (runStart >= 0 && !emitted && runLen >= FX_MELODY_HOLD) {
      emitted = true;
      const diff = lastPitch === null ? 0 : runPitch - lastPitch;
      const octave = Math.abs(Math.abs(diff) - 12) < 0.7; // saut d'octave : sans doute une erreur d'estimation
      if (!octave && (lastPitch === null || Math.abs(diff) >= FX_MELODY_STEP || runGap > FX_MELODY_GAP)) {
        if (Math.abs(diff) >= FX_MELODY_STEP) lastSide = diff > 0 ? 1 : 0;
        // La part harmonique ne montre une note qu'avec retard (jusqu'à ~170 ms : médiane, glissement d'une
        // voix) : son vrai début est l'image, juste avant, où ses propres harmoniques montent le plus dans
        // le spectre complet (le marteau d'un piano, l'arrivée d'une voix), sans se laisser distraire par la
        // batterie. Puis 2 images plus loin, comme une note d'attaque au moment où elle est reconnue
        // (FX_LEAD les cale ensuite sur le son).
        const f0 = 440 * 2 ** ((runPitch - 69) / 12);
        const bandsOfNote = [1, 2, 3, 4].map((h) => Math.round(pos(h * f0)));
        const noteRise = (k) => bandsOfNote.reduce((sum, b) => sum + Math.max(0, L[k * B + b] - L[(k - 1) * B + b]), 0);
        let onset = runStart, best = -1;
        for (let k = Math.max(lastEvent + 1, runStart - FX_MELODY_ONSET, 1); k <= runStart; k++) {
          const r = noteRise(k);
          if (r > best) { best = r; onset = k; }
        }
        const at = Math.max(lastEvent + 3, Math.min(n - 1, onset + 2));
        lastEvent = at;
        hit[at] = 0.5 + 0.5 * smoothstep(voicedMin, strong, clarity[runStart]);
        side[at] = lastSide;
        lastPitch = runPitch;
      }
    }
  }
  return { hit, side, pitch, clarity, voicedMin };
}

// ---------- Pré-analyse du morceau entier ----------
// Le fichier est local : on l'analyse en ~1 s au chargement. Les références du morceau
// (passage le plus fort, basse la plus lourde, part de basses tenues) sont alors justes dès
// la première seconde, au lieu de se construire pendant l'écoute : une intro calme reste
// calme, et le premier drop n'est pas exagéré.

const FX_PROFILE_RATE = 22050;  // suffisant jusqu'à 11 kHz, et deux fois moins de mémoire
const FX_PROFILE_MAX = 15 * 60; // au-delà (mix d'une heure…), on reste en mode adaptatif

// ---------- Synchronisation ----------
// La pré-analyse calcule aussi la chronologie de tous les effets, à la même cadence qu'en direct
// (mêmes réglages, donc même dynamique). Pendant la lecture, on la lit à la position du morceau,
// chaque effet joué en avance de son propre retard (analyse + montée), mesuré sur des attaques
// et des changements connus : la pulsation est à mi-hauteur ~51 ms après l'attaque, une note ~78 ms,
// la pression à mi-chemin 0,5 s après l'arrivée de la basse, le halo 1,5 s après un drop.
const FX_LEAD = { melody: 0.06, melodyTone: 0.06, pulse: 0.051, pulseHigh: 0.051, pulseRate: 0.051, noteLeft: 0.078, noteRight: 0.078, noteLeftA: 0.078, noteRightA: 0.078, pressure: 0.5, glow: 1.5, brightness: 0.7 };
const FX_DISPLAY_LATENCY = 0.025; // le temps qu'une image calculée apparaisse à l'écran
// Retard de la position de lecture (currentTime) sur ce que voit l'analyse : 0 à 8 ms sur la machine de
// développement, mesuré sur des coups à instants connus. Ce n'est qu'un point de départ : il est
// mesuré en continu pendant l'écoute sur la machine de l'utilisateur (voir calibrateClock).
const FX_CLOCK_OFFSET = 0.004;
const FX_CLOCK_WINDOW = 360;      // mesures (~6 s) par estimation du retard
// Une image légèrement en avance sur le son passe inaperçue, en retard beaucoup moins : marge visée.
const FX_TARGET_ADVANCE = 0.008;
const FX_TIMELINES_KEPT = 20;     // chronologies gardées en mémoire (~0,5 Mo pour 5 min) : un album entier

// Spectre d'une image calculé comme l'AnalyserNode de Chromium (fenêtre de Blackman, amplitude divisée
// par la taille, lissage d'une image à l'autre, décibels), mais sur des échantillons déjà décodés :
// pas besoin de faire jouer le morceau, et les instants des images sont exacts. `mags` garde les
// amplitudes brutes de la dernière image (pour la séparation harmonique/percussive).
function createOfflineAnalyser(samples, fftSize, smoothing) {
  const fft = fftMagnitudes(fftSize);
  const win = Float32Array.from({ length: fftSize }, (_, i) =>
    0.42 - 0.5 * Math.cos((2 * Math.PI * i) / fftSize) + 0.08 * Math.cos((4 * Math.PI * i) / fftSize));
  const frame = new Float32Array(fftSize), mags = new Float32Array(fftSize / 2 + 1);
  const smooth = new Float32Array(fftSize / 2), db = new Float32Array(fftSize / 2);
  return {
    fftSize,
    frequencyBinCount: fftSize / 2,
    mags,
    // Analyse les `fftSize` échantillons qui finissent à l'indice `end`.
    seek(end) {
      for (let k = 0; k < fftSize; k++) {
        const s = end - fftSize + k;
        frame[k] = s >= 0 && s < samples.length ? samples[s] * win[k] : 0;
      }
      fft(frame, mags);
      for (let k = 0; k < smooth.length; k++) {
        smooth[k] = smoothing * smooth[k] + (1 - smoothing) * (mags[k] / fftSize);
        db[k] = 20 * Math.log10(smooth[k] || 1e-30);
      }
    },
    getFloatFrequencyData(out) { out.set(db); },
  };
}

// `inspect(levels, effets, i)` : appelé pour chaque image de la chronologie (banc d'essai).
async function analyseTrack(data, inspect = null) {
  const decoded = await new OfflineAudioContext(1, 1, FX_PROFILE_RATE).decodeAudioData(data);
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c));
  return analyseSamples(channels, decoded.duration, inspect);
}

// Le même calcul hors du fil de l'interface : il prend plusieurs secondes (près d'une seconde d'un
// seul tenant pour un morceau de 5 min) et ferait saccader l'affichage. Le décodage reste ici (le
// navigateur le fait déjà sur un autre fil) ; le reste part dans fx-worker.js. Sans Worker
// disponible, on calcule ici, comme avant.
let fxWorker, fxWorkerBroken = false;
async function analyseTrackOffThread(data) {
  const decoded = await new OfflineAudioContext(1, 1, FX_PROFILE_RATE).decodeAudioData(data);
  return analyseChannelsOffThread(Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c)), decoded.duration);
}

// Analyse d'échantillons déjà décodés (à FX_PROFILE_RATE), hors du fil de l'interface. Le Worker ne
// traite qu'une analyse à la fois : les demandes passent l'une après l'autre.
let fxWorkerQueue = Promise.resolve();
function analyseChannelsOffThread(source, duration, options = {}) {
  const job = fxWorkerQueue.then(() => analyseInWorker(source, duration, options));
  fxWorkerQueue = job.catch(() => {});
  return job;
}

async function analyseInWorker(channels, duration, options) {
  if (!fxWorkerBroken) {
    try {
      fxWorker ??= new Worker('fx-worker.js');
      const copies = channels.map((c) => c.slice());
      return await new Promise((resolve, reject) => {
        // une erreur de l'analyse elle-même (rare) n'a rien à voir avec le Worker : elle remonte telle quelle
        fxWorker.onmessage = ({ data: reply }) => (reply.error ? reject(Object.assign(new Error(reply.error), { analysis: true })) : resolve(reply.profile));
        fxWorker.onerror = (e) => { e.preventDefault(); reject(new Error(e.message)); };
        fxWorker.postMessage({ channels: copies, duration, options }, copies.map((c) => c.buffer));
      });
    } catch (err) {
      if (err.analysis) throw err;
      // Worker introuvable ou planté : on analyse désormais ici
      console.warn('Pré-analyse en arrière-plan impossible, elle se fera sur le fil principal :', err);
      fxWorkerBroken = true;
      fxWorker?.terminate();
      fxWorker = null;
    }
  }
  return analyseSamples(channels, duration, null, options);
}

// Analyse à partir des échantillons décodés (un tableau par canal, à FX_PROFILE_RATE).
// `options.stem` : la piste séparée analysée ('drums', 'vocals', 'other', 'bass'), ou rien pour le mix.
async function analyseSamples(channels, duration, inspect = null, options = {}) {
  // Mono, comme l'entendait l'analyseur : moyenne des canaux
  const samples = new Float32Array(channels[0].length);
  for (const channel of channels) {
    for (let i = 0; i < samples.length; i++) samples[i] += channel[i] / channels.length;
  }
  // même résolution (~21 Hz par bin) et même lissage qu'en direct, à la même cadence (FX_STEP)
  const analyser = createOfflineAnalyser(samples, FX_HPSS_FFT, 0.5);
  const readFrame = createFrameReader(analyser, FX_PROFILE_RATE);
  const bands = hpssBands(FX_PROFILE_RATE);
  const n = Math.max(0, Math.floor((duration - 128 / FX_PROFILE_RATE) / FX_STEP - 1e-9));
  const L = new Float32Array(n * bands.B);
  const frames = [];
  for (let i = 0; i < n; i++) {
    analyser.seek(Math.round((i + 1) * FX_STEP * FX_PROFILE_RATE));
    frames.push(readFrame());
    bands.fill(analyser.mags, L, i * bands.B);
    if (i % 1000 === 999) await fxYield();
  }
  const hpss = await hpssFeatures(L, n, bands);
  frames.forEach((levels, i) => {
    for (const key of FX_HPSS_FEATURES) levels[key] = hpss[key][i];
    levels.melodyHit = hpss.melodyHit[i];
    levels.melodySide = hpss.melodySide[i];
    levels.melodyPitch = hpss.melodyPitch[i];
    levels.melodyVoiced = hpss.melodyVoiced[i];
    levels.printL = hpss.printL.subarray(i * FX_PRINT_BANDS, (i + 1) * FX_PRINT_BANDS);
    levels.printP = hpss.printP.subarray(i * FX_PRINT_BANDS, (i + 1) * FX_PRINT_BANDS);
  });
  const profile = trackProfile(frames, FX_STEP);
  if (!profile) return null;
  profile.stem = options.stem || null;
  const timeline = trackTimeline(frames, profile, inspect);
  // Le flux brut sert à recaler l'horloge pendant l'écoute (calibrateClock).
  const flux = Float32Array.from(frames, (levels) => levels.flux);
  const pulses = Float32Array.from(timeline.pulse, (v, i) => v + timeline.pulseHigh[i]);
  return { ...profile, timeline, flux, beat: trackBeat(pulses) };
}

// Chronologie des effets : l'image i décrit le morceau jusqu'à (i + 1) × FX_STEP secondes.
function trackTimeline(frames, profile, inspect = null) {
  fxPercussionPattern(frames, profile);
  const feel = createFeel();
  feel.reset(profile);
  const channels = Object.fromEntries(Object.keys(FX_LEAD).map((key) => [key, new Float32Array(frames.length)]));
  const hits = new Float32Array(frames.length);
  frames.forEach((levels, i) => {
    const o = feel.update(levels, (i + 1) * FX_STEP, FX_STEP);
    for (const key in channels) if (key in o) channels[key][i] = o[key];
    hits[i] = o.flash;
    inspect?.(levels, o, i);
  });
  // Les notes lues sur les seules attaques, pour le karaoké (noteLeftA/noteRightA)
  const attacks = createFeel({ contour: false });
  attacks.reset(profile);
  frames.forEach((levels, i) => {
    const o = attacks.update(levels, (i + 1) * FX_STEP, FX_STEP);
    channels.noteLeftA[i] = o.noteLeft;
    channels.noteRightA[i] = o.noteRight;
  });
  // Le morceau étant connu d'avance, le nombre de pulsations par seconde se compte sur ±1 s autour
  // de chaque instant : la limite de flashs s'applique dès le premier coup d'un passage dense.
  const half = Math.round(1 / FX_STEP);
  let count = 0;
  for (let i = 0; i < Math.min(half, frames.length); i++) count += hits[i];
  for (let i = 0; i < frames.length; i++) {
    if (i + half < frames.length) count += hits[i + half];
    if (i - half - 1 >= 0) count -= hits[i - half - 1];
    channels.pulseRate[i] = count / 2;
  }
  return channels;
}

// ---------- Percussions du mix : le son, puis le motif (pré-analyse) ----------
// Sans pistes séparées, chaque attaque du mix est jugée en deux passes par des arbres de décision
// (FX_PERC_MODEL, fx-perc-model.js), appris sur des morceaux pop et K-pop contre leur piste batterie
// séparée par HT-Demucs :
//  1. sur son son : vibration et fréquences (indicateurs de createFrameReader et de hpssFeatures), et
//     ce qui l'entoure (attaques une à quatre mesures plus tôt et plus tard, forme qui se répète, place
//     sur la grille des doubles croches) ;
//  2. sur le motif du morceau, tiré des attaques jugées sûres en passe 1 : une batterie revient aux
//     mêmes places d'une mesure à l'autre ; une syllabe hors du motif tombe, un coup discret qui y
//     tombe est repêché.
// Chaque morceau jugé par un modèle appris sans lui (19 morceaux) : 88 % des coups de la référence
// retrouvés (82 % avant ; le détecteur d'attaques plafonne à ~91 %), 75 % des pulsations sur un vrai
// coup (64 % avant). Le résultat va dans `percHit` des images d'attaque.
const FX_PERC_SHAPE = ['percLow', 'percMid', 'percHigh', 'harmLow', 'harmMid', 'airy', 'bassy', 'spread'];

function fxMedian(values) {
  const s = Float64Array.from(values).sort(), n = s.length;
  return !n ? 0 : n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// Durée approximative d'un temps (s) : autocorrélation des instants au centième, ramenée entre 0,4 et 0,75 s
function fxCoarseBeat(times, duration) {
  const x = new Uint8Array(Math.floor(duration * 100) + 1);
  for (const t of times) x[Math.floor(t * 100)] = 1;
  let best = -1, bestLag = 30;
  for (let lag = 30; lag <= 100; lag++) {
    let sum = 0;
    for (let i = lag; i < x.length; i++) sum += x[i] & x[i - lag];
    if (sum > best) { best = sum; bestLag = lag; }
  }
  let beat = bestLag / 100;
  while (beat < 0.4) beat *= 2;
  while (beat > 0.75) beat /= 2;
  return beat;
}

// Durée exacte d'un temps (à 0,5 ms près, ±4 % autour de `coarse`) : celle qui aligne le mieux les
// instants `times` (triés) entre eux sur les 8 temps suivants.
function fxBeatPeriod(times, coarse) {
  let best = -1, bestP = coarse;
  const steps = Math.ceil((coarse * 1.04 - coarse * 0.96) / 0.0005);
  for (let j = 0; j < steps; j++) {
    const P = coarse * 0.96 + j * 0.0005;
    let score = 0;
    for (let i = 0; i < times.length; i++) {
      for (let k = i + 1; k < Math.min(times.length, i + 40); k++) {
        const d = times[k] - times[i], m = Math.round(d / P);
        if (d >= 8 * P + 0.1) break; // instants triés : les suivants sont plus loin encore
        if (m >= 1) score += Math.exp(-(((d - m * P) / 0.012) ** 2));
      }
    }
    if (score > best) { best = score; bestP = P; }
  }
  return bestP;
}

const fxSearch = (sorted, x) => { // premier indice où sorted[i] ≥ x
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < x) lo = m + 1; else hi = m; }
  return lo;
};

// Place sur la grille : phase des instants `near` (moyenne circulaire sur la période P) → instant d'un temps
const fxPhase = (near, P) => {
  let c = 0, s = 0;
  for (const t of near) { c += Math.cos((2 * Math.PI * t) / P); s += Math.sin((2 * Math.PI * t) / P); }
  return (Math.atan2(s, c) / (2 * Math.PI)) * P;
};

// Indicateurs de la passe 1 pour les attaques `idx` (indices d'images, croissants) ; `lows` : instants
// des coups graves reconnus par les règles (grille des temps). → un tableau d'indicateurs par attaque,
// dans l'ordre de FX_PERC_MODEL.features.
function fxPercFeatures(frames, idx, lows) {
  const n = idx.length, end = frames.length * FX_STEP;
  const value = (key, i) => (Number.isFinite(frames[i][key]) ? frames[i][key] : 0);
  const pair = (key, i) => (value(key, i) + value(key, i + 1)) / 2; // image de l'attaque et la suivante
  const times = idx.map((i) => (i + 1) * FX_STEP);
  const strength = idx.map((i) => pair('logPerc', i));
  const strongMin = fxMedian(strength);
  const shape = idx.map((i) => {
    const v = FX_PERC_SHAPE.map((key) => pair(key, i));
    const norm = Math.hypot(...v) + 1e-9;
    return v.map((x) => x / norm);
  });
  const P = lows.length > 16 ? fxBeatPeriod(lows, fxCoarseBeat(lows, end)) : 0.5;
  // l'attaque la plus proche de x à 35 ms près, si `ok` l'accepte
  const near = (x, ok = null) => {
    let best = -1;
    for (let k = fxSearch(times, x - 0.035 - 1e-9); k < n && times[k] <= x + 0.035 + 1e-9; k++) {
      if (Math.abs(times[k] - x) <= 0.035 && (!ok || ok(k)) && (best < 0 || Math.abs(times[k] - x) < Math.abs(times[best] - x))) best = k;
    }
    return best;
  };
  const support = (x, step, ok = null) => {
    let hit = 0, total = 0;
    for (const m of [-4, -3, -2, -1, 1, 2, 3, 4]) {
      const y = x + m * step;
      if (y < 0 || y > end) continue;
      total++;
      if (near(y, ok) >= 0) hit++;
    }
    return total ? hit / total : 0;
  };
  const order = strength.map((v, a) => [v, a]).sort((u, w) => u[0] - w[0] || u[1] - w[1]);
  const rank = new Float64Array(n);
  order.forEach(([, a], r) => { rank[a] = r / Math.max(1, n - 1); });
  return idx.map((i, a) => {
    const x = times[a];
    const sims = [];
    for (const m of [-2, -1, 1, 2]) {
      const b = near(x + m * 4 * P);
      if (b >= 0) sims.push(shape[a].reduce((sum, v, k) => sum + v * shape[b][k], 0));
    }
    // coups graves à moins de 4 s (un coup pile à 4 s, fréquent sur la grille des images, n'en est pas)
    const local = lows.slice(fxSearch(lows, x - 4), fxSearch(lows, x + 4)).filter((t) => t > x - 4 + 1e-6 && t < x + 4 - 1e-6);
    let grid = 0.25;
    if (local.length >= 3) {
      const u = (x - fxPhase(local, P)) / (P / 4), d = u - Math.floor(u);
      grid = Math.min(d, 1 - d);
    }
    const density = fxSearch(times, x + 1 + 1e-9) - fxSearch(times, x - 1 - 1e-9);
    return [
      ...FX_PERC_MODEL.features.slice(0, -8).map((key) => pair(key, i)),
      support(x, 4 * P), support(x, 2 * P), support(x, 4 * P, (k) => strength[k] >= strongMin),
      sims.length ? sims.reduce((s, v) => s + v, 0) / sims.length : 0,
      grid, density / 2, pair('melodyVoiced', i), rank[a],
      ...fxPercSound(frames, i),
    ];
  });
}

// Le son d'une attaque, d'après les empreintes des images voisines (printL : spectre complet, printP : part
// percussive) : sa montée bande par bande, sa retombée sur ~250 ms, son côté bruité (une frappe est un
// bruit, une note une série d'harmoniques), et la voix autour (une syllabe au milieu d'une phrase chantée
// garde sa hauteur de part et d'autre de l'attaque).
function fxPercSound(frames, i) {
  const full = (k) => frames[i + k].printL, perc = (k) => frames[i + k].printP;
  const rise = (M) => Array.from(M(1), (v, g) => Math.max(0, v - M(-1)[g]));
  const sum = (v) => v.reduce((s, x) => s + x, 0);
  const unit = (v) => { const norm = Math.hypot(...v) + 1e-9; return v.map((x) => x / norm); };
  const level = (M, k) => sum(M(k)) / FX_PRINT_BANDS;
  const decay = (M) => [3, 6, 10, 15].map((k) => level(M, k) - level(M, 1));
  const flatness = (v) => { // moyenne géométrique / arithmétique
    let logs = 0, total = 0;
    for (const x of v) { logs += Math.log(x + 1e-3); total += x + 1e-3; }
    return Math.exp(logs / v.length) / (total / v.length);
  };
  const voice = (from, to) => {
    let voiced = 0;
    const pitches = [];
    for (let k = from; k < to; k++) {
      voiced += frames[i + k].melodyVoiced;
      if (frames[i + k].melodyVoiced > 0) pitches.push(frames[i + k].melodyPitch);
    }
    return [voiced / (to - from), pitches];
  };
  const R = rise(full), RP = rise(perc);
  const groups = {
    spectre: () => [...unit(R), ...unit(RP), Math.log1p(sum(R)), Math.log1p(sum(RP))],
    decroissance: () => [...decay(full), ...decay(perc)],
    bruit: () => [flatness(R), flatness(RP), flatness(perc(1))],
    voix: () => {
      const [before, pitchBefore] = voice(-8, 0), [after, pitchAfter] = voice(2, 10);
      const jump = pitchBefore.length >= 3 && pitchAfter.length >= 3 ? Math.abs(fxMedian(pitchAfter) - fxMedian(pitchBefore)) : -1;
      return [before, after, jump, jump >= 0 && jump < 0.6 ? 1 : 0];
    },
  };
  // seulement les groupes dont se sert le modèle, dans l'ordre de son apprentissage
  return FX_PERC_MODEL.groups.filter((g) => groups[g]).flatMap((g) => groups[g]());
}

// Empreinte d'une attaque pour comparer les sons entre eux : sa montée puis le début de sa retombée
// (images +1, +2, +3, +5 moins l'image d'avant), complète ou percussive, de longueur 1.
function fxPercPrint(frames, i, key) {
  const v = [];
  for (const k of [1, 2, 3, 5]) frames[i + k][key].forEach((x, g) => v.push(x - frames[i - 1][key][g]));
  const norm = Math.hypot(...v) + 1e-9;
  return Float64Array.from(v, (x) => x / norm);
}

// Les sons copiés : en pop, la batterie rejoue le même échantillon tout du long, une syllabe ne se répète
// jamais à l'identique. Pour chaque attaque, sa ressemblance avec les attaques sûres de la passe 1 (la plus
// proche, les 5 plus proches), avec les attaques sûrement pas des coups, et la part des sûres qui sont
// presque sa copie ; on ne compare qu'à moins de `window` secondes (coût borné).
function fxPercCopies(prints, times, sure, unsure, window) {
  const n = times.length;
  return times.map((x, a) => {
    const topSure = [], topUnsure = [];
    const keep = (top, v) => { // les 5 plus grandes valeurs
      if (top.length < 5) top.push(v); else if (v > top[0]) top[0] = v; else return;
      top.sort((u, w) => u - w);
    };
    let copies = 0, compared = 0;
    for (let b = fxSearch(times, x - window); b < n && times[b] < x + window; b++) {
      const gap = Math.abs(times[b] - x);
      if (gap < 0.25 || gap >= window || !(sure[b] || unsure[b])) continue;
      let sim = 0;
      for (let k = 0; k < prints[a].length; k++) sim += prints[a][k] * prints[b][k];
      if (sure[b]) { keep(topSure, sim); compared++; if (sim > 0.9) copies++; }
      else keep(topUnsure, sim);
    }
    const mean5 = (top) => (top.reduce((s, v) => s + v, 0) - (5 - top.length)) / 5; // manquantes : -1
    const best = topSure.length ? topSure[topSure.length - 1] : -1, s5 = mean5(topSure), u5 = mean5(topUnsure);
    return [best, s5, u5, s5 - u5, copies / Math.max(1, compared)];
  });
}

// Indicateurs de la passe 2 : le motif, tiré des probabilités `p` de la passe 1 (attaques aux instants
// `times`), → { rows, P } (P : durée d'un temps).
function fxPercPattern(times, p) {
  const n = times.length, sure = times.filter((_, a) => p[a] > 0.6);
  const P = sure.length > 16 ? fxBeatPeriod(sure, fxCoarseBeat(sure, times[n - 1] + 1)) : 0.5;
  const bestP = (y) => { // attaque la plus probable à 35 ms près
    let best = 0;
    for (let k = fxSearch(times, y - 0.035); k < n && times[k] < y + 0.035; k++) best = Math.max(best, p[k]);
    return best;
  };
  const meanAt = (y, step, ms) => ms.reduce((s, m) => s + bestP(y + m * step), 0) / ms.length;
  // place de chaque attaque dans le temps (double croche 0 à 3), phase locale tirée des attaques sûres à ±4 s
  const slot = times.map((x) => {
    const local = sure.slice(fxSearch(sure, x - 4), fxSearch(sure, x + 4)).filter((t) => Math.abs(t - x) < 4);
    if (local.length < 3) return -1;
    return ((Math.round((x - fxPhase(local, P)) / (P / 4)) % 4) + 4) % 4;
  });
  const rows = times.map((x, a) => {
    let share = 0.25, slotRank = 0.5;
    const shares = [0, 0, 0, 0];
    let count = 0;
    for (let k = fxSearch(times, x - 8); k < n && times[k] < x + 8; k++) {
      if (Math.abs(times[k] - x) < 8 && slot[k] >= 0) { shares[slot[k]] += p[k]; count++; }
    }
    if (slot[a] >= 0 && count > 4) {
      const total = Math.max(1e-9, shares.reduce((s, v) => s + v, 0));
      share = shares[slot[a]] / total;
      // rang de cette place parmi les quatre (0 : la plus fréquentée), à égalité la première l'emporte
      const ahead = shares.filter((v, s) => v > shares[slot[a]] || (v === shares[slot[a]] && s < slot[a])).length;
      slotRank = ahead / 3;
    }
    const around = [];
    for (let k = fxSearch(times, x - 4); k < n && times[k] < x + 4; k++) if (Math.abs(times[k] - x) < 4) around.push(p[k]);
    return [
      p[a], meanAt(x, 4 * P, [-2, -1, 1, 2]), meanAt(x, 4 * P, [-8, -6, -4, -3, 3, 4, 6, 8]),
      meanAt(x, 2 * P, [-1, 1]), meanAt(x, P, [-1, 1]), share, slotRank, p[a] - fxMedian(around),
    ];
  });
  return { rows, P };
}

// Probabilité d'un ensemble d'arbres (gradient boosting, sortie logistique) pour les indicateurs `x`.
function fxTrees(model, x) {
  let score = model.base;
  for (const tree of model.trees) {
    let k = 0;
    while (tree.f[k] >= 0) k = x[tree.f[k]] <= tree.t[k] ? tree.l[k] : tree.r[k];
    score += tree.v[k];
  }
  return 1 / (1 + Math.exp(-score));
}

// Indicateurs de la passe 2 : motif, sons copiés (complets et percussifs), répétition exacte du son une
// et deux mesures plus tôt et plus tard, et contexte du morceau (part d'attaques sûres, attaques par
// seconde, régularité des sûres).
function fxPercSecond(frames, idx, p1) {
  const times = idx.map((i) => (i + 1) * FX_STEP), n = times.length;
  const { rows, P } = fxPercPattern(times, p1);
  const uses = (g) => FX_PERC_MODEL.groups.includes(g);
  if (!['empreinte', 'empreinte_perc', 'repetition', 'contexte'].some(uses)) return rows;
  const sure = p1.map((v) => v > 0.6), unsure = p1.map((v) => v < 0.2);
  const prints = idx.map((i) => fxPercPrint(frames, i, 'printL'));
  const none = times.map(() => []);
  const copies = uses('empreinte') ? fxPercCopies(prints, times, sure, unsure, FX_PERC_MODEL.window) : none;
  const copiesPerc = uses('empreinte_perc') ? fxPercCopies(idx.map((i) => fxPercPrint(frames, i, 'printP')), times, sure, unsure, FX_PERC_MODEL.window) : none;
  const repeat = !uses('repetition') ? none : times.map((x, a) => {
    const sims = [];
    for (const m of [-2, -1, 1, 2]) {
      const y = x + m * 4 * P;
      let best = -Infinity;
      for (let b = fxSearch(times, y - 0.035); b < n && times[b] < y + 0.035; b++) {
        let sim = 0;
        for (let k = 0; k < prints[a].length; k++) sim += prints[a][k] * prints[b][k];
        best = Math.max(best, sim);
      }
      if (best > -Infinity) sims.push(best);
    }
    return sims.length ? [Math.max(...sims), sims.reduce((s, v) => s + v, 0) / sims.length] : [0, 0];
  });
  const sureCount = sure.filter(Boolean).length;
  const context = !uses('contexte') ? [] : [
    sureCount / n, n / (frames.length * FX_STEP),
    sureCount ? rows.reduce((s, r, a) => s + (sure[a] ? r[1] : 0), 0) / sureCount : 0,
  ];
  return rows.map((r, a) => [...r, ...copies[a], ...copiesPerc[a], ...repeat[a], ...context]);
}

// Probabilités finales (passe 2) des attaques `idx`, et les indicateurs de la passe 1 (voir fxSignature).
function fxPercProbabilities(frames, idx, lows) {
  const first = fxPercFeatures(frames, idx, lows);
  const p1 = first.map((x) => fxTrees(FX_PERC_MODEL.first, x));
  const second = fxPercSecond(frames, idx, p1);
  return { p: first.map((x, a) => fxTrees(FX_PERC_MODEL.second, [...x, ...second[a]])), first };
}

// Motif signature : le rythme qui revient pareil tout au long du morceau, celui qu'on taperait du pied
// (le clap de Setsuna Hanabi, le temps simple de Death of Me). Un coup par temps, à la place du temps
// (double croche 0 à 3, phase locale tirée des coups sûrs) où se rassemblent, sur ±16 s, les coups sûrs
// forts et peu graves (clap, caisse claire). Comparé aux temps tapés par l'utilisateur sur ces deux
// morceaux : 55 % et 61 % de ses appuis retrouvés (84 % sur Death of Me une fois la batterie entrée),
// 68 % et 81 % des coups du motif sur un de ses appuis. → un drapeau par attaque.
function fxSignature(times, p, bassy, force) {
  const n = times.length, keep = new Uint8Array(n);
  const sure = times.filter((_, a) => p[a] > 0.5);
  if (sure.length <= 16) return keep;
  const P = fxBeatPeriod(sure, fxCoarseBeat(sure, times[n - 1] + 1));
  const slot = times.map((x) => {
    const local = sure.slice(fxSearch(sure, x - 4), fxSearch(sure, x + 4)).filter((t) => Math.abs(t - x) < 4);
    return local.length < 3 ? -1 : ((Math.round((x - fxPhase(local, P)) / (P / 4)) % 4) + 4) % 4;
  });
  const clap = (a) => p[a] > 0.5 && force[a] > 0.6 && bassy[a] < 0.12 && slot[a] >= 0;
  let last = -Infinity;
  for (let a = 0; a < n; a++) {
    if (p[a] <= FX_PERC_MODEL.threshold || slot[a] < 0) continue;
    const count = [0, 0, 0, 0];
    for (let b = fxSearch(times, times[a] - 16); b < n && times[b] < times[a] + 16; b++) {
      if (Math.abs(times[b] - times[a]) < 16 && clap(b)) count[slot[b]]++;
    }
    const home = count.indexOf(Math.max(...count)); // à égalité, la première place
    if (slot[a] === home && times[a] - last >= 0.6 * P) { keep[a] = 1; last = times[a]; }
  }
  return keep;
}

// Juge les attaques du mix (pas d'une piste séparée, qui garde ses règles) et inscrit le verdict dans
// `percHit` de leur image. Sans le modèle (fichier absent), les règles de createFeel s'appliquent.
function fxPercussionPattern(frames, profile) {
  if (typeof FX_PERC_MODEL === 'undefined' || profile.stem || frames.length < 30 || !frames[0].printL) return;
  // mêmes détecteurs d'attaques que createFeel, et les coups graves de ses règles (grille des temps)
  const probe = createFeel();
  probe.reset(profile);
  const kick = onsetDetector(0.06, { minRise: FX_KICK_RISE, contrast: FX_KICK_CONTRAST });
  const tone = onsetDetector(0.06, { floor: FX_FLUX_FLOOR, minRise: FX_NOTE_RISE, contrast: FX_NOTE_CONTRAST });
  const idx = [], lows = [];
  frames.forEach((levels, i) => {
    const now = (i + 1) * FX_STEP;
    if (probe.update(levels, now, FX_STEP).lowHit) lows.push(now);
    const k = detectOnset(kick, levels.kick, now, FX_STEP), t = detectOnset(tone, levels.flux, now, FX_STEP);
    if ((k || t) && i > 8 && i + 16 < frames.length) idx.push(i); // il faut le son autour (fxPercSound)
  });
  if (!idx.length) return;
  const { p, first } = fxPercProbabilities(frames, idx, lows);
  const column = (key) => first.map((x) => x[FX_PERC_MODEL.features.indexOf(key)]);
  const signature = fxSignature(idx.map((i) => (i + 1) * FX_STEP), p, column('bassy'), column('rise_rank'));
  idx.forEach((i, a) => {
    frames[i].percHit = p[a] > FX_PERC_MODEL.threshold ? 1 : 0;
    frames[i].percSignature = signature[a];
  });
}

// Durée d'un temps (s) d'après la régularité des pulsations, ou null sans rythme net : autocorrélation
// des attaques de la pulsation entre 0,3 et 1 s, ramenée entre 80 et 150 BPM.
function trackBeat(pulse) {
  const onsets = pulse.map((v, i) => (i ? Math.max(0, v - pulse[i - 1]) : 0));
  const corr = (lag) => { let s = 0; for (let i = lag; i < onsets.length; i++) s += onsets[i] * onsets[i - lag]; return s; };
  const zero = corr(0);
  if (!zero) return null;
  let best = 0, bestLag = 0;
  for (let lag = Math.round(0.3 / FX_STEP); lag <= Math.round(1 / FX_STEP); lag++) {
    const c = corr(lag);
    if (c > best) { best = c; bestLag = lag; }
  }
  if (best / zero < 0.25) return null;
  let beat = bestLag * FX_STEP;
  while (beat < 0.4) beat *= 2;
  while (beat > 0.75) beat /= 2;
  return beat;
}

// Effets à l'instant `time` (secondes du morceau) pour chaque effet, `shift(effet)` donnant son décalage.
function readTimeline(channels, time, shift) {
  const fx = {};
  for (const key in channels) {
    const values = channels[key];
    const x = (time + shift(key)) / FX_STEP - 1;
    const i = Math.max(0, Math.min(values.length - 2, Math.floor(x)));
    const f = Math.max(0, Math.min(1, x - i));
    fx[key] = values[i] * (1 - f) + values[i + 1] * f;
  }
  return fx;
}

function trackProfile(frames, dt) {
  if (frames.length < 40) return null; // moins de 2 s : rien de fiable
  const percentile = (values, p) => values.slice().sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];
  const run = (feel, each) => frames.forEach((levels, i) => each(feel.update(levels, i * dt, dt)));

  // 1re passe : énergie, plancher de basse et coups tout au long du morceau
  const energies = [], floors = [];
  const hitAt = new Uint8Array(frames.length);
  let hits = 0;
  run(createFeel(), (o) => { hitAt[energies.length] = o.kickHit ? 1 : 0; energies.push(o.energy); floors.push(o.subFloor); if (o.kickHit) hits++; });
  const profile = {
    energyRef: Math.max(percentile(energies, 0.95), FX_ENERGY_FLOOR), // le passage fort, sans les pics isolés
    subRef: Math.max(percentile(floors, 0.95), FX_SUB_FLOOR),
    // Morceau rythmé (pop, rap, électro… : au moins 0,6 coup par seconde en moyenne, contre 0,2 au plus
    // pour un piano ou un orchestre) : la mélodie se lit sur son contour, les attaques y étant surtout
    // celles de la batterie. Sinon (piano, orchestre), les attaques des notes suffisent et sont plus justes.
    rhythmic: hits / (frames.length * dt) >= 0.6,
  };

  // Le style se décide aussi passage par passage (intro au piano puis entrée de la batterie, pont
  // sans percussions…) : densité de coups sur ±4 s, avec une marge pour ne pas basculer sans cesse
  // (passage rythmé au-delà de 0,9 coup/s, plus en dessous de 0,4). Chaque image le porte (levels.rhythmic).
  const half = Math.round(4 / dt);
  let count = 0, state = null;
  for (let i = 0; i < Math.min(half, frames.length); i++) count += hitAt[i];
  frames.forEach((levels, i) => {
    if (i + half < frames.length) count += hitAt[i + half];
    if (i - half - 1 >= 0) count -= hitAt[i - half - 1];
    const density = count / (Math.min(frames.length, i + half + 1) - Math.max(0, i - half)) / dt;
    state = state === null ? density >= 0.65 : state ? density >= 0.4 : density >= 0.9;
    levels.rhythmic = state;
  });

  // 2e passe avec ces références : la basse en contraste. Le halo s'allume quand la basse est plus
  // lourde que d'habitude POUR CE MORCEAU (au-delà de son 65e centile), pleinement à son 95e : en pop,
  // où une basse est presque toujours là, il marque les passages lourds au lieu de tourner sans cesse.
  const feel = createFeel();
  feel.reset(profile);
  const steady = [];
  run(feel, (o) => steady.push(o.steadyPressure));
  profile.bassFrom = percentile(steady, 0.65);
  // force d'une attaque frappée « nette » pour ce morceau (percussion générique, voir update)
  profile.percRef = percentile(frames.map((l) => l.logPerc ?? 0), 0.75);
  profile.bassTo = Math.max(percentile(steady, 0.95), profile.bassFrom + 0.2);
  return profile;
}

// ---------- Thèmes ----------
// Un thème change l'allure des effets (voir fx-themes.css), pas l'analyse.
// `colors` : couleurs propres au thème, pour un son sombre puis brillant ;
// null pour Aurore, qui prend celles de la pochette.

const FX_THEMES = {
  aurora: { label: 'Aurore', colors: null },
  neon: { label: 'Néon', colors: [[0, 229, 255], [255, 43, 214]] },
  ember: { label: 'Braise', colors: [[196, 42, 18], [255, 176, 64]] },
  mono: { label: 'Monochrome', colors: [[255, 255, 255], [255, 255, 255]], colorless: true },
};

const fxMix = (a, b, t) => a.map((c, i) => Math.round(c + (b[i] - c) * t));
const fxHex = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// Décale la teinte d'une couleur (degrés) et la ramène à une saturation et une clarté données.
function fxShift([r, g, b], degrees, saturation, lightness) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0;
  if (max !== min) {
    const d = max - min;
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  h = (h + degrees + 360) % 360;
  // Couleur presque grise (pochette en noir et blanc) : on garde le gris au lieu d'inventer une teinte
  const sat = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
  if (sat < 0.12) saturation = Math.min(saturation, sat);
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lightness - c / 2;
  const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r1, g1, b1].map((v) => Math.round((v + m) * 255));
}

// Couleur de départ choisie dans les réglages : celle de la pochette, une couleur libre,
// ou null pour garder les couleurs du thème.
function fxBaseColor(config, coverColor) {
  const theme = FX_THEMES[config.theme] || FX_THEMES.aurora;
  if (theme.colorless) return null;
  if (config.colorMode === 'custom') return fxHex(config.customColor);
  if (config.colorMode === 'cover' || !theme.colors) return coverColor;
  return null;
}

// Couleurs des effets pour un thème, une couleur de départ et la brillance du son (0 sombre, 1 brillant).
function fxPalette(themeName, base, brightness) {
  const theme = FX_THEMES[themeName] || FX_THEMES.aurora;
  const white = [255, 255, 255];
  if (theme.colorless) return { color: white, halo: white, accent: white, note: white };
  if (themeName === 'aurora') {
    // Plus claire quand le son est brillant, plus profonde quand il est sombre.
    const halo = base.map((c) => Math.round(c * (0.7 + 0.3 * brightness) + (255 - c) * 0.35 * brightness));
    // La basse prend une teinte voisine, plus froide : elle se distingue de la pulsation sur le bord.
    return { color: base, halo, accent: fxShift(base, -40, 0.7, 0.62), note: fxMix(halo, white, 0.3) };
  }
  // Néon et Braise vont d'une couleur sombre à une couleur brillante : celles du thème,
  // ou deux couleurs tirées de la couleur choisie.
  const [dark, bright] = !base ? theme.colors
    : themeName === 'neon' ? [fxShift(base, 0, 1, 0.55), fxShift(base, 75, 1, 0.6)]
    : [fxShift(base, -10, 0.85, 0.4), fxShift(base, 25, 1, 0.62)];
  const halo = fxMix(dark, bright, brightness);
  return themeName === 'neon'
    // liseré de la teinte du moment, jamais tout à fait celle du tube de la basse (couleur sombre)
    // et plus blanc, pour ressortir du halo de la même teinte dans les passages brillants
    ? { color: fxMix(fxMix(dark, bright, 0.4 + 0.6 * brightness), white, 0.3), halo, accent: dark, note: bright }
    // éclat ambré, braises rouge orangé ; notes plus claires que l'éclat qui part au même endroit
    // basse rouge sombre, nettement distincte de l'ambre du coup grave qui partage le bas
    : { color: bright, halo, accent: fxMix(dark, bright, 0.1), note: fxMix(bright, white, 0.45) };
}

// Pose les valeurs d'effets sur un élément .fx-surface (lecteur ou aperçu).
// `v` : { pulse, percHit, pressure, glow, noteLeft, noteRight, brightness } déjà dosés ;
// `base` : voir fxBaseColor.
function applyFx(el, themeName, base, v, now) {
  const p = fxPalette(themeName, base, v.brightness);
  el.style.setProperty('--fx-note-color', p.note.join(' '));
  // La voix : un large halo qui entre par la droite (la gauche est réservée au rythme), à chaque note,
  // qu'elle monte ou descende ; vif à l'attaque, il s'élargit en s'éteignant.
  const voice = Math.max(v.noteLeft, v.noteRight);
  el.style.setProperty('--fx-voice', voice.toFixed(3));
  el.style.setProperty('--fx-voice-reach', `${Math.round(40 + (1 - Math.min(1, voice)) * 25)}%`);
  // Mélodie de fond : la teinte du halo, plus profonde quand elle est sombre, plus claire quand elle brille
  // (une teinte décalée de celle du halo d'énergie, pour ne pas se confondre avec lui ni avec la basse)
  const melody = FX_THEMES[themeName]?.colorless ? [220, 220, 220] : fxShift(p.halo, 60, 0.7, 0.6);
  el.style.setProperty('--fx-melody', (v.melody || 0).toFixed(3));
  el.style.setProperty('--fx-melody-color', fxMix(fxMix(melody, [0, 0, 0], 0.35), fxMix(melody, [255, 255, 255], 0.55), v.melodyTone ?? 0.5).join(' '));
  el.dataset.fxTheme = FX_THEMES[themeName] ? themeName : 'aurora';
  el.style.setProperty('--fx-pulse', v.pulse.toFixed(3));
  el.style.setProperty('--fx-pulse-glow', v.pulseGlow.toFixed(3));
  el.style.setProperty('--fx-perc-hit', v.percHit.toFixed(3));
  el.style.setProperty('--fx-pressure', v.pressure.toFixed(3));
  el.style.setProperty('--fx-glow', v.glow.toFixed(3));
  el.style.setProperty('--fx-color', p.color.join(' '));
  el.style.setProperty('--fx-halo-color', p.halo.join(' '));
  // Basse tenue : la couleur chaude de la pochette, rendue lumineuse (blanc en Monochrome)
  const warm = FX_THEMES[themeName]?.colorless ? [255, 255, 255] : fxShift(v.warm || FX_WARM_FALLBACK, 0, 0.85, 0.62);
  el.style.setProperty('--fx-accent', warm.join(' '));
  // Pochette : sa lueur de percussion est de sa propre couleur, comme une lumière derrière l'image
  el.style.setProperty('--fx-cover-color', (v.coverColor || p.color).join(' '));
  // Vacillement des braises : sinusoïdes lentes et désaccordées, pour ne pas sembler mécanique.
  [[0.9, 1.7, 0], [1.3, 0.7, 2], [0.6, 2.3, 4]].forEach(([f1, f2, phase], i) => {
    const flicker = 0.5 + 0.3 * Math.sin(now * f1 * 2 * Math.PI + phase) + 0.2 * Math.sin(now * f2 * 2 * Math.PI + phase * 1.7);
    el.style.setProperty(`--fx-flicker-${'abc'[i]}`, flicker.toFixed(3));
  });
}

// Dose les effets selon les réglages (activé, intensité de chacun). Chacun a sa place dans le
// lecteur : ils se superposent sans s'atténuer.
// Sécurité (photosensibilité) : rien de grand ne clignote (la pochette, des traits fins, une teinte qui
// évolue lentement) ; au-delà de 5 coups par seconde (rare), les lueurs descendent à 60 %.
// Intensité d'un effet : jusqu'à 100 %, proportionnelle ; au-delà, une courbe qui renforce sans
// plafonner (les crans 0,6 / 0,8 / 1 restent distincts au lieu de tous valoir 1).
const fxLevel = (x, level) => (level <= 1 ? x * level : 1 - (1 - Math.min(1, x)) ** level);

// La pré-analyse lit le fichier tel quel ; l'effet sonore choisi change ce qu'on entend vraiment :
// les effets visuels suivent. Lo-fi : plus de grave sous 280 Hz (la basse tenue disparaît, le kick
// n'est plus qu'un claquement) ; basses renforcées : l'inverse. Karaoké : la voix est retirée, les notes
// viennent alors des seules attaques des instruments (voir trackTimeline).
const FX_SOUND_WEIGHTS = {
  lofi: { pulse: 0.7, pressure: 0 },
  bass: { pulse: 1.15, pressure: 1.3 },
};

function fxDose(fx, config) {
  const pulse = config.pulse ? fxLevel(fx.pulse, config.levels.pulse) : 0;
  const rate = fx.pulseRate || 0;
  // progressif plutôt qu'en bascule : un morceau qui oscille autour du seuil ne clignote pas
  const pulseGlow = 1 - 0.4 * smoothstep(4.5, 5, rate);
  const pressure = config.pressure ? fxLevel(fx.pressure, config.levels.pressure) : 0;
  const glow = config.halo ? fxLevel(fx.glow, config.levels.halo) : 0;
  const notes = config.notes ? config.levels.notes : 0;
  return {
    pulse, pulseGlow, pressure, glow, brightness: fx.brightness,
    // percussions (la pochette s'éclaire) avec le rythme
    percHit: config.pulse ? fxLevel(fx.pulseHigh || 0, config.levels.pulse) * pulseGlow : 0,
    // mélodie de fond (pistes séparées seulement) avec la voix, réglage « Voix et mélodie »
    melody: config.notes ? fxLevel(fx.melody || 0, config.levels.notes) * pulseGlow : 0,
    melodyTone: fx.melodyTone ?? 0.5,
    noteLeft: fxLevel(fx.noteLeft, notes), noteRight: fxLevel(fx.noteRight, notes),
  };
}

// Notes lues sur le contour de la mélodie (et non sur les attaques) : toujours sur la piste voix
// séparée (une voix glisse d'une note à l'autre sans attaque), jamais sur celle des autres instruments
// (leurs notes s'attaquent), et sur le mix dans les passages rythmés (les attaques y sont surtout celles
// de la batterie).
function fxContourNotes(useContour, profile, levels) {
  if (!useContour || profile?.stem === 'other') return false;
  return profile?.stem === 'vocals' || (levels.rhythmic ?? profile?.rhythmic);
}

// Version de l'analyse des pistes séparées : le cache disque est ignoré quand elle change.
const FX_STEMS_VERSION = 2;

// Canaux d'effets tirés des pistes séparées (voir createAmbiance) : chacun analysé à part, hors du fil
// de l'interface.
//   batterie → coups graves (pulse : la pochette saute) et aigus (pulseHigh : elle s'éclaire), pulseRate
//   voix     → halo gauche/droite (noteLeft/noteRight)
//   autres   → mélodie de fond (melody, haut et bas du lecteur ; melodyTone sa couleur, de la brillance)
//              et, pour le karaoké (voix retirée), les notes des instruments (noteLeftA/noteRightA)
//   basse    → basse tenue (pressure, le contour)
async function fxStemChannels(tracks) {
  const duration = tracks.drums.length / FX_PROFILE_RATE;
  const analyse = (name) => analyseChannelsOffThread([tracks[name]], duration, { stem: name });
  const drums = await analyse('drums'), vocals = await analyse('vocals'), other = await analyse('other'), bass = await analyse('bass');
  const out = {};
  if (drums?.timeline) for (const k of ['pulse', 'pulseHigh', 'pulseRate']) out[k] = drums.timeline[k];
  if (vocals?.timeline) for (const k of ['noteLeft', 'noteRight']) out[k] = vocals.timeline[k];
  if (other?.timeline) {
    const t = other.timeline;
    // Seules les nouvelles phrases et les accents ressortent : on retire le niveau de fond (suivi sur
    // ~1,5 s) et l'éclat retombe en ~0,25 s — sinon les instruments de fond allument le cadre en continu.
    const raw = Float32Array.from(t.noteLeft, (v, i) => Math.max(v, t.noteRight[i]));
    out.melody = new Float32Array(raw.length);
    for (let i = 0, base = 0, glow = 0; i < raw.length; i++) {
      base = follow(base, raw[i], FX_STEP, 1.5, 1.5);
      glow = Math.max(glow * Math.exp(-FX_STEP / 0.25), Math.min(1, 2 * Math.max(0, raw[i] - base)));
      out.melody[i] = glow;
    }
    out.melodyTone = t.brightness;
    out.noteLeftA = t.noteLeft;
    out.noteRightA = t.noteRight;
  }
  if (bass?.timeline) out.pressure = bass.timeline.pressure;
  return Object.keys(out).length ? out : null;
}

// `readFile(chemin)` renvoie le contenu du MP3 (ou null) pour la pré-analyse.
// `sound` : la chaîne audio partagée (sound.js), dont on analyse la sortie.
// `stems` (facultatif) : la séparation des instruments — { separate(chemin) → { drums, bass, other, vocals }
// (Float32Array mono à FX_PROFILE_RATE) ou null, get(chemin, version) / set(chemin, version, canaux) : le
// cache disque de ce qu'on en tire }.
function createAmbiance(audio, bar, readFile, sound, stems = null) {
  let config = {
    pulse: false, pressure: false, halo: false, notes: false,
    theme: 'aurora', colorMode: 'theme', customColor: '#ff7a3d',
    levels: { pulse: 1, pressure: 1, halo: 1, notes: 1 }, // intensité de chaque effet, de 0 à 1,5
    source: 'mix', // 'mix' : effets du morceau entier ; 'stems' : ceux des pistes séparées, si le morceau l'a été (separateNow)
    syncMs: 0, // avance (+) ou retard (−) des effets sur le son, réglée à l'oreille
  };
  let ctx = null;
  let analyser = null;
  let readFrame = null;
  let frame = 0;
  let last = 0;
  const feel = createFeel();
  const idle = { pulse: 0, pulseHigh: 0, melody: 0, melodyTone: 0.5, pulseRate: 0, pressure: 0, glow: 0, noteLeft: 0, noteRight: 0, brightness: 0.5 };
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let fx = idle;
  let lastEnergyRef = FX_ENERGY_FLOOR;
  let color = FX_FALLBACK_COLOR;
  let warm = fxWarmFrom(null); // couleur chaude de la pochette, pour la basse tenue
  let track = null;            // chemin du morceau en cours
  const profiles = new Map();  // chemin → profil (null : analyse impossible), pour ne pas réanalyser
  let analysing = false;

  const enabled = () => config.pulse || config.pressure || config.halo || config.notes;

  // Le son passe par Web Audio uniquement une fois les effets utilisés (voir sound.js).
  function ensureGraph() {
    if (ctx) return;
    ctx = sound.context();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.5;
    sound.output().connect(analyser);
    readFrame = createFrameReader(analyser, ctx.sampleRate);
  }

  // Le volume du lecteur s'applique avant l'analyse : on le compense pour que les effets
  // décrivent le morceau, pas la position du curseur de volume.
  const readLevels = () => readFrame(1 / Math.max(0.05, audio.volume));

  // Décalage de lecture de la chronologie pour un effet, en secondes du morceau. L'avance propre
  // à l'effet est déjà en temps du morceau ; les délais (sortie de la carte audio, retranchée ;
  // affichage, horloge et marge, ajoutés ; réglage à l'oreille) sont en temps réel : ils suivent
  // la vitesse de lecture (slowed, speed up).
  const shift = (key) => {
    const audioLatency = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
    const delays = FX_DISPLAY_LATENCY + FX_TARGET_ADVANCE - audioLatency + config.syncMs / 1000;
    return FX_LEAD[key] + clock + delays * audio.playbackRate; // l'horloge est mesurée en temps du morceau
  };

  // Recalage de l'horloge : le flux mesuré en direct est comparé à celui de la pré-analyse sur des
  // fenêtres de ~6 s ; le décalage qui les aligne le mieux est le retard réel de currentTime sur cette
  // machine (rééchantillonnage, tampons…). On garde la médiane des dernières mesures nettes.
  let clock = FX_CLOCK_OFFSET;
  let clockSettled = false; // 7 mesures concordantes à 8 ms près : on cesse de mesurer
  let lastClockSample = 0;
  const clockSamples = [];
  const clockEstimates = [];
  function calibrateClock(flux, now) {
    if (now - lastClockSample < FX_STEP * 0.9) return; // même cadence que la pré-analyse, même à 144 Hz
    lastClockSample = now;
    const time = audio.currentTime;
    const prevTime = clockSamples.length ? clockSamples[clockSamples.length - 1][0] : time;
    if (time < prevTime || time - prevTime > 0.2) clockSamples.length = 0; // saut dans le morceau
    clockSamples.push([time, readLevels().flux]);
    if (clockSamples.length < FX_CLOCK_WINDOW) return;
    const at = (t) => {
      const x = t / FX_STEP - 1, i = Math.floor(x);
      return i >= 0 && i + 1 < flux.length ? flux[i] + (flux[i + 1] - flux[i]) * (x - i) : 0;
    };
    const correlation = (a, b) => {
      const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
      let ab = 0, aa = 0, bb = 0;
      for (let i = 0; i < n; i++) { ab += (a[i] - ma) * (b[i] - mb); aa += (a[i] - ma) ** 2; bb += (b[i] - mb) ** 2; }
      return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
    };
    const live = clockSamples.map(([, v]) => v);
    const scores = [];
    for (let offset = -0.1; offset <= 0.1; offset += 0.004) scores.push([offset, correlation(live, clockSamples.map(([t]) => at(t + offset)))]);
    clockSamples.length = 0;
    const [bestOffset, best] = scores.reduce((a, b) => (b[1] > a[1] ? b : a));
    // Un motif régulier (roulement de charleston) donne plusieurs pics : il faut un pic net.
    const rival = Math.max(...scores.filter(([o]) => Math.abs(o - bestOffset) > 0.012).map(([, c]) => c));
    if (best < 0.5 || best - rival < 0.05) return; // passage trop calme ou trop régulier pour conclure
    clockEstimates.push(bestOffset);
    if (clockEstimates.length > 7) clockEstimates.shift();
    const sorted = [...clockEstimates].sort((a, b) => a - b);
    clock = sorted[sorted.length >> 1];
    clockSettled = sorted.length === 7 && sorted[6] - sorted[0] <= 0.008;
  }

  // En pause, les effets s'éteignent doucement (la brillance garde sa valeur).
  const fadeOut = (values, dt) => {
    const k = Math.exp(-dt / 0.25);
    return { ...values, pulse: values.pulse * k, pulseHigh: values.pulseHigh * k, melody: (values.melody || 0) * k, pulseRate: values.pulseRate * k, pressure: values.pressure * k, glow: values.glow * k, noteLeft: values.noteLeft * k, noteRight: values.noteRight * k };
  };

  // Un seul morceau analysé à la fois : si on enchaîne les morceaux, seul le dernier compte.
  async function requestProfile() {
    const path = track;
    // Déjà analysé (ou impossible à analyser) ; on réanalyse si sa chronologie a été libérée.
    const known = profiles.get(path);
    if (!path || !enabled() || analysing || (profiles.has(path) && (!known || known.timeline))) return;
    if (!(audio.duration > 0)) {
      audio.addEventListener('loadedmetadata', requestProfile, { once: true });
      return;
    }
    if (audio.duration > FX_PROFILE_MAX) return profiles.set(path, null);
    analysing = true;
    let profile = null;
    try {
      const data = await readFile(path);
      if (data) profile = await analyseTrackOffThread(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    } catch (err) {
      console.warn('Pré-analyse impossible :', err);
    }
    analysing = false;
    profiles.delete(path); // réinsérée en dernier : l'ordre de la table est celui des analyses
    profiles.set(path, profile);
    // Les chronologies pèsent ~0,5 Mo chacune : on ne garde que celles des derniers morceaux analysés,
    // et toujours celle du morceau en cours (sinon il serait réanalysé sans fin).
    const withTimeline = [...profiles].filter(([key, p]) => p && p.timeline && key !== track);
    for (const [, old] of withTimeline.slice(0, -FX_TIMELINES_KEPT)) { delete old.timeline; delete old.stemTimeline; delete old.flux; }
    if (profile) lastEnergyRef = profile.energyRef;
    if (path === track && profile) feel.setProfile(profile);
    if (profile) { applyStems(path); requestStems(path); }
    requestProfile(); // le morceau a peut-être changé entre-temps
  }

  // Effets tirés des pistes séparées. La séparation sollicite fortement le processeur (~0,5 × la durée
  // du morceau) : elle ne se fait qu'à la demande (separateNow), puis est gardée sur disque ; un morceau
  // déjà séparé retrouve ses pistes à chaque écoute. En attendant, ou sans séparation, les effets du mix.
  const stemTimelines = new Map(); // chemin → canaux tirés des pistes séparées (quelques centaines de Ko)
  const stemsAsked = new Set();     // lecture du disque ou séparation en cours
  const stemsWanted = new Set();    // séparation demandée par l'utilisateur
  const stemsSeparating = new Set();
  async function requestStems(path) {
    if (!stems || config.source !== 'stems' || stemsAsked.has(path) || stemTimelines.has(path)) return;
    stemsAsked.add(path);
    try {
      let channels = await stems.get(path, FX_STEMS_VERSION);
      if (!channels && stemsWanted.has(path)) {
        stemsSeparating.add(path);
        reportSource();
        const tracks = await stems.separate(path);
        channels = tracks && (await fxStemChannels(tracks));
        if (channels) stems.set(path, FX_STEMS_VERSION, channels);
      }
      if (channels) {
        stemTimelines.set(path, channels);
        applyStems(path);
      }
    } catch (err) {
      console.warn('Effets des pistes séparées impossibles :', err);
    }
    // finie, abandonnée (autre morceau) ou échouée : une nouvelle séparation devra être redemandée
    stemsAsked.delete(path);
    stemsSeparating.delete(path);
    stemsWanted.delete(path);
    reportSource();
  }

  // D'où viennent les effets du morceau en cours : 'stems' (pistes séparées), 'separating' (séparation
  // en cours) ou 'mix' (analyse du morceau entier). `onSource` est prévenu à chaque changement.
  let onSource = null, lastSource = null;
  function reportSource() {
    // « séparés » seulement quand leurs effets sont vraiment joués (il faut aussi la chronologie du mix)
    const source = config.source !== 'stems' ? 'mix' : profiles.get(track)?.stemTimeline ? 'stems' : stemsSeparating.has(track) ? 'separating' : 'mix';
    if (source !== lastSource) { lastSource = source; onSource?.(source); }
  }
  // Chronologie « pistes séparées » : celle du mix, dont les canaux tirés des pistes séparées sont
  // remplacés (gardée à côté : le réglage « Analyse des effets » passe de l'une à l'autre à tout moment).
  function applyStems(path) {
    const channels = stemTimelines.get(path), profile = profiles.get(path), timeline = profile?.timeline;
    if (!channels || !timeline) return;
    if (path === track) settle(); // les effets lents rejoignent les nouveaux en douceur
    profile.stemTimeline = { ...timeline };
    for (const [k, values] of Object.entries(channels)) {
      if (!timeline[k]) continue;
      const out = new Float32Array(timeline[k].length);
      out.set(values.subarray(0, out.length));
      profile.stemTimeline[k] = out;
    }
    reportSource();
  }

  // Lecture, déplacement dans le morceau, changement de morceau, arrivée de la pré-analyse : les
  // effets lents (énergie, basse, brillance) rejoignent leur nouvelle valeur en ~0,3 s au lieu de
  // sauter d'un coup ; les coups et les notes, eux, restent instantanés.
  let ease = 0, hadTimeline = false;
  const settle = () => { ease = 1; };
  audio.addEventListener('seeking', settle);

  function tick(t) {
    frame = requestAnimationFrame(tick);
    const now = t / 1000;
    const profile = profiles.get(track);
    const timeline = (config.source === 'stems' && profile?.stemTimeline) || profile?.timeline;
    if (Boolean(timeline) !== hadTimeline) { hadTimeline = Boolean(timeline); settle(); }
    const prev = fx;
    // Écran à 120/144 Hz : l'analyse en direct garde 60 mesures par seconde ; la chronologie, elle,
    // se lit à chaque image.
    if (!timeline && !audio.paused && last && now - last < FX_STEP * 0.9) return;
    const dt = Math.min(0.1, now - last || FX_STEP);
    last = now;
    if (audio.paused) {
      fx = fadeOut(fx, dt);
      feel.update(null, now, dt);
    } else if (timeline) {
      fx = readTimeline(timeline, audio.currentTime, shift);
      if (sound.effect() === 'karaoke' && timeline.noteLeftA) { fx.noteLeft = fx.noteLeftA; fx.noteRight = fx.noteRightA; }
      // la chronologie compte les coups par seconde du morceau : la vitesse de lecture les multiplie
      fx.pulseRate *= audio.playbackRate || 1;
      if (profile.flux && !clockSettled) calibrateClock(profile.flux, now);
    } else {
      fx = feel.update(readLevels(), now, dt);
    }
    if (ease > 0 && !audio.paused) {
      ease = Math.max(0, ease - dt / 0.8);
      fx = { ...fx };
      for (const k of ['glow', 'pressure', 'brightness', 'melody']) fx[k] = follow(prev[k] || 0, fx[k] || 0, dt, 0.3, 0.3);
    }
    render(dt);
    const faded = ['pulse', 'pulseHigh', 'melody', 'pressure', 'glow', 'noteLeft', 'noteRight'].every((k) => !(fx[k] >= 0.005));
    if (audio.paused && faded) stop();
  }

  // Les effets couvrent tout le lecteur : fx-themes.css lit ces valeurs sur #bar.
  // Mouvements réduits : la pulsation devient un fondu (montée ~60 ms, retombée ~200 ms) plutôt
  // qu'un flash, qui retombe quand même entre deux coups pour que le rythme reste lisible.
  let shownPulse = 0, shownHigh = 0, shownMelody = 0, shownGlow = 1;
  function render(dt = FX_STEP) {
    const v = fxDose(fx, config);
    // La sécurité change en douceur (~0,4 s), jamais d'une image à l'autre
    v.pulseGlow = shownGlow = follow(shownGlow, v.pulseGlow, dt, 0.4, 0.4);
    const weights = FX_SOUND_WEIGHTS[sound.effect()] || {};
    if (weights.pulse) v.pulse = fxLevel(v.pulse, weights.pulse);
    if (weights.pressure !== undefined) v.pressure = fxLevel(v.pressure, weights.pressure);
    if (reducedMotion.matches) {
      v.pulse = shownPulse = follow(shownPulse, v.pulse, dt, 0.06, 0.2);
      v.percHit = shownHigh = follow(shownHigh, v.percHit, dt, 0.06, 0.15);
      v.melody = shownMelody = follow(shownMelody, v.melody, dt, 0.06, 0.2);
    }
    v.warm = warm;
    v.coverColor = color;
    applyFx(bar, config.theme, fxBaseColor(config, color), v, performance.now() / 1000);
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
    fx = idle;
    shownPulse = shownHigh = shownMelody = 0;
    render();
  }

  audio.addEventListener('play', () => {
    if (ctx && ctx.state === 'suspended') ctx.resume();
    settle();
    start();
  });
  return {
    setConfig(next) {
      const sourceChanged = next.source && next.source !== config.source;
      config = { ...config, ...next };
      if (sourceChanged) {
        settle(); // les effets lents passent d'une analyse à l'autre en douceur
        if (profiles.get(track)?.timeline) { applyStems(track); requestStems(track); }
        reportSource();
      }
      if (enabled()) {
        start();
        requestProfile();
      } else {
        stop();
      }
    },

    // Retard d'horloge retenu et mesures récentes (secondes), pour vérification.
    clock() {
      return { clock, estimates: [...clockEstimates] };
    },

    // Nouveau morceau : ses références si on les connaît déjà, sinon on repart de zéro
    // en attendant la pré-analyse.
    setTrack(path) {
      // une séparation en cours pour un autre morceau est abandonnée (elle occupe le processeur)
      if ([...stemsSeparating].some((p) => p !== path)) stems?.cancel?.();
      track = path;
      settle();
      const known = profiles.get(path);
      if (known) { profiles.delete(path); profiles.set(path, known); } // rejoué : le plus récent du cache
      // Pas encore analysé : la référence d'énergie part de celle du dernier morceau (sinon une intro
      // calme brillerait à fond le temps de la pré-analyse).
      feel.reset(known || null, lastEnergyRef);
      if (known) lastEnergyRef = known.energyRef;
      requestProfile();
      if (known?.timeline) { applyStems(path); requestStems(path); } // morceau déjà analysé, séparation à reprendre
      reportSource();
    },

    // Séparation des instruments du morceau en cours, à la demande de l'utilisateur (voir requestStems).
    // Si la lecture du disque est déjà en cours, la séparation suivra si elle n'y trouve rien.
    separateNow() {
      if (!track) return;
      stemsWanted.add(track);
      requestStems(track);
    },

    // `fn(source)` : prévenu quand la source des effets du morceau en cours change (voir reportSource).
    onSource(fn) {
      onSource = fn;
      lastSource = null;
      reportSource();
    },

    // Couleur des effets : teinte dominante de la pochette, ou celle par défaut.
    // Renvoie la couleur retenue (pour les aperçus de la fenêtre de personnalisation).
    setColor(img) {
      color = img ? dominantColor(img) : FX_FALLBACK_COLOR;
      warm = img ? warmColor(img) : fxWarmFrom(null);
      render();
      return color;
    },
  };
}

// Moyenne des pixels pondérée par la saturation, puis éclaircie : un halo doit rester lumineux.
// Teinte (degrés), saturation et luminosité d'une couleur [r, g, b] (0–255).
function fxHsl([r, g, b]) {
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255, l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const h = max === R ? ((G - B) / d + (G < B ? 6 : 0)) * 60 : max === G ? ((B - R) / d + 2) * 60 : ((R - G) / d + 4) * 60;
  return [h, s, l];
}

// Tons chauds : rouges, orangés, ors (et les roses tirant vers le rouge)
const fxIsWarm = (h) => h >= 330 || h < 60;
const FX_WARM_FALLBACK = [255, 176, 96]; // ambre doux, pour une pochette sans aucun ton chaud

// Couleur chaude d'une couleur donnée (la dominante de la pochette, faute de mieux) : elle-même si elle est
// chaude, sinon l'ambre par défaut.
function fxWarmFrom(color) {
  if (!color) return FX_WARM_FALLBACK;
  const [h, s] = fxHsl(color);
  return s > 0.15 && fxIsWarm(h) ? color : FX_WARM_FALLBACK;
}

// La couleur chaude la plus présente sur la pochette (pixels rouges, orangés, dorés, pondérés par leur
// éclat), ou celle de fxWarmFrom s'il n'y en a presque pas.
function warmColor(img) {
  const size = 16;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, size, size);
  const data = g.getImageData(0, 0, size, size).data;
  let r = 0, gr = 0, b = 0, total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [h, s, l] = fxHsl([data[i], data[i + 1], data[i + 2]]);
    if (!fxIsWarm(h) || s < 0.2 || l < 0.12) continue;
    const w = s * s * l;
    r += data[i] * w; gr += data[i + 1] * w; b += data[i + 2] * w; total += w;
  }
  if (total < 0.5) return fxWarmFrom(dominantColor(img)); // quelques pixels seulement : pas assez pour être la couleur de la pochette
  return [r / total, gr / total, b / total].map(Math.round);
}

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
