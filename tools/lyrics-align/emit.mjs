// Calcule et met en cache les probabilités (em/<nom>.f32) de chaque PCM donné ; affiche le temps.
import fs from 'fs'; import path from 'path'; import { emissions, load } from './align.mjs';
const ep = process.env.EP || 'dml';
await load(ep);
for (const f of process.argv.slice(2)) {
  const out = path.join('em', path.basename(f).replace(/\.f32$/, '.em'));
  if (fs.existsSync(out)) continue;
  const buf = fs.readFileSync(f); const pcm = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const t = Date.now();
  const { T, logp } = await emissions(pcm);
  fs.writeFileSync(out, Buffer.from(logp.buffer));
  console.log(path.basename(f), (pcm.length / 16000).toFixed(0) + ' s audio', ((Date.now() - t) / 1000).toFixed(1) + ' s calcul');
}
