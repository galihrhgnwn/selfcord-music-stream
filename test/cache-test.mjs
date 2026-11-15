import fs from 'node:fs';
import { buildSlideVideo } from '../src/slides.js';
import { loadLrcFile, sanitize } from '../src/lyrics.js';

// Proves that changing the lyric offset does not re-render the slides (re-mux only),
// so w/sync stays fast and does not hammer the CPU.
const lines = sanitize(loadLrcFile('test/test.lrc').lines);
const slideCacheDir = 'cache/slides/cache-test';
fs.rmSync(slideCacheDir, { recursive: true, force: true });

const base = {
  lines,
  title: 'Cache Test',
  artist: 'Test',
  audio: 'test/song.mp3',
  width: 640,
  height: 360,
  fps: 15,
  concurrency: 4,
  slideCacheDir,
};

let t = Date.now();
const a = await buildSlideVideo({ ...base, out: 'out/cache-a.mp4', offsetMs: 0 });
const d1 = Date.now() - t;

t = Date.now();
const b = await buildSlideVideo({ ...base, out: 'out/cache-b.mp4', offsetMs: 700 });
const d2 = Date.now() - t;

const crypto = await import('node:crypto');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16);
const out = {
  build1_ms: d1,
  build2_ms: d2,
  slides_reused_1: a.slidesReused,
  slides_reused_2: b.slidesReused,
  dur_audio_1: Number(a.duration.toFixed(2)),
  dur_audio_2: Number(b.duration.toFixed(2)),
  kb_a: Math.round(fs.statSync('out/cache-a.mp4').size / 1024),
  kb_b: Math.round(fs.statSync('out/cache-b.mp4').size / 1024),
  files_differ: sha('out/cache-a.mp4') !== sha('out/cache-b.mp4'),
};
console.log(JSON.stringify(out, null, 2));

const ok =
  a.slidesReused === false &&
  b.slidesReused === true &&
  d2 < d1 * 0.9 &&
  out.files_differ &&
  Math.abs(a.duration - b.duration) < 0.05;
console.log(ok ? '\nPASS slides are reused and the output still changes when the offset moves' : '\nFAIL the slide cache did not behave as expected');
process.exit(ok ? 0 : 1);
