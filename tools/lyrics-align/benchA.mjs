import { loadSongs } from './jamendo.mjs'; import { score, summary } from './metrics.mjs'; import { spread } from './spread.mjs';
const songs = loadSongs();
const asLrc = (s) => s.lines.map((l, i) => ({ start: l.start, next: s.lines[i + 1]?.start ?? null, words: l.words.map((w) => w.text) }));
for (const opts of [{}, { maxSyl: 0.5 }, { maxSyl: 0.4 }, { maxSyl: 0.3 }, { maxSyl: 0.25 }]) {
  const res = songs.map((s) => score(s.lines, spread(asLrc(s), opts)));
  console.log(JSON.stringify(opts).padEnd(16), summary(res));
}
