# discord-lyrics-stream

A Discord selfbot (runs on a **user account**, not a bot token) that opens **Go Live** in a voice channel. The stream is a lyric video running in sync with the song, and the audio is sent to the voice channel too. Everything is driven from chat with `w/*` commands.

This is not a desktop capture: the lyrics are rendered into video frames (1280x720) first, then sent as Go Live over RTP/WebRTC like any other stream.

## Commands

Every command is typed in any channel this account can read. If you are already in a voice channel, the song plays there.

- `w/play <song title | Spotify link>` (alias `w/p`) - play a song: resolve it, download the audio with yt-dlp, fetch synced lyrics, then open Go Live.
  - a title plays the **most listened** match, so a shared title resolves to the version people actually listen to
  - a Spotify **track** link plays exactly that track
  - a Spotify **album** or **playlist** link queues the whole list and plays it in order (`commands.playlistLimit`, 30 by default)
- `w/stop` (alias `w/leave`, `w/off`) - stop Go Live and leave the voice channel.
- `w/sync <milliseconds>` - shift the lyric timing. `w/sync +500` when the lyrics are late, `w/sync -500` when they are early. Slides are cached, so this is only a re-mux (far faster than the first build) and the stream restarts from the beginning.
- `w/help [topic number | question]` - without an argument: the list of help topics. With a number: that answer, no AI involved. With a question, or as a reply to the topic list in your own words: the AI works out the steps, and it only answers questions about this bot.
- `w/listcmd` (alias `w/cmd`) - list the commands.

The command list lives in one place: `src/features.js`. So `w/listcmd`, `w/help`, and the AI context always stay in sync.

## How a title becomes a track

`w/play tulus - monokrom` should not play a cover, a live take or a 10 hour loop, so two picks happen:

- **Spotify decides the song.** A title returns several matches and the one with the highest Spotify `popularity` wins. The `w/play` argument is not a guess-by-first-result: with three results called "Monokrom" (live, studio, remix) the studio take wins.
- **YouTube decides the audio.** `yt-dlp` lists the ten best matches with their view counts, matches whose length is more than 25% away from the Spotify duration are dropped first, and the most viewed survivor is downloaded. That removes the loop and teaser problem: a 10 hour upload with 990M views loses to the 48M view official upload once the length filter is applied. Without Spotify credentials the length filter is skipped, so the most viewed match wins outright. If YouTube refuses the download (see [When YouTube refuses](#when-youtube-refuses)), the same length window is applied to SoundCloud results and the closest plain upload is used.

Links skip the guessing: a Spotify **track** link plays exactly that track, an **album** or **playlist** link queues every track in order (up to `commands.playlistLimit`, 30 by default). `w/stop` cancels the rest of the queue.


## Lyrics and voice follow the song and the caller

- **Lyrics belong to the song being played.** `w/play` resolves a track first (Spotify popularity, or exactly what a link points at) and that same track, with its title, artist and duration, is what lrclib is queried with. Nothing in `config.json` pins a song, so a queue of ten tracks looks up ten different lyric sets. A per-song `.lrc` in `cache/lyrics/` overrides the lookup for that one song.
- **The stream opens where the caller sits.** The bot joins the voice channel of the user who typed the command, so with `commands.allowOtherUsers` on, another user gets the stream in their own channel. If that user is not in a voice channel, `channelId` is used as a fallback.


## How `w/help` works

`w/help` posts a numbered list of topics (starting a stream, out of sync lyrics, Spotify not configured, and so on). Each answer is static text kept in `src/features.js`, so the list works with no AI, no network and no credentials.

When the topic list does not cover the problem, the user replies to that message and describes the goal in their own words, prefix or not. The AI maps the goal onto the real features and returns the steps. The system prompt pins it to this bot: an unrelated question gets a one line refusal instead of an answer. The reply window is 30 minutes.

Without `AI_API_URL` only the numbered topics work; `w/help <question>` then answers with the topic list plus a note about the missing setting.

## Select menus, and what a selfbot can receive

The help topic list is sent as a select menu. `src/ui.js` builds it with `MessageActionRow` plus a `STRING_SELECT` component, the v13 shapes of what discord.js v14 calls `ActionRowBuilder` and `StringSelectMenuBuilder`. Labels, descriptions and values are trimmed to the API limits (25 options, 100 characters, 150 for the placeholder).

A user account cannot receive a component click. Discord routes `MESSAGE_COMPONENT` interactions to the application that owns the message, and a plain user account owns no application: `@lng2004/discord.js-selfbot-v13` ships no `INTERACTION_CREATE` gateway handler, so the packet never becomes an `interactionCreate` event and the click fails on the clicker's side. The menu is therefore a display, and the same content is reachable by typing: `w/help 3` answers topic 3.

The handler is wired anyway (`handleComponent` in `src/commands.js`, registered on `interactionCreate`): the moment a build does deliver the event (a fork with the gateway handler, or a bot token), picking a topic answers it with no other change. On startup the process logs one line when the build cannot deliver it.

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

System requirements: Node >= 22.4, and FFmpeg with `libx264`, `libopus`, `libzmq`. yt-dlp is optional: it is looked for on PATH and in `bin/`, and installed into `bin/` on first use when it is missing (see [When yt-dlp is not installed](#when-yt-dlp-is-not-installed)).

## Credentials

Every credential is read from `.env` (see `.env.example`). No token or API key is written in the code.

```
DISCORD_TOKEN=            # Discord account token (selfbot)
SPOTIFY_CLIENT_ID=        # for song search and metadata
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
node src/index.js build "Tulus - Monokrom"                  # render the lyric video only, no Discord
node src/index.js build "https://open.spotify.com/track/..." # same, from a Spotify link
node src/index.js play  "Tulus - Monokrom"                  # stream it once in the configured channel
node src/index.js help                                      # command list + credential status
```

The mode argument is resolved exactly like `w/play` resolves it, so the CLI renders the lyrics of the song you asked for. When `token` is empty, `node src/index.js` only builds and exits, it never tries to log in.

## Configuration (`config.json`)

There is no song, lyrics file or audio path in the config. Every `w/play` (and every CLI `build`/`play`) resolves its own song, downloads its own audio and looks up its own lyrics, so what you hear and what you see always belong to the same song.

- `channelId` - only a fallback: normally the stream opens in the voice channel of whoever typed the command.
- `commands.playlistLimit` - how many tracks an album/playlist link may queue, default 30.
- `cache.lyrics` - folder for per-song `.lrc` overrides, default `cache/lyrics`.
- Every path in `config.json` (`render.out`, `cache.*`) is resolved relative to the **folder holding that config**, not the project root. So a config inside `test/` has to write `../cache/...`.
- `ytdlpPath` - optional. In order: this value, `YTDLP_PATH` in `.env`, a build in `bin/`, `yt-dlp` / `yt-dlp.exe` / `ytdlp` / `youtube-dl` on `PATH`, then the Python module (`python3 -m yt_dlp`, including `vendor/`). A value that cannot run is logged once and skipped, so `"ytdlp"` (a name that does not exist) falls back to the real binary instead of failing with `spawn ytdlp ENOENT`.
- `ytdlpAutoInstall` - default `true`. When nothing above runs, yt-dlp is installed once: `pip install --target vendor yt-dlp`, then the standalone build downloaded into `bin/` (the release page, then two plain GitHub proxies). The file stays on disk, so later starts use it directly. Set it to `false` on a machine where nothing may be downloaded.
- `ytdlpInstallDir` - optional, default `bin/`. Where a downloaded or hand-uploaded build is looked for and stored.
- `ytdlpReleaseBase`, `ytdlpReleaseMirrors`, `ytdlpReleaseAsset`, `ytdlpPythonInstall` - optional overrides for the download route (a release of your own, extra mirrors, a pinned asset, or skipping pip).
- `audioSource` - `"ytdlp"` (default, full song) or `"preview"` (the official 30 second Spotify clip).
- `audioSources` - default `["youtube", "soundcloud"]`. Where the full song is taken from, in order. YouTube wins when the network is not challenged; when it answers "Sign in to confirm you're not a bot", the download moves to SoundCloud and the song still plays.
- `ytdlpCookies` - optional path to a `cookies.txt`. A file named `cookies.txt` next to the project is picked up automatically, which is what puts YouTube back in front on a datacenter IP. Also `YTDLP_COOKIES`.
- `ytdlpYoutubeClient` - optional, for example `"tv"` or `"android"`; passed as `youtube:player_client`. Rotating clients does not get past the bot check, but it is there for networks where one client works and another does not.
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

Drop that file in `cache/lyrics/` (`cache.lyrics` in the config) and name it after the song, either `<spotify track id>.lrc` or `artist-title.lrc` in lowercase with dashes, for example `tulus-monokrom.lrc`. The override applies to that song only, and it wins over lrclib. The `[mm:ss.xx]` format is required; a file without timestamps is rejected.

## Things you should know

- Selfbots violate the Discord ToS and an account can get banned. Use a spare account.
- The Spotify Web API does **not** provide full song audio (DRM), only a 30 second `preview_url` that is sometimes `null`. That is why the full audio is fetched with yt-dlp; Spotify is used for search and metadata.
- Go Live on a normal account tops out at 720p, which matches the defaults.
- If the stream looks glitchy or green: lower `bitrateVideo` to 2000 and `fps` to 24.
- If you want a real desktop capture (Spotify plus an overlay), that is a different path: it needs a virtual X server and a browser, and it is far heavier and more fragile.

## When YouTube refuses

A datacenter IP is regularly told `Sign in to confirm you're not a bot`. That is not a bug in the bot and no player client setting avoids it, so the audio side walks a list of sources instead of insisting on one:

1. YouTube: the most viewed match inside the duration window (the normal path).
2. SoundCloud: the same song, picked by length and title, with edits and covers pushed down.
3. `audioSource: "preview"`: the 30 second Spotify clip, when that is all you want.

`audioSources` decides the order. A `cookies.txt` next to the project, exported from a browser that is logged into YouTube, puts YouTube first again and keeps the higher quality audio. Without cookies the SoundCloud copy plays at 96 kbps AAC, which is below the 128 kbps the voice stream carries, so nothing is wasted by transcoding.

## When yt-dlp is not installed

A container that never had it (a game panel image, a slim distro) answers `ENOENT` for every name and `No module named yt_dlp` for python. The first `w/play` then installs it once and logs one line:

```
yt-dlp: downloaded yt-dlp_linux to bin/yt-dlp_linux (2026.10.26)
```

Order: a private `pip install --target vendor yt-dlp`, then the standalone build from the release page into `bin/` (trying two plain GitHub proxies when the release host is unreachable). The result is an ordinary file on disk, so the next start finds it without downloading again. If the machine cannot reach any of them, upload the standalone build to `bin/yt-dlp` by hand; it is made executable on first use. `ytdlpAutoInstall: false` disables the whole route and leaves only what is already on the machine.

## Test status

Verified on this machine (Linux x64, Node 26, FFmpeg 9):

- `.lrc` parsing plus synced lyrics from lrclib.net (Tulus, Coldplay, Queen)
- 720p30 H.264 + AAC render, layout verified through per-row pixel analysis
- the encoder path `prepareStream` -> FFmpeg (libx264 + libopus + azmq) -> nut container -> node-av demux
- the native modules `node-av`, `@snazzah/davey`, `node-datachannel`, `zeromq`, `sharp`
- the command layer (prefix parsing, aliases, channel filter, user whitelist, `w/sync`)
- the slide cache: slides are reused when the offset moves, while the output still changes to match the offset
- full song render: Tulus - Monokrom (28 lines, 194s) -> 2.0 MB, lyrics verified at 100s and 190s
- source fallback: with YouTube blocked on the server, the same `w/play` resolved through SoundCloud (2.5 MB, 214s) and picked the plain upload over a sped up edit and a featured-artist version
- yt-dlp discovery and install: a typo'd name falls back to the working binary, a build dropped in `bin/` is used without a download, and on a machine with no yt-dlp at all the standalone build is downloaded (41 MB, 6s), made executable, and then finds the same match (`TULUS - Monokrom`, 162 863 949 views)

Not tested: Discord login, joining voice, and the WebRTC/DAVE handshake. That part needs your account token, so it is only proven once you run `node src/index.js serve`.

## Structure

```
src/index.js     CLI modes: serve / play / build / help
src/commands.js  w/* command handlers (play, stop, sync, help, listcmd)
src/ui.js        select menu payloads (help topics)
src/player.js    orchestration: audio -> lyrics -> video -> voice -> Go Live
src/features.js  single source of truth for the command list + AI context
src/slides.js    slide/concat renderer (bg once, 1 PNG per line, 1 encode)
src/lyrics.js    LRC parser + lrclib.net client
src/spotify.js   Spotify client credentials (search + metadata)
src/track.js     query -> track (fallback without Spotify credentials)
src/resolve.js   track -> audio file (cache -> preview -> youtube -> soundcloud), and where yt-dlp comes from
src/ai.js        OpenAI-compatible client for w/help
src/env.js       .env loader + credential status
bin/             yt-dlp build (downloaded on first use or uploaded by hand, gitignored)
vendor/          python install of yt-dlp, used when pip is available (gitignored)
```
