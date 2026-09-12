// Plugin: telegram — the Bot API.
//
// The Bot API is a good fit for this server: it is plain HTTPS with JSON, it
// has no gateway to keep alive, and getUpdates does long polling on the
// server side. That last one matters here — `updates { wait: 30 }` is one
// blocking call that returns the moment something arrives, which is the same
// shape as shell_job and watch, and the opposite of burning tokens on a
// polling loop.
//
// The token lives in the URL, which is a small design wart with a real
// consequence: any error message that quotes the URL leaks the token. So
// nothing here ever puts a URL in a message — requests are labelled by
// method — and the plugin loader scrubs the token from anything that escapes
// anyway.

import { readFile, writeFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import process from 'node:process';
import { PolicyError, resolveSafePath } from '../../src/guards.js';
import { apiFetch } from '../../src/plugins.js';
import { truncateMiddle } from '../../src/format.js';

export const LABEL = 'Telegram: send and read messages, files, chats';

/** Actions that change something outside this machine; refused by readOnly. */
export const MUTATING_ACTIONS = [
  'send', 'send_file', 'edit', 'delete', 'forward', 'pin', 'unpin', 'react', 'raw',
];

export const TOOLS = [
  {
    name: 'telegram',
    description:
      'Talk to Telegram as a bot. send a message (Markdown or HTML), send_file to upload a ' +
      'document or photo — handy for a screenshot or a log you just produced — edit, delete, ' +
      'forward, pin and react. updates long-polls for incoming messages and returns as soon as ' +
      'one arrives, so one call replaces a polling loop; the read offset is kept server-side, so ' +
      'you never see the same message twice. Also chat and admins for context, download to fetch ' +
      'a file someone sent, and raw for any Bot API method this does not wrap.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'me', 'send', 'send_file', 'edit', 'delete', 'forward',
            'updates', 'chat', 'admins', 'pin', 'unpin', 'react', 'download', 'raw',
          ],
          description: 'What to do.',
        },
        chat: { type: 'string', description: 'Target chat: a numeric id, or @channelusername. Defaults to the configured chat.' },
        text: { type: 'string', description: 'send/edit: the message text. Up to 4096 characters; longer is split.' },
        parse_mode: { type: 'string', enum: ['MarkdownV2', 'Markdown', 'HTML', 'none'], description: 'send/edit: how to format the text. Default none, which is the safe choice — Telegram rejects unbalanced markup.' },
        message_id: { type: 'integer', description: 'edit/delete/pin/unpin/react/forward: which message.' },
        reply_to: { type: 'integer', description: 'send: make this a reply to that message id.' },
        silent: { type: 'boolean', description: 'send: deliver without a notification sound.' },
        path: { type: 'string', description: 'send_file: the file to upload. download: where to save.' },
        kind: { type: 'string', enum: ['auto', 'document', 'photo', 'video', 'audio', 'voice'], description: 'send_file: how Telegram should present it. Default auto, from the extension.' },
        caption: { type: 'string', description: 'send_file: text shown with the file.' },
        from_chat: { type: 'string', description: 'forward: the chat the message is coming from.' },
        emoji: { type: 'string', description: 'react: the reaction emoji, e.g. "👍".' },
        file_id: { type: 'string', description: 'download: the file_id from an incoming message.' },
        wait: { type: 'integer', description: 'updates: block up to this many seconds waiting for a message. Default 0 (return what is queued). Up to 60.' },
        limit: { type: 'integer', description: 'updates: maximum messages to return. Default 20.' },
        peek: { type: 'boolean', description: 'updates: do not advance the read offset, so the same messages come back next time.' },
        method: { type: 'string', description: 'raw: Bot API method name, e.g. "sendDice".' },
        params: { type: 'object', description: 'raw: JSON parameters for that method.' },
        max_bytes: { type: 'integer', description: 'Byte cap on returned text.' },
      },
      required: ['action'],
    },
  },
];

const FILE_KINDS = {
  '.png': 'photo', '.jpg': 'photo', '.jpeg': 'photo', '.webp': 'photo', '.gif': 'photo',
  '.mp4': 'video', '.mov': 'video', '.mkv': 'video',
  '.mp3': 'audio', '.m4a': 'audio', '.flac': 'audio', '.wav': 'audio',
  '.ogg': 'voice', '.oga': 'voice',
};

const KIND_METHOD = {
  document: { method: 'sendDocument', field: 'document' },
  photo: { method: 'sendPhoto', field: 'photo' },
  video: { method: 'sendVideo', field: 'video' },
  audio: { method: 'sendAudio', field: 'audio' },
  voice: { method: 'sendVoice', field: 'voice' },
};

// Telegram's own limits, enforced here so a long message becomes several
// messages instead of a 400 from the API.
const MAX_TEXT = 4096;
const MAX_CAPTION = 1024;

export function describe({ settings, secret }) {
  const token = secret(settings.token ?? 'env:TELEGRAM_BOT_TOKEN');
  if (!token) {
    return 'no token — set pluginConfig.telegram.token or $TELEGRAM_BOT_TOKEN';
  }
  const bits = [`token set (…${token.slice(-4)})`];
  if (settings.defaultChat) bits.push(`default chat ${settings.defaultChat}`);
  if (settings.allowedChats?.length) bits.push(`${settings.allowedChats.length} allowed chat(s)`);
  return bits.join(', ');
}

export function createHandlers({ cfg, settings, redactor, secret }) {
  const token = secret(settings.token ?? 'env:TELEGRAM_BOT_TOKEN');
  const apiBase = (settings.apiBase ?? 'https://api.telegram.org').replace(/\/+$/, '');
  const allowed = (settings.allowedChats ?? []).map(String);
  const timeoutMs = settings.timeoutMs ?? 30000;

  // One offset per bot, kept here for the life of the process: it is what
  // makes `updates` return only what is new.
  let offset = 0;

  function requireToken() {
    if (!token) {
      throw new Error(
        'No Telegram bot token. Set it in the config file as pluginConfig.telegram.token ' +
        '(the value "env:TELEGRAM_BOT_TOKEN" reads it from that environment variable), ' +
        'or export TELEGRAM_BOT_TOKEN. Get a token from @BotFather.',
      );
    }
  }

  function chatId(given, action) {
    const id = String(given ?? settings.defaultChat ?? '').trim();
    if (!id) {
      throw new Error(
        `${action} needs "chat" — a numeric chat id or @channelusername. ` +
        'Set pluginConfig.telegram.defaultChat to avoid passing it every time. ' +
        'To learn your chat id, message the bot and call updates.',
      );
    }
    if (allowed.length && !allowed.includes(id)) {
      throw new PolicyError(
        `chat ${id} is not in telegram.allowedChats (${allowed.join(', ')}). ` +
        'The operator restricted which chats this bot may touch.',
      );
    }
    return id;
  }

  /** Call a Bot API method. Never lets the URL (which holds the token) out. */
  async function call(method, params = null, { timeout = timeoutMs } = {}) {
    requireToken();
    const init = { method: 'POST', timeoutMs: timeout, redactor, label: `Telegram ${method}` };
    if (params instanceof FormData) {
      init.body = params;
    } else if (params) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(params);
    }

    const { status, json, raw } = await apiFetch(`${apiBase}/bot${token}/${method}`, init);
    if (json?.ok) return json.result;

    const why = json?.description ?? truncateMiddle(raw, 400).text ?? `HTTP ${status}`;
    // Telegram's own descriptions are genuinely useful, so they are passed
    // through — with the two most common causes spelled out, because
    // "chat not found" almost always means the bot was never spoken to.
    const hint =
      status === 401
        ? ' — the token is wrong or revoked'
        : /chat not found/i.test(why)
          ? ' — the bot cannot see that chat. Send it a message first (a bot cannot start a conversation), and for a group add the bot to it.'
          : /bot was blocked|bot can't initiate/i.test(why)
            ? ' — the user blocked the bot, or never started it'
            : /can't parse entities|can't parse entities/i.test(why)
              ? ' — the markup is unbalanced. Use parse_mode "none", or escape the text.'
              : '';
    throw new Error(`Telegram ${method} failed (HTTP ${status}): ${why}${hint}`);
  }

  /** Telegram rejects anything over 4096 characters, so split on lines. */
  function splitText(text, max) {
    const s = String(text);
    if (s.length <= max) return [s];
    const parts = [];
    let current = '';
    for (const line of s.split('\n')) {
      if (current.length + line.length + 1 > max) {
        if (current) parts.push(current);
        // A single line longer than the limit still has to be cut.
        if (line.length > max) {
          for (let i = 0; i < line.length; i += max) parts.push(line.slice(i, i + max));
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

  function textParams(a, base) {
    const p = { ...base };
    if (a.parse_mode && a.parse_mode !== 'none') p.parse_mode = a.parse_mode;
    return p;
  }

  function who(from) {
    if (!from) return 'unknown';
    const name = [from.first_name, from.last_name].filter(Boolean).join(' ');
    return from.username ? `@${from.username}` : name || `id ${from.id}`;
  }

  function renderUpdate(u) {
    const m = u.message ?? u.edited_message ?? u.channel_post ?? u.callback_query?.message;
    const kind = u.callback_query ? 'button' : u.edited_message ? 'edit' : 'message';
    if (!m) return `#${u.update_id} ${Object.keys(u).filter((k) => k !== 'update_id').join(',')}`;

    const bits = [`#${u.update_id}`, `[msg ${m.message_id}]`, kind];
    bits.push(`chat ${m.chat?.id}${m.chat?.title ? ` (${m.chat.title})` : m.chat?.type === 'private' ? ' (private)' : ''}`);
    bits.push(`from ${who(u.callback_query?.from ?? m.from)}`);

    let body = u.callback_query?.data ? `data=${u.callback_query.data}` : (m.text ?? m.caption ?? '');
    if (!body) {
      const attach = ['photo', 'document', 'video', 'audio', 'voice', 'sticker', 'location'].find((k) => m[k]);
      if (attach) {
        const f = Array.isArray(m[attach]) ? m[attach][m[attach].length - 1] : m[attach];
        body = `<${attach}${f?.file_name ? ` ${f.file_name}` : ''}${f?.file_id ? ` file_id=${f.file_id}` : ''}>`;
      }
    }
    if (m.reply_to_message) bits.push(`reply to ${m.reply_to_message.message_id}`);
    return `${bits.join(' ')}\n    ${body || '(no text)'}`;
  }

  return {
    async telegram(a) {
      const action = a.action;
      if (!action) throw new Error('telegram needs "action"');
      const cap = a.max_bytes ?? cfg.maxOutputBytes;

      switch (action) {
        case 'me': {
          const me = await call('getMe');
          return (
            `@${me.username} (${me.first_name}), id ${me.id}\n` +
            `can join groups: ${me.can_join_groups ? 'yes' : 'no'}, ` +
            `reads all group messages: ${me.can_read_all_group_messages ? 'yes' : 'no (privacy mode on — it only sees commands and replies)'}\n` +
            `${settings.defaultChat ? `default chat: ${settings.defaultChat}` : 'no default chat configured'}`
          );
        }

        case 'send': {
          if (a.text === undefined || a.text === null || a.text === '') throw new Error('send needs "text"');
          const chat = chatId(a.chat, 'send');
          const chunks = splitText(a.text, MAX_TEXT);
          const ids = [];
          for (const [i, chunk] of chunks.entries()) {
            const sent = await call(
              'sendMessage',
              textParams(a, {
                chat_id: chat,
                text: chunk,
                // Only the first chunk replies to anything; the rest follow it.
                ...(a.reply_to && i === 0 ? { reply_to_message_id: a.reply_to } : {}),
                ...(a.silent ? { disable_notification: true } : {}),
              }),
            );
            ids.push(sent.message_id);
          }
          return (
            `sent to chat ${chat}${chunks.length > 1 ? ` in ${chunks.length} parts (Telegram caps a message at ${MAX_TEXT} characters)` : ''}\n` +
            `message id ${ids.join(', ')}`
          );
        }

        case 'send_file': {
          if (!a.path) throw new Error('send_file needs "path"');
          const chat = chatId(a.chat, 'send_file');
          const abs = resolveSafePath(cfg, a.path);
          const st = await stat(abs).catch(() => null);
          if (!st) throw new Error(`Not found: ${abs}`);
          if (st.isDirectory()) throw new Error(`${abs} is a directory. Archive it first with the archive tool.`);
          // Telegram's own ceiling for bot uploads.
          if (st.size > 50 * 1024 * 1024) {
            throw new Error(`${basename(abs)} is ${(st.size / 1048576).toFixed(1)}MB; a bot may upload at most 50MB.`);
          }

          const kind = a.kind && a.kind !== 'auto' ? a.kind : (FILE_KINDS[extname(abs).toLowerCase()] ?? 'document');
          const { method, field } = KIND_METHOD[kind] ?? KIND_METHOD.document;

          const form = new FormData();
          form.set('chat_id', chat);
          if (a.caption) form.set('caption', splitText(a.caption, MAX_CAPTION)[0]);
          if (a.parse_mode && a.parse_mode !== 'none') form.set('parse_mode', a.parse_mode);
          if (a.silent) form.set('disable_notification', 'true');
          if (a.reply_to) form.set('reply_to_message_id', String(a.reply_to));
          form.set(field, new Blob([await readFile(abs)]), basename(abs));

          // Uploads deserve longer than a text message.
          const sent = await call(method, form, { timeout: Math.max(timeoutMs, 120000) });
          return `uploaded ${basename(abs)} (${st.size} bytes) to chat ${chat} as ${kind}, message id ${sent.message_id}`;
        }

        case 'edit': {
          if (!a.message_id) throw new Error('edit needs "message_id"');
          if (!a.text) throw new Error('edit needs "text"');
          const chat = chatId(a.chat, 'edit');
          await call('editMessageText', textParams(a, {
            chat_id: chat,
            message_id: a.message_id,
            text: splitText(a.text, MAX_TEXT)[0],
          }));
          return `edited message ${a.message_id} in chat ${chat}`;
        }

        case 'delete': {
          if (!a.message_id) throw new Error('delete needs "message_id"');
          const chat = chatId(a.chat, 'delete');
          await call('deleteMessage', { chat_id: chat, message_id: a.message_id });
          return `deleted message ${a.message_id} from chat ${chat}`;
        }

        case 'forward': {
          if (!a.message_id) throw new Error('forward needs "message_id"');
          if (!a.from_chat) throw new Error('forward needs "from_chat"');
          const chat = chatId(a.chat, 'forward');
          const sent = await call('forwardMessage', {
            chat_id: chat,
            from_chat_id: a.from_chat,
            message_id: a.message_id,
          });
          return `forwarded to chat ${chat} as message ${sent.message_id}`;
        }

        case 'pin':
        case 'unpin': {
          if (action === 'pin' && !a.message_id) throw new Error('pin needs "message_id"');
          const chat = chatId(a.chat, action);
          await call(action === 'pin' ? 'pinChatMessage' : 'unpinChatMessage', {
            chat_id: chat,
            ...(a.message_id ? { message_id: a.message_id } : {}),
          });
          return `${action}ned message ${a.message_id ?? '(most recent)'} in chat ${chat}`;
        }

        case 'react': {
          if (!a.message_id) throw new Error('react needs "message_id"');
          const chat = chatId(a.chat, 'react');
          await call('setMessageReaction', {
            chat_id: chat,
            message_id: a.message_id,
            reaction: a.emoji ? [{ type: 'emoji', emoji: a.emoji }] : [],
          });
          return a.emoji
            ? `reacted ${a.emoji} to message ${a.message_id}`
            : `cleared reactions on message ${a.message_id}`;
        }

        case 'updates': {
          const waitSeconds = Math.min(Math.max(a.wait ?? 0, 0), 60);
          const limit = Math.min(Math.max(a.limit ?? 20, 1), 100);
          // Telegram holds the request open, so the HTTP timeout must outlast
          // the long poll or we would abort our own wait.
          const updates = await call(
            'getUpdates',
            { offset, limit, timeout: waitSeconds },
            { timeout: (waitSeconds + 20) * 1000 },
          );

          if (!a.peek && updates.length) {
            // Acknowledging by offset is how Telegram drops what we have read.
            offset = updates[updates.length - 1].update_id + 1;
          }
          if (!updates.length) {
            return (
              `no new messages${waitSeconds ? ` in ${waitSeconds}s` : ''}. ` +
              `Waiting at offset ${offset}. ` +
              'If you expected one: a bot in a group only sees commands and replies unless ' +
              'privacy mode is off (see action "me").'
            );
          }
          const body = updates.map(renderUpdate).join('\n');
          return (
            `${updates.length} update(s)${a.peek ? ' (peeked: they will come back again)' : `, offset now ${offset}`}\n` +
            truncateMiddle(body, cap).text
          );
        }

        case 'chat': {
          const chat = chatId(a.chat, 'chat');
          const info = await call('getChat', { chat_id: chat });
          const count = await call('getChatMemberCount', { chat_id: chat }).catch(() => null);
          return [
            `${info.title ?? [info.first_name, info.last_name].filter(Boolean).join(' ')} (${info.type})`,
            `id ${info.id}${info.username ? `  @${info.username}` : ''}`,
            count !== null ? `${count} member(s)` : null,
            info.description ? `description: ${info.description}` : null,
            info.pinned_message ? `pinned: message ${info.pinned_message.message_id}` : null,
          ].filter(Boolean).join('\n');
        }

        case 'admins': {
          const chat = chatId(a.chat, 'admins');
          const admins = await call('getChatAdministrators', { chat_id: chat });
          const rows = admins.map(
            (m) => `${m.status.padEnd(9)} ${who(m.user)}${m.user.is_bot ? ' (bot)' : ''}${m.custom_title ? ` — ${m.custom_title}` : ''}`,
          );
          return `${admins.length} admin(s) in chat ${chat}\n${rows.join('\n')}`;
        }

        case 'download': {
          if (!a.file_id) throw new Error('download needs "file_id" (action "updates" shows one for each attachment)');
          if (cfg.readOnly) throw new PolicyError('readOnly is on, so nothing will be written to disk');
          const info = await call('getFile', { file_id: a.file_id });
          if (!info.file_path) throw new Error('Telegram returned no file_path; the file may have expired');

          const target = resolveSafePath(cfg, a.path ?? basename(info.file_path), { forWrite: true });
          const { res, buffer: buf } = await apiFetch(`${apiBase}/file/bot${token}/${info.file_path}`, {
            timeoutMs: Math.max(timeoutMs, 120000),
            redactor,
            label: 'Telegram file download',
            binary: true,
          });
          if (!res.ok) throw new Error(`Telegram file download failed: HTTP ${res.status}`);
          await writeFile(target, buf);
          return `saved ${target} (${buf.length} bytes, ${info.file_size ?? '?'} reported)`;
        }

        case 'raw': {
          if (!a.method) throw new Error('raw needs "method" — any Bot API method name');
          const result = await call(a.method, a.params ?? {});
          return truncateMiddle(JSON.stringify(result, null, 2), cap).text;
        }

        default:
          throw new Error(
            `Unknown telegram action "${action}". ` +
            'Try: me, send, send_file, updates, chat, admins, edit, delete, forward, pin, react, download, raw.',
          );
      }
    },
  };
}
