// Décode chaque fichier en PCM 16 kHz mono float32 (cache pcm/<nom>.f32)
import { spawnSync } from 'child_process'; import fs from 'fs'; import path from 'path';
import { createRequire } from 'module';
const ffmpeg = createRequire(new URL('../../package.json', import.meta.url))('ffmpeg-static');
const files = process.argv.slice(2);
for (const f of files) {
  const out = path.join('pcm', path.basename(f).replace(/\.[^.]+$/, '') + '.f32');
  if (fs.existsSync(out)) continue;
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', f, '-ac', '1', '-ar', '16000', '-f', 'f32le', out]);
  if (r.status) console.error(f, r.stderr.toString());
}
