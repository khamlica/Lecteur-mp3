// Effets sonores appliqués à l'écoute : le fichier n'est jamais modifié.
// Le son de l'élément audio passe par une chaîne Web Audio partagée (entrée → effet → sortie) ;
// l'analyse des effets d'ambiance se branche sur la sortie, donc sur ce qu'on entend.

// ---------- Briques ----------

// Réponse impulsionnelle synthétique : bruit stéréo qui décroît, comme les réflexions d'une pièce.
function impulse(ctx, seconds, decay, preDelay) {
  const rate = ctx.sampleRate;
  const start = Math.floor(rate * preDelay);
  const length = start + Math.floor(rate * seconds);
  const buffer = ctx.createBuffer(2, length, rate);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = start; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - (i - start) / (length - start), decay);
    }
  }
  return buffer;
}

// Chaque effet crée ses nœuds via `kit` : ils sont tous libérés quand on change d'effet.
function createKit(ctx) {
  const nodes = [];
  const add = (node) => (nodes.push(node), node);
  const kit = {
    own: add, // pour les nœuds créés directement par un effet
    gain(value) {
      const g = add(ctx.createGain());
      g.gain.value = value;
      return g;
    },
    filter(type, frequency, extra = {}) {
      const f = add(ctx.createBiquadFilter());
      f.type = type;
      f.frequency.value = frequency;
      if (extra.gain != null) f.gain.value = extra.gain;
      if (extra.q != null) f.Q.value = extra.q;
      return f;
    },
    compressor(threshold, ratio, { knee = 6, attack = 0.003, release = 0.25 } = {}) {
      const c = add(ctx.createDynamicsCompressor());
      c.threshold.value = threshold;
      c.ratio.value = ratio;
      c.knee.value = knee;
      c.attack.value = attack;
      c.release.value = release;
      return c;
    },
    // Évite la saturation quand un effet ajoute du niveau. (Un compresseur Web Audio remonte
    // lui-même le niveau après coup : le seuil tient compte de cette compensation.)
    limiter: () => kit.compressor(-4, 20, { knee: 0, attack: 0.002, release: 0.15 }),
    // Son direct + son réverbéré, mélangés dans `output`
    reverb(input, output, { seconds, decay, preDelay = 0.01, dry, wet, tone }) {
      const conv = add(ctx.createConvolver());
      conv.buffer = impulse(ctx, seconds, decay, preDelay);
      input.connect(kit.gain(dry)).connect(output);
      input.connect(conv).connect(kit.filter('lowpass', tone)).connect(kit.gain(wet)).connect(output);
    },
    lfo(frequency, depth, param) {
      const osc = add(ctx.createOscillator());
      osc.frequency.value = frequency;
      osc.connect(kit.gain(depth)).connect(param);
      osc.start();
    },
    dispose() {
      for (const node of nodes) {
        if (node instanceof OscillatorNode) node.stop();
        node.disconnect();
      }
    },
  };
  return kit;
}

// ---------- Effets ----------

// `rate` : vitesse de lecture, hauteur comprise (comme un disque accéléré ou ralenti).
// `build(kit, input, output, ctx)` : chaîne Web Audio de l'effet.
const SOUND_EFFECTS = {
  none: {},

  room: {
    build: (k, input, output) =>
      k.reverb(input, output, { seconds: 1.4, decay: 3.5, dry: 1, wet: 0.35, tone: 6000 }),
  },

  cathedral: {
    build: (k, input, output) =>
      k.reverb(input, output, { seconds: 5, decay: 2.4, preDelay: 0.03, dry: 0.75, wet: 0.7, tone: 3500 }),
  },

  slowed: {
    rate: 0.85,
    build: (k, input, output) =>
      k.reverb(input, output, { seconds: 3.2, decay: 2.6, preDelay: 0.02, dry: 0.85, wet: 0.55, tone: 4500 }),
  },

  speedup: { rate: 1.25 },

  bass: {
    build: (k, input, output) => {
      input.connect(k.filter('lowshelf', 120, { gain: 9 })).connect(k.gain(0.8)).connect(k.limiter()).connect(output);
    },
  },

  // Le son fait le tour de la tête en ~12 s, avec un peu d'espace autour
  '8d': {
    build: (k, input, output, ctx) => {
      // Sur un côté, le panoramique additionne les deux canaux : on baisse avant, on limite après
      const panner = k.own(ctx.createStereoPanner());
      const mix = k.gain(1);
      k.lfo(1 / 12, 0.9, panner.pan);
      input.connect(k.gain(0.7)).connect(panner);
      k.reverb(panner, mix, { seconds: 1.8, decay: 3, dry: 1, wet: 0.25, tone: 5000 });
      mix.connect(k.limiter()).connect(output);
    },
  },

  echo: {
    build: (k, input, output, ctx) => {
      const delay = k.own(ctx.createDelay(1));
      delay.delayTime.value = 0.33;
      input.connect(k.gain(1)).connect(output);
      input.connect(delay);
      // Chaque répétition est un peu plus sourde, comme un écho à bande
      delay.connect(k.filter('lowpass', 3500)).connect(k.gain(0.38)).connect(delay);
      delay.connect(k.gain(0.45)).connect(output);
    },
  },

  // Bande étroite et légère saturation, comme un vieux poste
  lofi: {
    build: (k, input, output, ctx) => {
      const shaper = k.own(ctx.createWaveShaper());
      const curve = new Float32Array(1024);
      // Gain 1 sur les sons faibles, arrondi progressif des crêtes
      for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(2 * (i / (curve.length - 1) * 2 - 1)) / 2;
      shaper.curve = curve;
      shaper.oversample = '2x';
      input
        .connect(k.filter('highpass', 280, { q: 0.7 }))
        .connect(k.filter('lowpass', 3200, { q: 0.7 }))
        .connect(shaper)
        .connect(k.gain(0.9))
        .connect(k.limiter())
        .connect(output);
    },
  },

  // Les passages forts sont baissés et les faibles remontés : écoute à bas volume sans sursaut
  night: {
    build: (k, input, output) => {
      // Le compresseur remonte déjà le niveau de lui-même : on le ramène à celui de l'original
      input.connect(k.compressor(-32, 8, { knee: 24, attack: 0.005, release: 0.3 }))
        .connect(k.gain(0.75))
        .connect(k.limiter())
        .connect(output);
    },
  },

  // La voix est en général au centre : on retire ce qui est commun aux deux canaux (G − D),
  // en gardant les basses, elles aussi au centre. Sans effet utile sur un enregistrement mono.
  karaoke: {
    build: (k, input, output, ctx) => {
      const splitter = k.own(ctx.createChannelSplitter(2));
      const side = k.gain(1);
      input.connect(splitter);
      splitter.connect(k.gain(1), 0).connect(side);
      splitter.connect(k.gain(-1), 1).connect(side);
      side.connect(k.filter('highpass', 150)).connect(output);
      input.connect(k.filter('lowpass', 150)).connect(output);
    },
  },
};

// ---------- Chaîne ----------

function createSound(audio) {
  let ctx = null;
  let input = null;
  let output = null;
  let kit = null;
  let name = 'none';

  // Le branchement sur Web Audio est définitif pour l'élément audio : on ne le fait
  // qu'une fois un effet (sonore ou d'ambiance) réellement utilisé.
  function ensure() {
    if (ctx) return;
    ctx = new AudioContext();
    input = ctx.createMediaElementSource(audio);
    output = ctx.createGain();
    output.connect(ctx.destination);
    connect();
  }

  function connect() {
    if (kit) kit.dispose();
    input.disconnect();
    const effect = SOUND_EFFECTS[name];
    if (effect.build) {
      kit = createKit(ctx);
      effect.build(kit, input, output, ctx);
    } else {
      kit = null;
      input.connect(output);
    }
  }

  return {
    context() {
      ensure();
      return ctx;
    },

    // Effet en cours (clé de SOUND_EFFECTS)
    effect() {
      return name;
    },

    output() {
      ensure();
      return output;
    },

    setEffect(next) {
      name = SOUND_EFFECTS[next] ? next : 'none';
      const { rate, build } = SOUND_EFFECTS[name];
      // defaultPlaybackRate : la vitesse est gardée d'un morceau à l'autre
      audio.preservesPitch = !rate;
      audio.defaultPlaybackRate = audio.playbackRate = rate || 1;
      if (!ctx && !build) return;
      ensure();
      if (ctx.state === 'suspended') ctx.resume();
      connect();
    },
  };
}
