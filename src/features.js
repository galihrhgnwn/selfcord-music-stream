/**
 * Single source of truth for the command list and the feature description.
 * Used by w/listcmd, w/help, and as the AI context.
 */

export const PREFIX = 'w/';

export const COMMANDS = [
  {
    name: 'w/play',
    args: '<song title | Spotify link>',
    desc: 'Play a song: it finds the track, downloads the audio with yt-dlp, then opens Go Live in your voice channel with synced lyrics. A title picks the most listened match, a Spotify track link plays exactly that track, and an album or playlist link plays the whole list in order.',
    aliases: ['w/p'],
  },
  {
    name: 'w/stop',
    args: '',
    desc: 'Stop the Go Live stream and leave the voice channel.',
    aliases: ['w/leave', 'w/off'],
  },
  {
    name: 'w/sync',
    args: '<milliseconds>',
    desc: 'Shift the lyric timing. Example: w/sync +500 when the lyrics lag behind, w/sync -500 when they run ahead.',
    aliases: [],
  },
  {
    name: 'w/help',
    args: '[topic number | question]',
    desc: 'Help. Without an argument: the list of help topics. With a number: that answer, no AI needed. With anything else, or as a reply to the topic list: the AI works out how to do it with this bot.',
    aliases: ['w/h'],
  },
  {
    name: 'w/listcmd',
    args: '',
    desc: 'List every command.',
    aliases: ['w/cmd'],
  },
];

export const FEATURES = [
  'Discord selfbot (runs on a user account, not a bot token) that broadcasts Go Live into a voice channel.',
  'Go Live content: a 1280x720 lyric video that runs in sync with the song, while the audio is sent to the voice channel too.',
  'Song source: Spotify Web API search (client credentials). Metadata, cover art and duration come from Spotify.',
  'One song, picked for you: a title returns several matches, and the most popular one (highest Spotify popularity) is played, so a title shared by several versions resolves to the one people listen to.',
  'Lyrics follow the song being played: the track that w/play resolves is the one searched on lrclib (title, artist and duration), so the stream always shows that song. There is no fixed song or lyrics file in config.json. A hand-written .lrc in cache/lyrics named after the track overrides the lookup for that song alone.',
  'The voice channel is the caller\'s: the bot joins whichever channel the user who typed w/play is sitting in, so another user can get the stream in their own channel. config.channelId is only the fallback.',
  'Spotify links: a track link plays that exact track, an album or playlist link queues every track and plays them in order (capped by commands.playlistLimit, 30 by default).',
  'Audio match: yt-dlp lists the ten best YouTube matches and the most viewed one wins, after matches that are far from the Spotify duration are removed. Full audio always comes from yt-dlp, because the Spotify API cannot stream full tracks.',
  'Full audio is fetched with yt-dlp because the Spotify API does not allow streaming full tracks (DRM). An official 30 second preview is available through audioSource: "preview".',
  'Synced lyrics come from lrclib.net, or from a manual .lrc file when the song is not on lrclib.',
  'Drift-free sync: the audio and the lyric frames are encoded onto the same timeline and shipped in one stream, so they cannot slide apart.',
  'Light on CPU: the background is rendered once, every lyric line becomes one image, then everything is concatenated and encoded once with B-frames disabled and a keyframe every second. While streaming, the video is only copied (noTranscoding), so CPU goes to packetization and opus.',
  'Commands are typed as messages starting with w/ (from a phone or any client); the selfbot reads its own messages.',
];

/**
 * Help topics. The list itself is the w/help message, and every answer here is
 * static: it needs no AI, no network and no token, so w/help always works.
 * Only a question that is not on this list reaches the AI.
 */
export const HELP_TOPICS = [
  {
    q: 'How do I start a stream?',
    a: 'Join a voice channel, then type `w/play <song title>`. The account joins the channel you are in, downloads the audio, renders the lyric video and opens Go Live. The first render of a song takes a few minutes (a 194s song took ~218s on the test machine); later plays of the same song reuse the cache.',
  },
  {
    q: 'How do I make sure w/play picks the right version of a song?',
    a: 'Type `w/play <artist> - <title>`. Spotify returns several matches and the bot plays the most popular one, so a shared title resolves to the version people actually listen to. The audio side does the same on YouTube: the ten best matches are compared and the most viewed one wins, after matches whose length is far from the Spotify duration are dropped. To skip guessing entirely, paste the Spotify link to the exact track, or to an album or playlist.',
  },
  {
    q: 'The lyrics are behind or ahead of the music',
    a: 'Type `w/sync -500` when the lyrics are late and `w/sync +500` when they are early, in milliseconds. The slides do not depend on timing, so this only re-muxes the video (much faster than a first build) and restarts the stream from the beginning.',
  },
  {
    q: 'How do I stop the stream?',
    a: 'Type `w/stop` (aliases `w/leave`, `w/off`). The stream stops and the account leaves the voice channel. Set `stayInVoice: true` in `config.json` if you would rather keep it hanging around in the channel.',
  },
  {
    q: 'w/play says Spotify is not configured',
    a: 'Put `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in `.env` (create an app at developer.spotify.com/dashboard). Without them `w/play <title>` still works, it just skips Spotify and passes the text straight to yt-dlp, which returns the most viewed match. Spotify links and cover art need the credentials.',
  },
  {
    q: 'Where does the audio come from? Is it the full song?',
    a: 'Full song: yt-dlp. The Spotify Web API does not allow streaming full tracks (DRM), so Spotify is only used for search, metadata and cover art. Set `audioSource: "preview"` in `config.json` if you want the official 30 second Spotify clip instead.',
  },
  {
    q: 'No synced lyrics found for my song',
    a: 'lrclib.net has no synced version of that track. Drop a `.lrc` file with `[mm:ss.xx]text` lines into `cache/lyrics/` (or whatever `cache.lyrics` points at) and name it after the song: `<track id>.lrc`, or `artist-title.lrc` in lowercase with dashes. It is picked up for that song only, and the automatic lookup is skipped. Files without timestamps are rejected.',
  },
  {
    q: 'Which voice channel does the bot join?',
    a: 'The one the user who typed the command is sitting in. With `commands.allowOtherUsers` on, whoever runs `w/play` gets the stream in their own channel, even if that is not yours. If that user is not in a voice channel at all, the bot falls back to `channelId` in `config.json`, and if that is empty too the command answers that you are not in a voice channel.',
  },
  {
    q: 'The stream stutters, looks green or freezes',
    a: 'Lower `video.bitrateVideo` to 2000 and `video.fps` to 24 in `config.json`, and keep `video.streamPreview` false. The render is also stricter than a normal mp4: the video must be H.264 with `has_b_frames=0` and a keyframe every second, because the stream copies the bitstream instead of re-encoding it.',
  },
  {
    q: 'Can I change the song while it is playing?',
    a: 'Run `w/play <other song>` again: the current stream is stopped first, then the new one starts. Use `w/stop` if you only want it to go quiet.',
  },
  {
    q: 'Who is allowed to run the commands, and where?',
    a: 'Only the account itself by default. Set `commands.allowOtherUsers: true` to let others run them, list channel ids in `commands.channels` to restrict where the bot answers, and change `commands.prefix` (default `w/`) if you want another prefix.',
  },
  {
    q: 'Does it capture my screen? How heavy is it on the CPU?',
    a: 'No capture. The lyric frames are rendered ahead of time into a single mp4, and that file is sent as a Go Live stream. While streaming, the video is copied rather than re-encoded, so the CPU only pays for RTP packetization and Opus, and the audio plus the lyric frames share one timeline so they cannot drift apart.',
  },
  {
    q: 'Is this safe for my Discord account?',
    a: 'No. A selfbot violates the Discord ToS and the account can be banned, so use a spare account. The token belongs in `.env` (or `config.json`); both are gitignored and neither is ever printed by the bot.',
  },
];

export function helpTopicsText(prefix = PREFIX) {
  return [
    '**Help topics**',
    '',
    ...HELP_TOPICS.map((t, i) => `\`${i + 1}\`. ${t.q}`),
    '',
    `Pick one from the menu below, or type \`${prefix}help <number>\`.`,
    'If your question is not on the list, reply to this message with what you want to do and the AI works out the steps for you.',
  ].join('\n');
}

export function helpTopicAt(n) {
  const i = Number(n) - 1;
  return Number.isInteger(i) && i >= 0 && i < HELP_TOPICS.length ? { index: i, ...HELP_TOPICS[i] } : null;
}

export function commandsText() {
  const lines = COMMANDS.map((c) => {
    const alias = c.aliases.length ? ` (alias: ${c.aliases.join(', ')})` : '';
    const args = c.args ? ` ${c.args}` : '';
    return `**${c.name}**${args}${alias}\n${c.desc}`;
  });
  return lines.join('\n');
}

export function compactList() {
  return COMMANDS.map((c) => `\`${c.name}${c.args ? ' ' + c.args : ''}\` - ${c.desc.split('.')[0]}`).join('\n');
}

/** Context for the AI so its answers are grounded in the real features of this project. */
export function aiContext() {
  return [
    'You are the assistant for a Discord selfbot project named discord-lyrics-stream.',
    'Scope: answer ONLY questions about this bot, its commands, its settings and how to use it.',
    'If the question is not about this bot, reply with one short line saying you only cover this bot and stop there. Do not help with anything else, not even partially.',
    'Never invent a command, a setting or a behaviour that is not listed below. If the user asks for something the bot cannot do, say so in one line and name the closest thing it can do.',
    'Answer in English, at most 3 short paragraphs, in a direct tone. Name the exact command and the exact config key when those are the answer.',
    'The user may describe a goal in their own words instead of naming a command. Work out which listed feature covers it and give the steps in order, starting from what they should type.',
    '',
    'Commands that exist:',
    ...COMMANDS.map((c) => `- ${c.name}${c.args ? ' ' + c.args : ''}${c.aliases.length ? ' (alias ' + c.aliases.join(', ') + ')' : ''}: ${c.desc}`),
    '',
    'Features and technical limits:',
    ...FEATURES.map((f) => `- ${f}`),
    '',
    'Questions already answered without AI (the help topics):',
    ...HELP_TOPICS.map((t, i) => `- ${i + 1}. ${t.q}`),
    '',
    'Settings live in config.json: token, guildId, channelId (only a fallback for the voice channel), audioSource, lyricOffsetMs, stayInVoice, ytdlpPath, video (width/height/fps/includeAudio/streamPreview), accent, font, commands (prefix/channels/allowOtherUsers/playlistLimit), cache (audio/video/slides/lyrics), render (out/force). There is no fixed song in the config: the song, its audio and its lyrics all come from what w/play resolves.',
    'Credentials come from .env: DISCORD_TOKEN, SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, AI_API_URL, AI_API_KEY, AI_MODEL.',
  ].join('\n');
}
