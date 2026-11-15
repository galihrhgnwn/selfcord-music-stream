import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { prepareStream, playStream } from '@dank074/discord-video-stream';
import { buildSlideVideo, ffprobeDuration } from './slides.js';
import { loadLrcFile, fetchSyncedLyrics, sanitize } from './lyrics.js';
import { resolveAudio } from './resolve.js';

const hash = (...parts) => crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);

/**
 * One player per process. It keeps the state of the song currently on air,
 * builds the lyric video (with caching), then sends it as a Go Live stream.
 */
export class Player {
  constructor({ client, streamer, cfg, log = console.log }) {
    this.client = client;
    this.streamer = streamer;
    this.cfg = cfg;
    this.log = log;
    this.gen = 0;
    this.guildId = cfg.guildId || null;
    this.state = {
      track: null,
      audio: null,
      lyrics: null,
      video: null,
      channelId: null,
      offsetMs: Number(cfg.lyricOffsetMs || 0),
      startedAt: null,
      playing: false,
    };
  }

  get playing() {
    return this.state.playing;
  }

  cacheDir(sub) {
    const dir = path.resolve(this.cfg.__dir, this.cfg.cache?.[sub] || `cache/${sub}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async lyricsFor(track, duration) {
    if (this.cfg.lyricsFile) {
      const raw = this.cfg.lyricsFile;
      const file = path.isAbsolute(raw) ? raw : path.resolve(this.cfg.__dir, raw);
      if (!fs.existsSync(file)) throw new Error(`lyricsFile does not exist: ${file}`);
      const parsed = loadLrcFile(file);
      parsed.lines = sanitize(parsed.lines);
      if (!parsed.lines.length) throw new Error('the .lrc file has no timestamped lines');
      parsed.source = 'lrc-file';
      return parsed;
    }
    const parsed = await fetchSyncedLyrics({
      title: track.title,
      artist: track.artists?.[0] || track.artist,
      album: track.album,
      duration,
    });
    if (!parsed) throw new Error(`no synced lyrics found for "${track.title}"`);
    parsed.lines = sanitize(parsed.lines);
    if (!parsed.lines.length) throw new Error('the lyrics returned by lrclib were empty');
    return parsed;
  }

  /** Build the mp4 (lyric video + audio), using the slide cache and video cache. */
  async ensureVideo(track, audio, parsed, onStatus, { force = false } = {}) {
    const W = this.cfg.video?.width || 1280;
    const H = this.cfg.video?.height || 720;
    const FPS = this.cfg.video?.fps || 30;
    const accent = this.cfg.accent || '8b5cf6';
    const title = track.title;
    const artist = track.artists?.join(', ') || track.artist || '';

    const slidesKey = hash(
      parsed.lines.map((l) => `${l.time.toFixed(2)}:${l.text}`).join('\n'),
      title,
      artist,
      accent,
      W,
      H,
      this.cfg.font || '',
    );
    const videoKey = `${hash(String(track.id || title), String(this.state.offsetMs), slidesKey, String(FPS))}.mp4`;
    const out = path.join(this.cacheDir('video'), videoKey);
    const slideCacheDir = path.join(this.cacheDir('slides'), slidesKey);

    const audioDur = audio.duration || ffprobeDuration(audio.file);
    const duration = this.cfg.video?.duration || audioDur || undefined;

    if (!force && fs.existsSync(out) && fs.statSync(out).size > 10000) {
      const first = parsed.lines[0]?.time ?? 0;
      onStatus?.('using a previously built video (cache)');
      return { file: out, duration: duration || (parsed.lines.at(-1)?.time ?? 0) + 4, slidesKey, cached: true, firstLine: first };
    }

    onStatus?.(`rendering lyrics (${parsed.lines.length} lines) for ${Math.round(duration || 0)}s of audio`);
    const res = await buildSlideVideo({
      lines: parsed.lines,
      out,
      title,
      artist,
      cover: audio.coverFile,
      audio: audio.file,
      duration,
      offsetMs: this.state.offsetMs,
      width: W,
      height: H,
      fps: FPS,
      font: this.cfg.font ? (path.isAbsolute(this.cfg.font) ? this.cfg.font : path.resolve(this.cfg.__dir, this.cfg.font)) : undefined,
      accent,
      crf: this.cfg.video?.crf,
      preset: this.cfg.video?.preset,
      concurrency: this.cfg.video?.concurrency,
      slideCacheDir,
    });
    return { ...res, file: out, slidesKey, cached: false };
  }

  async ensureVoice(channelId, guildId) {
    if (guildId) this.guildId = guildId;
    if (this.state.channelId === channelId && this.streamer.voiceConnection) return;
    if (this.streamer.voiceConnection) {
      try {
        this.streamer.stopStream();
        await this.streamer.leaveVoice();
      } catch {}
    }
    await this.streamer.joinVoice(this.guildId, channelId);
    this.state.channelId = channelId;
  }

  async play({ track, channelId, guildId, onStatus, force = false }) {
    const gen = ++this.gen;
    const ok = () => gen === this.gen;
    const st = (m) => ok() && onStatus?.(m);

    if (this.streamer.voiceConnection) {
      try {
        this.streamer.stopStream();
      } catch {}
    }

    st('1/4 resolving the audio');
    const audio = await resolveAudio(track, this.cfg, st);
    if (!ok()) return { aborted: true };
    if (!audio.duration) this.log('warning: could not read the audio duration');

    st('2/4 fetching synced lyrics');
    const lyrics = await this.lyricsFor(track, audio.duration ?? track.duration);
    if (!ok()) return { aborted: true };

    st('3/4 building the lyric video');
    const video = await this.ensureVideo(track, audio, lyrics, st, { force });
    if (!ok()) return { aborted: true };

    st('4/4 joining voice and starting Go Live');
    await this.ensureVoice(channelId, guildId);
    if (!ok()) return { aborted: true };

    const { command, output, promise } = prepareStream(video.file, {
      noTranscoding: true,
      includeAudio: this.cfg.video?.includeAudio ?? true,
      bitrateAudio: this.cfg.video?.bitrateAudio || 128,
      logLevel: 'error',
    });
    promise.catch((e) => this.log('ffmpeg:', e?.message || e));
    command.on('error', (err, _stdout, stderr) => this.log('ffmpeg error:', err?.message || err, String(stderr || '').slice(-400)));

    this.state.track = track;
    this.state.audio = audio;
    this.state.lyrics = lyrics;
    this.state.video = video;
    this.state.startedAt = Date.now();
    this.state.playing = true;

    this.log(`Go Live: ${track.title} (${video.cached ? 'cache' : 'fresh build'}), lyric offset ${this.state.offsetMs}ms`);
    try {
      await playStream(output, this.streamer, {
        type: 'go-live',
        streamPreview: this.cfg.video?.streamPreview ?? false,
      });
    } finally {
      this.state.playing = false;
      try {
        output.destroy();
      } catch {}
    }
    if (!ok()) return { aborted: true };

    if (this.cfg.stayInVoice === false) {
      try {
        await this.streamer.leaveVoice();
        this.state.channelId = null;
      } catch {}
    }
    return { ok: true, duration: video.duration, lyrics: lyrics.lines.length, source: audio.source };
  }

  async stop({ leave = true } = {}) {
    this.gen++;
    this.state.playing = false;
    try {
      this.streamer.stopStream();
    } catch {}
    if (leave) {
      try {
        await this.streamer.leaveVoice();
      } catch {}
      this.state.channelId = null;
    }
    this.state.track = null;
  }

  /** Shift the lyric timing, then rebuild and replay from the start. */
  async nudge(ms, ctx) {
    const next = Math.max(-30000, Math.min(30000, this.state.offsetMs + ms));
    const prev = this.state.offsetMs;
    this.state.offsetMs = next;
    return { prev, next, replay: () => this.play({ ...ctx, force: true }) };
  }
}
