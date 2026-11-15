import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

/**
 * Lightweight lyric pipeline:
 *  1 bg.png (rendered once, already carries title/artist)
 *  N png, one per lyric line (only the text changes, no stacked blur/drawtext)
 *  concat demuxer -> a single H.264 encode (B-frames off, keyframe every 1s)
 *  + the real audio on the same timeline => no drift between song and lyrics
 *
 * This is far cheaper than drawing every line into every frame.
 */

const FALLBACK_FONTS = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
];

const CJK_FONTS = [
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
  '/usr/share/fonts/truetype/unifont/unifont_jp.otf',
];

function firstExisting(list) {
  for (const f of list) if (f && fs.existsSync(f)) return f;
  return null;
}

export function pickFont(preferred) {
  const hit = firstExisting([preferred, ...FALLBACK_FONTS]);
  if (hit) return hit;
  const r = spawnSync('fc-match', ['-f', '%{file}', 'sans:bold'], { encoding: 'utf8' });
  return (r.stdout || '').trim() || FALLBACK_FONTS[0];
}

export function pickCjkFont(preferred) {
  return firstExisting([preferred, ...CJK_FONTS]) || null;
}

export function ffprobeDuration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], {
    encoding: 'utf8',
  });
  const d = parseFloat((r.stdout || '').trim());
  return Number.isFinite(d) && d > 0 ? d : null;
}

function isCjk(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xff60)
  );
}

function charWidth(code, fontSize) {
  // deliberately overestimated so text never touches the frame edge
  if (isCjk(code)) return fontSize;
  const ch = String.fromCodePoint(code);
  if (" iljI.,!'|:;".includes(ch)) return fontSize * 0.34;
  if ('mwMW@%'.includes(ch)) return fontSize * 0.88;
  return fontSize * 0.62;
}

export function textWidth(str, fontSize) {
  let w = 0;
  for (const ch of str) w += charWidth(ch.codePointAt(0), fontSize);
  return w;
}

export function wrapText(str, maxWidth, fontSize) {
  const words = String(str).split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let cur = '';
  for (const word of words) {
    const candidate = cur ? `${cur} ${word}` : word;
    if (textWidth(candidate, fontSize) <= maxWidth || !cur) cur = candidate;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export function fitText(str, maxWidth, sizes) {
  for (const size of sizes) {
    const lines = wrapText(str, maxWidth, size);
    if (lines.length <= 2) return { size, lines };
  }
  const size = sizes[sizes.length - 1];
  return { size, lines: wrapText(str, maxWidth, size) };
}

function escText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/,/g, '\\,');
}

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stdout.on('data', () => {});
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) reject(new Error(`ffmpeg exit ${code}: ${err.slice(-1200)}`));
      else resolve();
    });
  });
}

async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

/**
 * @param {object} o
 * @param {{time:number,text:string}[]} o.lines
 * @param {string} o.out
 */
export async function buildSlideVideo(o) {
  const W = o.width || 1280;
  const H = o.height || 720;
  const FPS = o.fps || 30;
  const accent = (o.accent || '8b5cf6').replace(/^#/, '');
  const offset = (o.offsetMs || 0) / 1000;
  const lines = o.lines;

  const needsCjk = lines.some((l) => [...l.text].some((c) => isCjk(c.codePointAt(0))));
  const font = needsCjk ? pickCjkFont(o.font) || pickFont(o.font) : pickFont(o.font);

  const audioDur = o.audio ? ffprobeDuration(o.audio) : null;
  const lastLine = lines.length ? Math.max(...lines.map((l) => l.time)) + offset : 0;
  const DUR = +(o.duration || audioDur || lastLine + 4).toFixed(3);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slides-'));
  const margin = 90;
  const maxTextW = W - 260;
  let txtN = 0;
  const txtFile = (text) => {
    const f = path.join(tmp, `t${String(txtN++).padStart(4, '0')}.txt`);
    fs.writeFileSync(f, text, 'utf8');
    return f;
  };

  // A slide (bg + one png per line) depends on the text only, never on timing.
  // So the result is cached: changing the lyric offset only needs a re-mux.
  const sig = crypto
    .createHash('sha1')
    .update(JSON.stringify({ t: lines.map((l) => l.text), ti: o.title || '', ar: o.artist || '', accent, W, H, font }))
    .digest('hex')
    .slice(0, 12);
  const work = o.slideCacheDir ? path.resolve(o.slideCacheDir) : path.join(tmp, 'frames');
  fs.mkdirSync(work, { recursive: true });
  const bg = path.join(work, 'bg.png');
  const manifestFile = path.join(work, 'manifest.json');

  let reuse = false;
  if (o.slideCacheDir) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      reuse =
        m.sig === sig &&
        fs.existsSync(bg) &&
        lines.every((_, i) => fs.existsSync(path.join(work, `f${String(i).padStart(4, '0')}.png`)));
    } catch {
      reuse = false;
    }
  }

  const dtext = (opts) =>
    `drawtext=${Object.entries(opts)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join(':')}`;

  // ---- 1. background + header, rendered once
  if (!reuse)
  {
    const chain = [];
    if (o.cover) {
      chain.push(`scale=${W}:${H}:force_original_aspect_ratio=increase`, `crop=${W}:${H}`, 'boxblur=26:2', 'eq=brightness=-0.30:saturation=0.85');
      chain.push(`drawbox=x=0:y=0:w=${W}:h=${H}:color=black@0.32:t=fill`);
    } else {
      chain.push('scale=1280:720', 'boxblur=1:1');
    }
    if (o.title)
      chain.push(
        dtext({
          fontfile: `'${font}'`,
          text: `'${escText(o.title)}'`,
          expansion: 'none',
          fontsize: 34,
          fontcolor: 'white@0.95',
          x: margin,
          y: 42,
          shadowcolor: 'black@0.7',
          shadowx: 2,
          shadowy: 2,
        }),
      );
    if (o.artist)
      chain.push(
        dtext({
          fontfile: `'${font}'`,
          text: `'${escText(o.artist)}'`,
          expansion: 'none',
          fontsize: 24,
          fontcolor: `0x${accent}@0.95`,
          x: margin,
          y: o.title ? 86 : 42,
          shadowcolor: 'black@0.7',
          shadowx: 2,
          shadowy: 2,
        }),
      );
    chain.push(`drawbox=x=${margin}:y=${o.artist || o.title ? 130 : 60}:w=64:h=5:color=0x${accent}@1:t=fill`);

    const vf = chain.join(',');
    if (o.cover) {
      await run(['-i', o.cover, '-vf', vf, '-frames:v', '1', bg]);
    } else {
      const grad = `gradients=s=${W}x${H}:c0=0x241b3a:c1=0x0d0d14:n=2:d=1`;
      await run(['-f', 'lavfi', '-i', grad, '-vf', vf.replace('scale=1280:720,boxblur=1:1,', ''), '-frames:v', '1', bg]);
    }
  }

  // ---- 2. one png per lyric line
  const SIZES = [54, 48, 44, 40, 36];
  const plan = [];
  for (let i = 0; i < lines.length; i++) {
    const start = Math.max(0, lines[i].time + offset);
    const nextStart = i + 1 < lines.length ? Math.max(start + 0.08, lines[i + 1].time + offset) : DUR;
    plan.push({ i, start, end: Math.min(nextStart, DUR), text: lines[i].text, next: lines[i + 1]?.text });
  }

  const outDir = work;
  if (!reuse) await pool(plan, o.concurrency || 4, async (p) => {
    const { size, lines: wrapped } = fitText(p.text, maxTextW, SIZES);
    const blockH = wrapped.length * size * 1.2 + (wrapped.length - 1) * 12;
    const filters = [
      dtext({
        fontfile: `'${font}'`,
        textfile: `'${txtFile(wrapped.join('\n'))}'`,
        expansion: 'none',
        fontsize: size,
        fontcolor: 'white@0.98',
        line_spacing: 12,
        x: '(w-text_w)/2',
        y: '(h-text_h)/2',
        shadowcolor: 'black@0.85',
        shadowx: 3,
        shadowy: 3,
      }),
    ];
    if (p.next) {
      const nx = fitText(p.next, maxTextW, [30, 26, 22, 20]);
      filters.push(
        dtext({
          fontfile: `'${font}'`,
          textfile: `'${txtFile(nx.lines.join('\n'))}'`,
          expansion: 'none',
          fontsize: nx.size,
          fontcolor: 'white@0.40',
          x: '(w-text_w)/2',
          y: Math.round((H + blockH) / 2) + 28,
          shadowcolor: 'black@0.6',
          shadowx: 2,
          shadowy: 2,
        }),
      );
    }
    await run(['-i', bg, '-vf', filters.join(','), '-frames:v', '1', path.join(outDir, `f${String(p.i).padStart(4, '0')}.png`)]);
  });

  if (!reuse) fs.writeFileSync(manifestFile, JSON.stringify({ sig, lines: lines.length, at: Date.now() }), 'utf8');

  // ---- 3. slide list (intro card when the lyrics start late)
  const list = [];
  if (plan.length && plan[0].start > 0.4) list.push({ file: bg, dur: plan[0].start });
  for (const p of plan) list.push({ file: path.join(outDir, `f${String(p.i).padStart(4, '0')}.png`), dur: Math.max(0.08, p.end - p.start) });
  if (!list.length) list.push({ file: bg, dur: DUR });

  const listFile = path.join(tmp, 'list.txt');
  const linesTxt = [];
  for (const s of list) {
    linesTxt.push(`file '${s.file}'`, `duration ${s.dur.toFixed(3)}`);
  }
  linesTxt.push(`file '${list[list.length - 1].file}'`);
  fs.writeFileSync(listFile, linesTxt.join('\n') + '\n', 'utf8');

  // ---- 4. single encode: lyric video + audio on the same timeline
  const barY = H - 10;
  const vf = [
    `fps=${FPS}`,
    `drawbox=x=0:y=${barY}:w=${W}:h=10:color=white@0.08:t=fill`,
    `drawbox=x=0:y=${barY}:w='(t/${DUR.toFixed(3)})*${W}':h=10:color=0x${accent}@1:t=fill`,
    'format=yuv420p',
  ].join(',');

  const args = ['-f', 'concat', '-safe', '0', '-i', listFile];
  if (o.audio) args.push('-i', o.audio);
  args.push('-vf', vf);
  if (o.audio) args.push('-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2');
  args.push(
    '-c:v', 'libx264', '-preset', o.preset || 'veryfast', '-tune', 'stillimage', '-crf', String(o.crf ?? 20),
    '-bf', '0', '-g', String(FPS), '-keyint_min', String(FPS), '-sc_threshold', '0',
    '-r', String(FPS), '-t', String(DUR), '-movflags', '+faststart', o.out,
  );

  fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
  const t0 = Date.now();
  await run(args);
  const buildMs = Date.now() - t0;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}

  return { out: o.out, duration: DUR, lines: lines.length, slides: list.length, slidesReused: reuse, width: W, height: H, fps: FPS, buildMs };
}
