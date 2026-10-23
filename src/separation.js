// Séparation des instruments (processus principal) : HT-Demucs, un réseau de neurones entraîné à
// séparer un morceau en quatre pistes (batterie, basse, autres, voix). Chaque effet visuel lit alors la
// sienne : les coups sur la batterie (une syllabe ne passe plus pour une caisse claire), la voix sur la
// voix, la mélodie de fond sur les autres instruments, la basse tenue sur la basse.
//
// Le morceau est décodé par ffmpeg (44,1 kHz, stéréo), puis traité par segments de 7,8 s qui se
// chevauchent d'un quart (fondu enchaîné), comme l'implémentation de référence. Environ 0,4 × la
// durée du morceau sur un processeur récent. Pas de carte graphique (DirectML) : sur certains pilotes
// le calcul échoue en laissant le pilote dans un état douteux.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const RATE = 44100;
const SEGMENT = Math.floor(7.8 * RATE); // 343 980 échantillons : la taille fixe d'entrée du modèle
const OVERLAP = SEGMENT >> 2;
const STRIDE = SEGMENT - OVERLAP;
const OUT_RATE = 22050;                 // les pistes sont rendues en mono à 22,05 kHz (celle de la pré-analyse)
const MAX_SECONDS = 10 * 60;            // au-delà, pas de séparation (mémoire, durée)

let ort = null;
let session = null;   // chargée une fois, à la première séparation

// Le modèle n'est pas dans l'archive de l'application (trop gros) : à côté, dans resources/models.
function modelPath(app) {
  const packaged = path.join(process.resourcesPath || '', 'models', 'htdemucs.onnx');
  if (app.isPackaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', 'models', 'htdemucs.onnx');
}

async function loadSession(app) {
  if (session) return session;
  ort ??= require('onnxruntime-node');
  const file = modelPath(app);
  if (!fs.existsSync(file)) throw new Error(`modèle introuvable : ${file}`);
  // Laisse deux cœurs libres : la lecture et l'interface ne doivent pas saccader.
  const options = { graphOptimizationLevel: 'all', intraOpNumThreads: Math.max(1, os.cpus().length - 2) };
  session = await ort.InferenceSession.create(file, { ...options, executionProviders: ['cpu'] });
  return session;
}

// Décode un fichier audio en stéréo 44,1 kHz : [gauche, droite] (Float32Array).
function decode(ffmpeg, file) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', String(RATE), 'pipe:1'], { windowsHide: true });
    const chunks = [];
    let errors = '';
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => { errors += c; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg (${code}) : ${errors.trim()}`));
      const buf = Buffer.concat(chunks);
      const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
      const n = all.length >> 1, left = new Float32Array(n), right = new Float32Array(n);
      for (let i = 0; i < n; i++) { left[i] = all[2 * i]; right[i] = all[2 * i + 1]; }
      resolve([left, right]);
    });
  });
}

const STEMS = ['drums', 'bass', 'other', 'vocals']; // l'ordre des sorties du modèle

// Les quatre pistes d'un fichier : { drums, bass, other, vocals }, chacune Float32Array mono à OUT_RATE.
// `isCancelled()` permet d'abandonner entre deux segments (morceau changé).
async function separateStems(app, ffmpeg, file, isCancelled = () => false) {
  const sess = await loadSession(app);
  const [left, right] = await decode(ffmpeg, file);
  const total = left.length;
  if (total > MAX_SECONDS * RATE) throw Object.assign(new Error('morceau trop long'), { tooLong: true });
  const fade = new Float32Array(SEGMENT).fill(1);
  for (let i = 0; i < OVERLAP; i++) fade[i] = fade[SEGMENT - 1 - i] = i / (OVERLAP - 1);
  // Accumulés directement en mono à 22,05 kHz (deux échantillons de 44,1 kHz par case) : 4 fois moins
  // de mémoire que les pistes stéréo complètes.
  const n = total >> 1;
  const sums = STEMS.map(() => new Float32Array(n + 1)), weight = new Float32Array(n + 1);
  const input = new Float32Array(2 * SEGMENT);
  const chunks = Math.max(1, Math.ceil(total / STRIDE));
  for (let c = 0; c < chunks; c++) {
    if (isCancelled()) return null;
    const start = c * STRIDE, len = Math.min(SEGMENT, total - start);
    if (len <= 0) break;
    input.fill(0);
    input.set(left.subarray(start, start + len), 0);
    input.set(right.subarray(start, start + len), SEGMENT);
    const out = await sess.run({ mix: new ort.Tensor('float32', input, [1, 2, SEGMENT]) });
    const data = out.stems.data; // (1, 4, 2, SEGMENT) : batterie, basse, autres, voix ; mono = moyenne des canaux
    for (let k = 0; k < STEMS.length; k++) {
      const l = 2 * k * SEGMENT, r = l + SEGMENT, sum = sums[k];
      for (let i = 0; i < len; i++) sum[(start + i) >> 1] += 0.5 * (data[l + i] + data[r + i]) * fade[i];
    }
    for (let i = 0; i < len; i++) weight[(start + i) >> 1] += fade[i];
  }
  return Object.fromEntries(STEMS.map((name, k) => {
    const sum = sums[k], mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = sum[i] / Math.max(weight[i], 1e-8);
    return [name, mono];
  }));
}

module.exports = { separateStems, OUT_RATE, MAX_SECONDS };
