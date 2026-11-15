import { fetchSyncedLyrics, sanitize } from '../src/lyrics.js';

const songs = [
  { artist: 'Tulus', title: 'Monokrom' },
  { artist: 'Coldplay', title: 'Viva la Vida' },
  { artist: 'Queen', title: 'Bohemian Rhapsody' },
];

let fail = 0;
for (const s of songs) {
  try {
    const r = await fetchSyncedLyrics(s);
    const lines = sanitize(r.lines);
    console.log(`OK  ${s.artist} - ${s.title}: ${lines.length} lines, source=${r.source}`);
    console.log('    ' + lines.slice(0, 3).map((l) => `${l.time.toFixed(2)}s "${l.text}"`).join(' | '));
  } catch (e) {
    fail++;
    console.log(`ERR ${s.artist} - ${s.title}: ${e.message}`);
  }
}
process.exit(fail ? 1 : 0);
