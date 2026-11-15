// Tests the media path without Discord: ffmpeg -> nut -> demuxer (node-av)
import { prepareStream, demux } from '@dank074/discord-video-stream';
import fs from 'node:fs';

const file = process.argv[2] || 'out/lyrics.mp4';
if (!fs.existsSync(file)) {
  console.error(`No such file: ${file}\nRender one first: node src/index.js build`);
  process.exit(1);
}
const t0 = Date.now();

const { command, output, promise } = prepareStream(file, {
  width: 1280,
  height: 720,
  frameRate: 30,
  bitrateVideo: 3000,
  bitrateVideoMax: 4000,
  bitrateAudio: 128,
  includeAudio: true,
  videoCodec: 'H264',
  logLevel: 'error',
});

let failed = null;
command.on('error', (err, _o, stderr) => {
  failed = String(stderr || err?.message || err);
  console.error('FFMPEG ERROR:', failed.slice(-1500));
});
output.on('data', () => {});
promise.catch((e) => console.error('promise rejected:', e?.message || e));

const timeout = setTimeout(() => {
  console.error('TIMEOUT: demux did not finish within 20s');
  process.exit(2);
}, 20000);

try {
  const { video, audio } = await demux(output, { format: 'nut' });
  clearTimeout(timeout);
  console.log('DEMUX OK in', Date.now() - t0, 'ms');
  console.log('  video:', { codec: video?.codec, w: video?.width, h: video?.height, fps: `${video?.framerate_num}/${video?.framerate_den}` });
  console.log('  audio:', audio ? { codec: audio.codec, channels: audio.channels, rate: audio.sample_rate } : null);
} catch (e) {
  clearTimeout(timeout);
  console.error('DEMUX FAILED:', e?.message || e);
  if (failed) console.error('stderr tail:', failed.slice(-1200));
  process.exitCode = 1;
} finally {
  try { output.destroy(); } catch {}
  try { command.kill?.(); } catch {}
  setTimeout(() => process.exit(process.exitCode || 0), 300);
}
