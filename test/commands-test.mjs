import { EventEmitter } from 'node:events';
import { attachCommands } from '../src/commands.js';

const SELF = 'SELF_ID';

class FakeMessage {
  constructor(channel, content) {
    this.channel = channel;
    this.content = content;
    this.edits = [];
    this.reactions = [];
  }
  async edit(t) {
    this.edits.push(t);
    return this;
  }
  async react(e) {
    this.reactions.push(e);
    return this;
  }
  async awaitReactions() {
    throw new Error('time');
  }
}

class FakeChannel {
  constructor() {
    this.sent = [];
  }
  async send(text) {
    const m = new FakeMessage(this, text);
    this.sent.push(m);
    return m;
  }
  async sendTyping() {}
  get last() {
    return this.sent.at(-1);
  }
  get text() {
    return this.sent.map((m) => m.content).join('\n---\n');
  }
}

function mkClient() {
  const c = new EventEmitter();
  c.user = { id: SELF, tag: 'self' };
  return c;
}

function mkPlayer() {
  const calls = [];
  return {
    calls,
    state: { channelId: null, track: null, offsetMs: 0 },
    playing: false,
    async play(ctx) {
      calls.push(['play', ctx.track?.title]);
      return { ok: true, lyrics: 3, source: 'test', duration: 1 };
    },
    async stop() {
      calls.push(['stop']);
    },
    async nudge(ms) {
      calls.push(['nudge', ms]);
      const prev = this.state.offsetMs;
      this.state.offsetMs = prev + ms;
      return { prev, next: this.state.offsetMs, replay: async () => ({ ok: true }) };
    },
  };
}

function mkMsg(content, { author = SELF, voice = true, channelId = 'chan1' } = {}) {
  const channel = new FakeChannel();
  const msg = new FakeMessage(channel, content);
  msg.author = { id: author };
  msg.channelId = channelId;
  msg.guildId = 'guild1';
  msg.member = voice ? { voice: { channel: { id: 'voice1', guildId: 'guild1' } } } : { voice: {} };
  return msg;
}

const cfg = { commands: { prefix: 'w/' }, __dir: process.cwd() };
const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' :: ' + detail}`);
};

const client = mkClient();
const player = mkPlayer();
const api = attachCommands({ client, player, cfg, log: () => {} });

// 1. w/listcmd
{
  const m = mkMsg('w/listcmd');
  await api.handleMessage(m);
  check('w/listcmd lists the commands', /w\/play/.test(m.channel.text) && /w\/search/.test(m.channel.text), m.channel.text.slice(0, 120));
}

// 2. w/help without an argument
{
  const m = mkMsg('w/help');
  await api.handleMessage(m);
  check(
    'w/help shows the command list and how to ask the AI',
    /Available commands/.test(m.channel.text) && /help <question>/.test(m.channel.text),
    m.channel.text.slice(0, 120),
  );
}

// 3. w/help with an argument while AI is not configured
{
  const m = mkMsg('w/help what is w/sync');
  await api.handleMessage(m);
  check('w/help <arg> without AI explains the configuration', /AI is not configured/.test(m.channel.text), m.channel.text.slice(0, 160));
}

// 4. w/sync without a song
{
  const m = mkMsg('w/sync +500');
  await api.handleMessage(m);
  check('w/sync without a song is rejected with a clear message', /no song is playing/.test(m.channel.text), m.channel.text.slice(0, 120));
}

// 5. w/stop without a stream
{
  const m = mkMsg('w/stop');
  await api.handleMessage(m);
  check('w/stop without a stream is safe', /no stream is running/.test(m.channel.text), m.channel.text.slice(0, 120));
}

// 6. w/play without an argument
{
  const m = mkMsg('w/play');
  await api.handleMessage(m);
  check('w/play without an argument shows the format', /Format:/.test(m.channel.text), m.channel.text.slice(0, 120));
}

// 7. w/search without Spotify credentials
{
  const m = mkMsg('w/search tulus');
  await api.handleMessage(m);
  check('w/search without Spotify explains the configuration', /SPOTIFY_CLIENT_ID/.test(m.channel.text), m.channel.text.slice(0, 120));
}

// 8. the w/p and w/cmd aliases
{
  const a = mkMsg('w/cmd');
  await api.handleMessage(a);
  const b = mkMsg('w/p');
  await api.handleMessage(b);
  check('the w/cmd alias works', /w\/play/.test(a.channel.text), a.channel.text.slice(0, 80));
  check('the w/p alias works', /Format:/.test(b.channel.text), b.channel.text.slice(0, 80));
}

// 9. messages without the prefix are ignored
{
  const m = mkMsg('hello world');
  await api.handleMessage(m);
  check('messages without the prefix are ignored', m.channel.sent.length === 0, m.channel.text);
}

// 10. unknown commands are ignored
{
  const m = mkMsg('w/nonsense');
  await api.handleMessage(m);
  check('unknown commands are ignored', m.channel.sent.length === 0, m.channel.text);
}

// 11. other users are ignored (allowOtherUsers is false)
{
  const m = mkMsg('w/listcmd', { author: 'SOMEONE_ELSE' });
  await api.handleMessage(m);
  check('messages from other users are ignored', m.channel.sent.length === 0, m.channel.text);
}

// 12. channel filter
{
  const api2 = attachCommands({
    client: mkClient(),
    player: mkPlayer(),
    cfg: { commands: { prefix: 'w/', channels: ['chanX'] }, __dir: process.cwd() },
    log: () => {},
  });
  const m = mkMsg('w/listcmd', { channelId: 'chan1' });
  await api2.handleMessage(m);
  check('channels outside the whitelist are ignored', m.channel.sent.length === 0, m.channel.text);
  const m2 = mkMsg('w/listcmd', { channelId: 'chanX' });
  await api2.handleMessage(m2);
  check('whitelisted channels get a reply', m2.channel.sent.length === 1, m2.channel.text);
}

// 13. w/sync with an active song raises the offset and triggers a replay
{
  const p = mkPlayer();
  const c = mkClient();
  const api3 = attachCommands({ client: c, player: p, cfg, log: () => {} });
  p.state.track = { title: 'Sample', artists: ['Artist'] };
  p.state.channelId = 'voice1';
  const m = mkMsg('w/sync +500');
  await api3.handleMessage(m);
  await new Promise((r) => setTimeout(r, 50));
  const nudged = p.calls.some((c2) => c2[0] === 'nudge' && c2[1] === 500);
  const joined = [...m.channel.sent.flatMap((x) => [x.content, ...x.edits])].join('\n').includes('lyric offset');
  check(
    'w/sync shifts the offset by +500',
    nudged && p.state.offsetMs === 500 && joined,
    `${JSON.stringify(p.calls)} / ${m.channel.text.slice(0, 120)}`,
  );
}

// 14. custom prefix
{
  const m = mkMsg('bot!listcmd');
  const c = mkClient();
  const api4 = attachCommands({ client: c, player: mkPlayer(), cfg: { commands: { prefix: 'bot!' }, __dir: process.cwd() }, log: () => {} });
  await api4.handleMessage(m);
  check('a custom prefix from the config is used', m.channel.sent.length === 1, m.channel.text);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} tests passed`);
process.exit(failed.length ? 1 : 0);
