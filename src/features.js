/**
 * Single source of truth for the command list and the feature description.
 * Used by w/listcmd, w/help, and as the AI context.
 */

export const PREFIX = 'w/';

export const COMMANDS = [
  {
    name: 'w/play',
    args: '<song title | spotify link>',
    desc: 'Find a song, download its audio, then open Go Live in your voice channel with synced lyrics.',
    aliases: ['w/p'],
  },
  {
    name: 'w/search',
    args: '<keywords>',
    desc: 'Show 6 Spotify search results as an interactive list (reactions 1-6), pick one to play.',
    aliases: ['w/s'],
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
    args: '[question]',
    desc: 'Help. Without an argument: a summary of every command. With a question: answered by AI from this project\'s real features.',
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
  'Full audio is fetched with yt-dlp because the Spotify API does not allow streaming full tracks (DRM). An official 30 second preview is available through audioSource: "preview".',
  'Synced lyrics come from lrclib.net, or from a manual .lrc file when the song is not on lrclib.',
  'Drift-free sync: the audio and the lyric frames are encoded onto the same timeline and shipped in one stream, so they cannot slide apart.',
  'Light on CPU: the background is rendered once, every lyric line becomes one image, then everything is concatenated and encoded once with B-frames disabled and a keyframe every second. While streaming, the video is only copied (noTranscoding), so CPU goes to packetization and opus.',
  'Commands are typed as messages starting with w/ (from a phone or any client); the selfbot reads its own messages.',
];

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
    'Answer briefly, at most 3 short paragraphs, in English, in a direct tone.',
    'Never invent commands that are not in the list. If asked about something outside these features, say it is not available.',
    '',
    'Commands that exist:',
    ...COMMANDS.map((c) => `- ${c.name}${c.args ? ' ' + c.args : ''}${c.aliases.length ? ' (alias ' + c.aliases.join(', ') + ')' : ''}: ${c.desc}`),
    '',
    'Features and technical limits:',
    ...FEATURES.map((f) => `- ${f}`),
    '',
    'Settings live in config.json: token, guildId, channelId, song, lyricsFile, audio, cover, video (width/height/fps/includeAudio/streamPreview), accent, loop, audioSource, lyricOffsetMs, stayInVoice, commands (prefix/channels/allowOtherUsers), cache, render.',
    'Credentials come from .env: DISCORD_TOKEN, SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, AI_API_URL, AI_API_KEY, AI_MODEL.',
  ].join('\n');
}
