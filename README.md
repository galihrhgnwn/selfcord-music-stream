# discord-lyrics-stream

A Discord selfbot (runs on a **user account**, not a bot token) that opens **Go Live** in a voice channel. The stream is a lyric video running in sync with the song, and the audio is sent to the voice channel too. Everything is driven from chat with `w/*` commands.

This is not a desktop capture: the lyrics are rendered into video frames (1280x720) first, then sent as Go Live over RTP/WebRTC like any other stream.

## Commands

Every command is typed in any channel this account can read. If you are already in a voice channel, the song plays there.

- `w/play <song title | spotify link | search result number>` (alias `w/p`) - find the song on Spotify, download the audio, fetch synced lyrics, then open Go Live.
- `w/search <keywords>` (alias `w/s`) - show 6 Spotify results as an interactive list. React with 1-6 to play, or `❌` to cancel. You can also follow up with `w/play 3`.
- `w/stop` (alias `w/leave`, `w/off`) - stop Go Live and leave the voice channel.
- `w/sync <milliseconds>` - shift the lyric timing. `w/sync +500` when the lyrics are late, `w/sync -500` when they are early. Slides are cached, so this is only a re-mux (far faster than the first build) and the stream restarts from the beginning.
- `w/help [question]` - without an argument: a summary of every command. With a question: answered by AI from this project's real features.
- `w/listcmd` (alias `w/cmd`) - list the commands.

The command list lives in one place: `src/features.js`. So `w/listcmd`, `w/help`, and the AI context always stay in sync.

## Why it stays light and drift-free

The main problem with lyric streams is drift: the lyrics slide further and further away from the music. Here that is removed by design, not corrected afterwards:

- The background and header are rendered **once** into `bg.png`.
- Every lyric line becomes **one PNG** (`drawtext` through FFmpeg).
- All those PNGs go into a single `concat` demuxer together with the audio, and are encoded **once** to H.264 with B-frames disabled (`-bf 0`, `has_b_frames=0` is required for copy mode) and a keyframe every second.
- Because the audio and the lyric frames sit on the same timeline inside one file, there are no two paths that can slide relative to each other.
- While streaming, `prepareStream` is called with `noTranscoding: true`. The video is copied as is (the bitstream is already H.264 720p30), so CPU goes to RTP packetization and opus encoding only.
- A built video is cached in `cache/video`, and its slides in `cache/slides`. Changing the lyric offset does not re-render the slides.

Measured on the test machine: a 194s lyric video (28 lines, 1280x720 30fps) comes out at **2.0 MB**, the first build takes ~218s, and a rebuild with the slide cache is much faster. Changing the offset is only a re-mux.

## Install

```bash
cd ~/discord-lyrics-stream
npm install
```

If you see `install-scripts blocked` warnings for `node-av` / `zeromq`:

```bash
npm install-scripts approve node-av
npm install-scripts approve zeromq
npm rebuild node-av zeromq
```

System requirements: Node >= 22.4, FFmpeg with `libx264`, `libopus`, `libzmq`, and `yt-dlp` on PATH (or set `YTDLP_PATH`).

## Credentials

Every credential is read from `.env` (see `.env.example`). No token or API key is written in the code.

```
DISCORD_TOKEN=            # Discord account token (selfbot)
SPOTIFY_CLIENT_ID=        # for w/search and song metadata
SPOTIFY_CLIENT_SECRET=
AI_API_URL=               # OpenAI-compatible endpoint for w/help <question>
AI_API_KEY=
AI_MODEL=gpt-4o-mini
YTDLP_PATH=               # optional
```

The token can still be placed in `config.json` (`"token": "..."`), but `.env` is safer.

## Usage

```bash
cp config.example.json config.json     # then fill in channelId
node src/index.js serve                # log in and listen for w/* commands
```

Other modes:

```bash
node src/index.js play "Tulus - Monokrom"   # play once without a command
node src/index.js build                     # render the lyric video only (to check the result)
node src/index.js help                      # command list + credential status
```

When `token` is empty, `node src/index.js` only renders and exits, it never tries to log in.

## Configuration (`config.json`)

- `channelId` - default voice channel when the account is not already in one.
- Every path in `config.json` (`audio`, `lyricsFile`, `render.out`, `cache.*`) is resolved relative to the **folder holding that config**, not the project root. So a config inside `test/` has to write `../cache/audio/...`.
- `song.title` / `song.artist` - used to look up lyrics automatically on lrclib (`build` mode and `play` without an argument).
- `lyricsFile` - path to a manual `.lrc`. When set, the automatic lyric lookup is skipped.
- `audio` - local song file (mp3/m4a/wav) for `build` mode.
- `audioSource` - `"ytdlp"` (default, full song) or `"preview"` (the official 30 second Spotify clip).
- `lyricOffsetMs` - initial lyric offset in milliseconds (can also be set live with `w/sync`).
- `stayInVoice` - `true` if the account should stay in voice after the song ends.
- `video.streamPreview` - `false` (default) saves CPU: the Go Live thumbnail is not rendered from a frame. Set `true` if you want the preview to show.
- `video.preset` / `video.crf` / `video.concurrency` - control the encode load. Defaults `veryfast` / `30` / `4` parallel workers.
- `commands.prefix` - default `w/`.
- `commands.channels` - when filled, it only responds in those channels.
- `commands.allowOtherUsers` - `true` if other people may run these commands.
- `accent` - hex accent colour, default `8b5cf6`.
- `render.force` - force a re-render even when the cache exists.

## Manual lyrics (.lrc)

```
[ti:Title]
[ar:Artist]
[00:12.34]First line
[00:16.80]Second line
```

Then set `"lyricsFile": "lyrics/song.lrc"`. The `[mm:ss.xx]` format is required; a file without timestamps is rejected.

## Things you should know

- Selfbots violate the Discord ToS and an account can get banned. Use a spare account.
- The Spotify Web API does **not** provide full song audio (DRM), only a 30 second `preview_url` that is sometimes `null`. That is why the full audio is fetched with yt-dlp; Spotify is used for search and metadata.
- Go Live on a normal account tops out at 720p, which matches the defaults.
- If the stream looks glitchy or green: lower `bitrateVideo` to 2000 and `fps` to 24.
- If you want a real desktop capture (Spotify plus an overlay), that is a different path: it needs a virtual X server and a browser, and it is far heavier and more fragile.

## Test status

Verified on this machine (Linux x64, Node 26, FFmpeg 9):

- `.lrc` parsing plus synced lyrics from lrclib.net (Tulus, Coldplay, Queen)
- 720p30 H.264 + AAC render, layout verified through per-row pixel analysis
- the encoder path `prepareStream` -> FFmpeg (libx264 + libopus + azmq) -> nut container -> node-av demux
- the native modules `node-av`, `@snazzah/davey`, `node-datachannel`, `zeromq`, `sharp`
- `test/commands-test.mjs`: 16/16 pass (command parser, aliases, channel filter, user whitelist, `w/sync`)
- `test/cache-test.mjs`: slides are reused when the offset moves, while the output still changes to match the offset
- full song render: Tulus - Monokrom (28 lines, 194s) -> 2.0 MB, lyrics verified at 100s and 190s

Not tested: Discord login, joining voice, and the WebRTC/DAVE handshake. That part needs your account token, so it is only proven once you run `node src/index.js serve`.

## Structure

```
src/index.js     CLI modes: serve / play / build / help
src/commands.js  w/* command handlers (play, search, stop, sync, help, listcmd)
src/player.js    orchestration: audio -> lyrics -> video -> voice -> Go Live
src/features.js  single source of truth for the command list + AI context
src/slides.js    slide/concat renderer (bg once, 1 PNG per line, 1 encode)
src/render.js    thin wrapper around slides.js
src/lyrics.js    LRC parser + lrclib.net client
src/spotify.js   Spotify client credentials (search + metadata)
src/track.js     query -> track (fallback without Spotify credentials)
src/resolve.js   track -> audio file (cache -> preview -> yt-dlp)
src/ai.js        OpenAI-compatible client for w/help
src/env.js       .env loader + credential status
test/            command, cache, media path, lrclib, and frame analysis tests
```
