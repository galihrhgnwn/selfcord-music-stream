import { createRequire } from 'node:module';
import { MessageActionRow } from '@lng2004/discord.js-selfbot-v13';
import { HELP_TOPICS } from './features.js';

/**
 * Select menus.
 *
 * discord.js v14 names these `ActionRowBuilder` and `StringSelectMenuBuilder`.
 * This selfbot fork ships the v13 line, where the equivalents are
 * `MessageActionRow` and a `STRING_SELECT` component with the same option
 * shape (label, value, description, emoji, default). The component is built
 * from raw data so the payload is identical either way.
 */

const SELECT_TYPE = 'STRING_SELECT';
const MAX_OPTIONS = 25;

const require = createRequire(import.meta.url);

/**
 * Can this build deliver a MESSAGE_COMPONENT interaction to us?
 *
 * The selfbot fork has no INTERACTION_CREATE gateway handler, so a click on a
 * menu we sent never reaches the process: the menu renders, the click does
 * nothing. We still send the menus, and the handler in commands.js runs the
 * moment a build delivers the event (a fork with the handler, or a bot token).
 */
export const COMPONENT_INTERACTIONS = (() => {
  try {
    require.resolve('@lng2004/discord.js-selfbot-v13/src/client/websocket/handlers/INTERACTION_CREATE.js');
    return true;
  } catch {
    return false;
  }
})();

const trim = (value, max) => {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

export const fmtDur = (sec) => {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Discord limits: 25 options, label/description/value 100 chars, placeholder 150. */
export function selectRow({ customId, placeholder, options, extra = {} }) {
  const opts = (options || []).slice(0, MAX_OPTIONS).map((o, i) => {
    const opt = { label: trim(o.label, 100) || `option ${i + 1}`, value: trim(o.value ?? String(i), 100) };
    if (o.description) opt.description = trim(o.description, 100);
    if (o.emoji) opt.emoji = o.emoji;
    if (o.default) opt.default = true;
    return opt;
  });
  return new MessageActionRow().addComponents({
    type: SELECT_TYPE,
    custom_id: trim(customId, 100),
    placeholder: trim(placeholder, 150),
    options: opts,
    ...extra,
  });
}

/** Grey out a menu once it has been used. */
export function disableComponents(row) {
  for (const c of row?.components || []) c.disabled = true;
  return row;
}

/** Spotify results, value = the index into the stored result list. */
export function searchMenu(results, channelId, { disabled = false } = {}) {
  const row = selectRow({
    customId: `search:${channelId}`,
    placeholder: 'Pick a result to play',
    options: results.map((t, i) => ({
      label: `${t.title}${t.artist ? ` - ${t.artist}` : ''}`,
      value: String(i),
      description: t.duration ? fmtDur(t.duration) : undefined,
    })),
    extra: { disabled },
  });
  return row;
}

/** Help topics, value = the 1-based topic number. */
export function helpMenu({ disabled = false } = {}) {
  return selectRow({
    customId: 'help',
    placeholder: 'Pick a help topic',
    options: HELP_TOPICS.map((t, i) => ({
      label: t.q,
      value: String(i + 1),
      description: `Topic ${i + 1}`,
    })),
    extra: { disabled },
  });
}
