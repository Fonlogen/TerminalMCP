// Plugin: discord — the REST API, and webhooks.
//
// Two modes, because two quite different things get called "Discord
// integration":
//
//   webhook  A URL you paste in. No bot, no permissions, no setup — it can
//            only post to the one channel it belongs to. Perfect for "tell me
//            when the deploy finishes".
//   bot      A bot token. Reads channels, edits and deletes, reacts, opens
//            threads, lists members. Needs an application and an invite.
//
// The gateway (Discord's WebSocket) is deliberately not used. It would mean
// heartbeats, resume state and intents for the sake of push delivery, and
// `wait` gets most of that value by polling REST inside one blocking call —
// which is the same bargain shell_job and watch already make.

import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { PolicyError, resolveSafePath } from '../../src/guards.js';
import { apiFetch } from '../../src/plugins.js';
import { ms, truncateMiddle } from '../../src/format.js';

export const LABEL = 'Discord: post, read, react, upload — bot or webhook';

/** Actions that change something outside this machine; refused by readOnly. */
export const MUTATING_ACTIONS = [
  'send', 'edit', 'delete', 'react', 'thread', 'typing', 'upload', 'raw',
];

export const TOOLS = [
  {
    name: 'discord',
    description:
      'Talk to Discord. send posts a message (via a bot token, or via a webhook URL when there ' +
      'is no bot), upload attaches a file — a screenshot or a log you just produced — and read ' +
      'returns recent messages from a channel. wait blocks until a new message arrives, so one ' +
      'call replaces a polling loop. Also edit, delete, react, thread, typing, guilds, channels, ' +
      'members, and raw for any endpoint this does not wrap.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'me', 'guilds', 'channels', 'channel', 'members',
            'send', 'upload', 'read', 'wait', 'edit', 'delete', 'react', 'thread', 'typing', 'raw',
          ],
          description: 'What to do.',
        },
        channel: { type: 'string', description: 'Channel id. Defaults to the configured channel. (Enable Developer Mode in Discord to copy ids.)' },
        guild: { type: 'string', description: 'Guild (server) id, for channels and members.' },
        text: { type: 'string', description: 'send/edit: the message. Up to 2000 characters; longer is split.' },
        message_id: { type: 'integer', description: 'edit/delete/react/thread: which message. Ids are numbers but very large — pass them as given.' },
        reply_to: { type: 'string', description: 'send: make this a reply to that message id.' },
        webhook: { type: 'boolean', description: 'send: post through the configured webhook URL instead of as the bot.' },
        username: { type: 'string', description: 'send with webhook: override the displayed name.' },
        path: { type: 'string', description: 'upload: the file to attach.' },
        caption: { type: 'string', description: 'upload: message text to go with the file.' },
        emoji: { type: 'string', description: 'react: a unicode emoji ("👍") or a custom one as name:id.' },
        name: { type: 'string', description: 'thread: the thread name.' },
        limit: { type: 'integer', description: 'read: how many messages. Default 20, max 100. members: default 50.' },
        after: { type: 'string', description: 'read/wait: only messages after this message id.' },
        wait: { type: 'integer', description: 'wait: block up to this many seconds. Default 30, max 300.' },
        mentions: { type: 'boolean', description: 'send: allow @everyone and role pings to actually notify. Default false — a tool that can ping a whole server by accident is a bad tool.' },
        method: { type: 'string', description: 'raw: HTTP method. Default GET.' },
        endpoint: { type: 'string', description: 'raw: path under the API root, e.g. "/guilds/123/roles".' },
        body: { type: 'object', description: 'raw: JSON body.' },
        max_bytes: { type: 'integer', description: 'Byte cap on returned text.' },
      },
      required: ['action'],
    },
  },
];

// Discord's own limit. Longer text becomes several messages rather than a 400.
const MAX_CONTENT = 2000;

const CHANNEL_TYPES = {
  0: 'text', 1: 'dm', 2: 'voice', 3: 'group-dm', 4: 'category', 5: 'announcement',
  10: 'news-thread', 11: 'thread', 12: 'private-thread', 13: 'stage', 15: 'forum', 16: 'media',
};

export function describe({ settings, secret }) {
  const token = secret(settings.token ?? 'env:DISCORD_BOT_TOKEN');
  const webhook = secret(settings.webhook ?? 'env:DISCORD_WEBHOOK_URL');
  const modes = [];
  if (token) modes.push(`bot token (…${token.slice(-4)})`);
  if (webhook) modes.push('webhook url');
  if (!modes.length) {
    return 'not configured — set pluginConfig.discord.token ($DISCORD_BOT_TOKEN) or .webhook ($DISCORD_WEBHOOK_URL)';
  }
  if (settings.defaultChannel) modes.push(`default channel ${settings.defaultChannel}`);
  if (settings.allowedChannels?.length) modes.push(`${settings.allowedChannels.length} allowed channel(s)`);
  return modes.join(', ');
}

export function createHandlers({ cfg, settings, redactor, secret }) {
  const token = secret(settings.token ?? 'env:DISCORD_BOT_TOKEN');
  const webhookUrl = secret(settings.webhook ?? 'env:DISCORD_WEBHOOK_URL');
  const apiBase = (settings.apiBase ?? 'https://discord.com/api/v10').replace(/\/+$/, '');
  const allowed = (settings.allowedChannels ?? []).map(String);
  const timeoutMs = settings.timeoutMs ?? 30000;

  // Where `wait` resumes from, per channel, for the life of the process.
  const lastSeen = new Map();

  function requireToken(action) {
    if (!token) {
      throw new Error(
        `discord "${action}" needs a bot token. Set pluginConfig.discord.token ` +
        '(or "env:DISCORD_BOT_TOKEN"), from the Bot tab of your application at ' +
        'discord.com/developers/applications.' +
        `${webhookUrl ? ' A webhook is configured, but a webhook can only post — it cannot read, edit or react.' : ''}`,
      );
    }
  }

  function channelId(given, action) {
    const id = String(given ?? settings.defaultChannel ?? '').trim();
    if (!id) {
      throw new Error(
        `${action} needs "channel" — a channel id. Turn on Developer Mode in Discord ` +
        '(Settings → Advanced) to copy one, or set pluginConfig.discord.defaultChannel. ' +
        'Action "channels" lists them for a guild.',
      );
    }
    if (allowed.length && !allowed.includes(id)) {
      throw new PolicyError(
        `channel ${id} is not in discord.allowedChannels (${allowed.join(', ')}). ` +
        'The operator restricted which channels this bot may touch.',
      );
    }
    return id;
  }

  /**
   * One REST call, with the one piece of Discord etiquette that matters:
   * a 429 is answered by waiting exactly as long as Discord asks, once.
   */
  async function rest(method, endpoint, { body = null, form = null, retry = true } = {}) {
    requireToken(endpoint);
    const headers = {
      Authorization: `Bot ${token}`,
      // Discord asks for an identifying agent and is entitled to one.
      'User-Agent': 'TerminalMCP (https://github.com/Fonlogen/TerminalMCP, 0.1)',
    };
    let payload = null;
    if (form) {
      payload = form;
    } else if (body !== null) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const url = `${apiBase}${endpoint}`;
    const { status, json, raw, headers: resHeaders } = await apiFetch(url, {
      method,
      headers,
      body: payload,
      timeoutMs,
      redactor,
      label: `Discord ${method} ${endpoint}`,
    });

    if (status === 429 && retry) {
      const after = Number(json?.retry_after ?? resHeaders.get('retry-after') ?? 1);
      // Discord's retry_after is seconds, and obeying it is cheaper than
      // being rate-limited harder for ignoring it.
      await new Promise((r) => setTimeout(r, Math.min(after * 1000 + 100, 30000)));
      return rest(method, endpoint, { body, form, retry: false });
    }

    if (status >= 200 && status < 300) return json ?? {};

    const why = json?.message ?? truncateMiddle(raw, 300).text ?? `HTTP ${status}`;
    const hint =
      status === 401
        ? ' — the bot token is wrong or was reset'
        : status === 403
          ? ' — the bot lacks permission here. Check its role in the channel; listing members also needs the ' +
            'Server Members intent enabled in the developer portal.'
          : status === 404
            ? ' — no such channel, message or guild, or the bot cannot see it'
            : status === 429
              ? ' — rate limited twice in a row; slow down'
              : '';
    const detail = json?.errors ? `\n${truncateMiddle(JSON.stringify(json.errors), 400).text}` : '';
    throw new Error(`Discord ${method} ${endpoint} failed (HTTP ${status}): ${why}${hint}${detail}`);
  }

  function splitContent(text) {
    const s = String(text);
    if (s.length <= MAX_CONTENT) return [s];
    const parts = [];
    let current = '';
    for (const line of s.split('\n')) {
      if (current.length + line.length + 1 > MAX_CONTENT) {
        if (current) parts.push(current);
        if (line.length > MAX_CONTENT) {
          for (let i = 0; i < line.length; i += MAX_CONTENT) parts.push(line.slice(i, i + MAX_CONTENT));
          current = '';
          continue;
        }
        current = line;
      } else {
        current = current ? `${current}\n${line}` : line;
      }
    }
    if (current) parts.push(current);
    return parts;
  }

  /** Off by default: a tool that can ping an entire server by accident is bad. */
  function mentionPolicy(a) {
    return a.mentions ? undefined : { parse: [] };
  }

  async function sendViaWebhook(a) {
    if (!webhookUrl) {
      throw new Error(
        'No webhook configured. Set pluginConfig.discord.webhook (or "env:DISCORD_WEBHOOK_URL") — ' +
        'in Discord: channel settings → Integrations → Webhooks → New Webhook → Copy URL.',
      );
    }
    const chunks = splitContent(a.text);
    const ids = [];
    for (const chunk of chunks) {
      const { status, json, raw } = await apiFetch(`${webhookUrl}?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: chunk,
          ...(a.username ? { username: a.username } : {}),
          allowed_mentions: mentionPolicy(a),
        }),
        timeoutMs,
        redactor,
        label: 'Discord webhook POST',
      });
      if (status < 200 || status >= 300) {
        throw new Error(
          `Discord webhook failed (HTTP ${status}): ${json?.message ?? truncateMiddle(raw, 200).text}` +
          `${status === 404 ? ' — the webhook was deleted, or the URL is wrong' : ''}`,
        );
      }
      if (json?.id) ids.push(json.id);
    }
    return (
      `posted via webhook${chunks.length > 1 ? ` in ${chunks.length} parts (Discord caps a message at ${MAX_CONTENT} characters)` : ''}` +
      `${ids.length ? `\nmessage id ${ids.join(', ')}` : ''}`
    );
  }

  function renderMessage(m) {
    const when = m.timestamp ? new Date(m.timestamp).toISOString().slice(11, 19) : '--:--:--';
    const author = m.author?.username ?? 'unknown';
    const bot = m.author?.bot ? ' [bot]' : '';
    const extras = [];
    if (m.attachments?.length) {
      extras.push(...m.attachments.map((f) => `<attachment ${f.filename} ${f.size}B ${f.url}>`));
    }
    if (m.embeds?.length) extras.push(`<${m.embeds.length} embed(s)>`);
    if (m.edited_timestamp) extras.push('(edited)');
    const body = [m.content, ...extras].filter(Boolean).join(' ');
    return `${when} ${m.id} ${author}${bot}: ${body || '(no text)'}`;
  }

  async function fetchMessages(channel, { limit = 20, after = null }) {
    const params = new URLSearchParams({ limit: String(Math.min(Math.max(limit, 1), 100)) });
    if (after) params.set('after', String(after));
    const list = await rest('GET', `/channels/${channel}/messages?${params}`);
    // Discord returns newest first; reading order is older first.
    return Array.isArray(list) ? [...list].reverse() : [];
  }

  return {
    async discord(a) {
      const action = a.action;
      if (!action) throw new Error('discord needs "action"');
      const cap = a.max_bytes ?? cfg.maxOutputBytes;

      switch (action) {
        case 'me': {
          const me = await rest('GET', '/users/@me');
          return (
            `${me.username}${me.discriminator && me.discriminator !== '0' ? `#${me.discriminator}` : ''} (id ${me.id})\n` +
            `bot: ${me.bot ? 'yes' : 'no'}${me.verified ? ', verified' : ''}\n` +
            `${webhookUrl ? 'a webhook is also configured' : 'no webhook configured'}` +
            `${settings.defaultChannel ? `\ndefault channel: ${settings.defaultChannel}` : ''}`
          );
        }

        case 'guilds': {
          const guilds = await rest('GET', '/users/@me/guilds');
          if (!guilds.length) return 'The bot is not in any guild yet. Invite it with the OAuth2 URL from the developer portal.';
          return (
            `${guilds.length} guild(s)\n` +
            guilds.map((g) => `${g.id}  ${g.name}${g.owner ? ' (owner)' : ''}`).join('\n')
          );
        }

        case 'channels': {
          if (!a.guild) throw new Error('channels needs "guild" (action "guilds" lists the ids)');
          const list = await rest('GET', `/guilds/${a.guild}/channels`);
          const rows = list
            .sort((x, y) => (x.position ?? 0) - (y.position ?? 0))
            .map((c) => `${c.id}  ${(CHANNEL_TYPES[c.type] ?? `type${c.type}`).padEnd(13)}${c.name}${c.topic ? ` — ${c.topic.slice(0, 60)}` : ''}`);
          return `${list.length} channel(s)\n${truncateMiddle(rows.join('\n'), cap).text}`;
        }

        case 'channel': {
          const id = channelId(a.channel, 'channel');
          const c = await rest('GET', `/channels/${id}`);
          return [
            `#${c.name ?? id} (${CHANNEL_TYPES[c.type] ?? `type${c.type}`})`,
            `id ${c.id}${c.guild_id ? `, guild ${c.guild_id}` : ''}`,
            c.topic ? `topic: ${c.topic}` : null,
            c.rate_limit_per_user ? `slow mode: ${c.rate_limit_per_user}s` : null,
            c.nsfw ? 'nsfw' : null,
          ].filter(Boolean).join('\n');
        }

        case 'members': {
          if (!a.guild) throw new Error('members needs "guild"');
          const limit = Math.min(Math.max(a.limit ?? 50, 1), 1000);
          const list = await rest('GET', `/guilds/${a.guild}/members?limit=${limit}`);
          const rows = list.map(
            (m) => `${m.user?.id}  ${m.user?.username}${m.user?.bot ? ' [bot]' : ''}${m.nick ? ` (${m.nick})` : ''}${m.roles?.length ? `  ${m.roles.length} role(s)` : ''}`,
          );
          return `${list.length} member(s)\n${truncateMiddle(rows.join('\n'), cap).text}`;
        }

        case 'send': {
          if (a.text === undefined || a.text === null || a.text === '') throw new Error('send needs "text"');
          // A webhook needs no token, so it is checked before the token is.
          if (a.webhook || (!token && webhookUrl)) return sendViaWebhook(a);

          const channel = channelId(a.channel, 'send');
          const chunks = splitContent(a.text);
          const ids = [];
          for (const [i, chunk] of chunks.entries()) {
            const sent = await rest('POST', `/channels/${channel}/messages`, {
              body: {
                content: chunk,
                allowed_mentions: mentionPolicy(a),
                ...(a.reply_to && i === 0 ? { message_reference: { message_id: String(a.reply_to) } } : {}),
              },
            });
            ids.push(sent.id);
            lastSeen.set(channel, sent.id);
          }
          return (
            `sent to channel ${channel}${chunks.length > 1 ? ` in ${chunks.length} parts (Discord caps a message at ${MAX_CONTENT} characters)` : ''}\n` +
            `message id ${ids.join(', ')}` +
            `${a.mentions ? '' : '\n(@everyone and role pings were suppressed; pass mentions:true to allow them)'}`
          );
        }

        case 'upload': {
          if (!a.path) throw new Error('upload needs "path"');
          const channel = channelId(a.channel, 'upload');
          const abs = resolveSafePath(cfg, a.path);
          const st = await stat(abs).catch(() => null);
          if (!st) throw new Error(`Not found: ${abs}`);
          if (st.isDirectory()) throw new Error(`${abs} is a directory. Archive it first with the archive tool.`);
          // The floor for an unboosted guild; boosted ones allow more, and
          // Discord will say so if this passes.
          if (st.size > 25 * 1024 * 1024) {
            throw new Error(`${basename(abs)} is ${(st.size / 1048576).toFixed(1)}MB; Discord's limit is 25MB without a boosted guild.`);
          }

          const form = new FormData();
          form.set(
            'payload_json',
            JSON.stringify({
              content: a.caption ? splitContent(a.caption)[0] : undefined,
              allowed_mentions: mentionPolicy(a),
              attachments: [{ id: 0, filename: basename(abs) }],
            }),
          );
          form.set('files[0]', new Blob([await readFile(abs)]), basename(abs));

          const sent = await rest('POST', `/channels/${channel}/messages`, { form });
          return `uploaded ${basename(abs)} (${st.size} bytes) to channel ${channel}, message id ${sent.id}`;
        }

        case 'read': {
          const channel = channelId(a.channel, 'read');
          const list = await fetchMessages(channel, { limit: a.limit ?? 20, after: a.after ?? null });
          if (!list.length) return `No messages in channel ${channel}${a.after ? ` after ${a.after}` : ''}.`;
          lastSeen.set(channel, list[list.length - 1].id);
          return (
            `${list.length} message(s) in channel ${channel}, oldest first\n` +
            truncateMiddle(list.map(renderMessage).join('\n'), cap).text
          );
        }

        case 'wait': {
          const channel = channelId(a.channel, 'wait');
          const seconds = Math.min(Math.max(a.wait ?? 30, 1), 300);
          let after = a.after ?? lastSeen.get(channel) ?? null;

          if (!after) {
            // With no reference point, start from now rather than replaying
            // the channel's history as if it were new.
            const recent = await fetchMessages(channel, { limit: 1 });
            after = recent.length ? recent[recent.length - 1].id : null;
            if (after) lastSeen.set(channel, after);
          }

          const started = Date.now();
          const deadline = started + seconds * 1000;
          const every = Math.min(Math.max(settings.pollMs ?? 2000, 500), 10000);
          for (;;) {
            const list = await fetchMessages(channel, { limit: 50, after });
            if (list.length) {
              lastSeen.set(channel, list[list.length - 1].id);
              return (
                `${list.length} new message(s) in channel ${channel} after ${ms(Date.now() - started)}\n` +
                truncateMiddle(list.map(renderMessage).join('\n'), cap).text
              );
            }
            if (Date.now() + every >= deadline) break;
            await new Promise((r) => setTimeout(r, every));
          }
          return (
            `nothing new in channel ${channel} within ${seconds}s` +
            `${after ? ` (watching after message ${after})` : ''}.`
          );
        }

        case 'edit': {
          if (!a.message_id) throw new Error('edit needs "message_id"');
          if (!a.text) throw new Error('edit needs "text"');
          const channel = channelId(a.channel, 'edit');
          await rest('PATCH', `/channels/${channel}/messages/${a.message_id}`, {
            body: { content: splitContent(a.text)[0], allowed_mentions: mentionPolicy(a) },
          });
          return `edited message ${a.message_id} in channel ${channel}`;
        }

        case 'delete': {
          if (!a.message_id) throw new Error('delete needs "message_id"');
          const channel = channelId(a.channel, 'delete');
          await rest('DELETE', `/channels/${channel}/messages/${a.message_id}`);
          return `deleted message ${a.message_id} from channel ${channel}`;
        }

        case 'react': {
          if (!a.message_id) throw new Error('react needs "message_id"');
          if (!a.emoji) throw new Error('react needs "emoji" — a unicode emoji, or name:id for a custom one');
          const channel = channelId(a.channel, 'react');
          await rest(
            'PUT',
            `/channels/${channel}/messages/${a.message_id}/reactions/${encodeURIComponent(a.emoji)}/@me`,
          );
          return `reacted ${a.emoji} to message ${a.message_id}`;
        }

        case 'thread': {
          if (!a.name) throw new Error('thread needs "name"');
          const channel = channelId(a.channel, 'thread');
          const endpoint = a.message_id
            ? `/channels/${channel}/messages/${a.message_id}/threads`
            : `/channels/${channel}/threads`;
          const thread = await rest('POST', endpoint, {
            body: {
              name: String(a.name).slice(0, 100),
              auto_archive_duration: 1440,
              ...(a.message_id ? {} : { type: 11 }),
            },
          });
          return `created thread "${thread.name}" (id ${thread.id})${a.message_id ? ` on message ${a.message_id}` : ''}`;
        }

        case 'typing': {
          const channel = channelId(a.channel, 'typing');
          await rest('POST', `/channels/${channel}/typing`);
          return `typing indicator sent to channel ${channel} (lasts about 10 seconds)`;
        }

        case 'raw': {
          if (!a.endpoint) throw new Error('raw needs "endpoint", e.g. "/guilds/123/roles"');
          const method = (a.method ?? 'GET').toUpperCase();
          const endpoint = a.endpoint.startsWith('/') ? a.endpoint : `/${a.endpoint}`;
          const out = await rest(method, endpoint, { body: a.body ?? null });
          return truncateMiddle(JSON.stringify(out, null, 2), cap).text;
        }

        default:
          throw new Error(
            `Unknown discord action "${action}". ` +
            'Try: me, guilds, channels, send, upload, read, wait, edit, delete, react, thread, members, raw.',
          );
      }
    },
  };
}
