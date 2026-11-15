import { buildSlideVideo, pickFont, ffprobeDuration } from './slides.js';

export { pickFont, ffprobeDuration };

/**
 * Render a lyric video (mp4) from timestamped LRC lines.
 * The implementation lives in slides.js: the background is rendered once, every
 * line becomes one PNG, then everything is concatenated and encoded in a single
 * pass together with the audio on the same timeline.
 */
export function renderLyricVideo(o) {
  return buildSlideVideo({
    lines: o.lines,
    out: o.out,
    title: o.title,
    artist: o.artist,
    cover: o.cover,
    audio: o.audio,
    duration: o.duration,
    offsetMs: o.offsetMs || 0,
    width: o.width || 1280,
    height: o.height || 720,
    fps: o.fps || 30,
    font: o.font,
    accent: o.accent || '8b5cf6',
    crf: o.crf,
    preset: o.preset,
    concurrency: o.concurrency,
    slideCacheDir: o.slideCacheDir,
  });
}
