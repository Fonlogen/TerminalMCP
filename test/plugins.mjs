// Optional plugins: the loader, and all three integrations end to end.
//
// The integrations are driven against local mock servers rather than against
// Discord, Telegram and a real FiveM box. That is not a compromise on the
// protocol — the mocks speak the real wire format, and the FiveM one is an
// actual UDP socket that checks the RCON packet byte for byte — it just means
// the suite runs anywhere, with no accounts and no secrets.
//
// What it deliberately does cover: that a token never leaks into an error,
// that readOnly refuses the actions that reach outside the machine, and that
// allow/deny lists are enforced before a packet is sent.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import dgram from 'node:dgram';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'bin', 'terminalmcp.js');

const TG_TOKEN = '123456:AAH-fake-telegram-token-for-tests';
const DISCORD_TOKEN = 'MTIzNDU2Nzg5.fake.discord-bot-token-for-tests';
const RCON_PASSWORD = 'super-secret-rcon-password';
const BRIDGE_SECRET = 'bridge-secret-of-sufficient-length';

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failures.push(`${name} — ${detail}`); console.log(`  FAIL ${name} — ${detail}`); }
}

class Client {
  constructor(cwd, extraArgs = [], env = {}) {
    this.id = 0;
    this.pending = new Map();
    this.buf = '';
    this.proc = spawn(process.execPath, [ENTRY, '--cwd', cwd, ...extraArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => this._onData(d));
    this.stderr = '';
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => { this.stderr += d; });
  }
  _onData(d) {
    this.buf += d;
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); p(msg); }
    }
  }
  send(method, params) {
    const id = ++this.id;
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout on ${method}`)), 60000);
      this.pending.set(id, (m) => { clearTimeout(t); res(m); });
    });
  }
  async call(name, args) {
    const res = await this.send('tools/call', { name, arguments: args });
    if (res.error) return { isError: true, text: res.error.message };
    return { isError: Boolean(res.result?.isError), text: res.result?.content?.[0]?.text ?? '' };
  }
  async tools() {
    return ((await this.send('tools/list', {})).result?.tools ?? []).map((t) => t.name);
  }
  async init() {
    await this.send('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'plugin-test', version: '1' },
    });
    return this;
  }
  close() { this.proc.stdin.end(); this.proc.kill(); }
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------ mock Telegram
function mockTelegram() {
  const state = { calls: [], updates: [], nextMessageId: 100, file: Buffer.from([0, 1, 2, 253, 254, 255]) };
  const srv = createServer(async (req, res) => {
    const raw = await readBody(req);
    const m = req.url.match(/^\/bot([^/]+)\/(\w+)/);
    const fileMatch = req.url.match(/^\/file\/bot([^/]+)\/(.+)$/);

    if (fileMatch) {
      if (fileMatch[1] !== TG_TOKEN) return json(res, 401, { ok: false, description: 'Unauthorized' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(state.file);
    }
    if (!m) return json(res, 404, { ok: false, description: 'not found' });

    const [, token, method] = m;
    const body = raw.length && req.headers['content-type']?.includes('json') ? JSON.parse(raw.toString()) : {};
    state.calls.push({ method, body, raw: raw.toString('latin1'), contentType: req.headers['content-type'] });

    if (token !== TG_TOKEN) return json(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });

    switch (method) {
      case 'getMe':
        return json(res, 200, { ok: true, result: { id: 42, username: 'testbot', first_name: 'Test', can_join_groups: true, can_read_all_group_messages: false } });
      case 'sendMessage': {
        if (String(body.chat_id) === '999') {
          return json(res, 200, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
        }
        return json(res, 200, { ok: true, result: { message_id: state.nextMessageId++ } });
      }
      case 'sendDocument':
      case 'sendPhoto':
        return json(res, 200, { ok: true, result: { message_id: state.nextMessageId++ } });
      case 'editMessageText':
      case 'deleteMessage':
      case 'pinChatMessage':
      case 'setMessageReaction':
        return json(res, 200, { ok: true, result: true });
      case 'getUpdates': {
        const offset = Number(body.offset ?? 0);
        const ready = state.updates.filter((u) => u.update_id >= offset);
        if (ready.length || !body.timeout) return json(res, 200, { ok: true, result: ready.slice(0, body.limit ?? 20) });
        // Long poll: answer when something shows up, or when the wait is over.
        const started = Date.now();
        const tick = setInterval(() => {
          const now = state.updates.filter((u) => u.update_id >= offset);
          if (now.length || Date.now() - started > body.timeout * 1000) {
            clearInterval(tick);
            json(res, 200, { ok: true, result: now.slice(0, body.limit ?? 20) });
          }
        }, 50);
        return undefined;
      }
      case 'getChat':
        return json(res, 200, { ok: true, result: { id: Number(body.chat_id) || body.chat_id, type: 'group', title: 'Test Group' } });
      case 'getChatMemberCount':
        return json(res, 200, { ok: true, result: 7 });
      case 'getChatAdministrators':
        return json(res, 200, { ok: true, result: [{ status: 'creator', user: { id: 1, username: 'ada', first_name: 'Ada' } }] });
      case 'getFile':
        return json(res, 200, { ok: true, result: { file_path: 'documents/file_1.bin', file_size: state.file.length } });
      case 'sendDice':
        return json(res, 200, { ok: true, result: { message_id: 777, dice: { value: 4 } } });
      default:
        return json(res, 200, { ok: false, error_code: 404, description: `Not Found: method "${method}" not supported` });
    }
  });
  return { srv, state };
}

// ------------------------------------------------------------- mock Discord
function mockDiscord() {
  const state = { calls: [], messages: [], nextId: 1000, rateLimitOnce: false, forbid: new Set() };
  const srv = createServer(async (req, res) => {
    const raw = await readBody(req);
    const url = new URL(req.url, 'http://x');
    const auth = req.headers.authorization ?? '';
    state.calls.push({ method: req.method, path: url.pathname, auth, raw: raw.toString('latin1'), contentType: req.headers['content-type'] });

    // A webhook is a bare URL: it carries no Authorization header, which is
    // the whole point of it, so it is handled before the bot auth check.
    if (url.pathname === '/hook/abc') {
      const wh = JSON.parse(raw.toString());
      state.messages.push({ id: String(state.nextId++), content: wh.content, author: { username: wh.username ?? 'hook' }, timestamp: new Date().toISOString(), attachments: [] });
      return json(res, 200, { id: String(state.nextId), content: wh.content });
    }
    if (auth !== `Bot ${DISCORD_TOKEN}`) {
      return json(res, 401, { message: '401: Unauthorized', code: 0 });
    }
    if (state.rateLimitOnce) {
      state.rateLimitOnce = false;
      return json(res, 429, { message: 'You are being rate limited.', retry_after: 0.1, global: false });
    }

    const body = raw.length && req.headers['content-type']?.includes('json') ? JSON.parse(raw.toString()) : {};
    const p = url.pathname;

    if (p === '/users/@me') return json(res, 200, { id: '1', username: 'testbot', bot: true, discriminator: '0' });
    if (p === '/users/@me/guilds') return json(res, 200, [{ id: 'g1', name: 'Test Guild', owner: true }]);
    if (p === '/guilds/g1/channels') {
      return json(res, 200, [
        { id: 'c1', name: 'general', type: 0, position: 0 },
        { id: 'c2', name: 'logs', type: 0, position: 1, topic: 'deploy output' },
      ]);
    }
    if (p === '/guilds/g1/members') {
      return json(res, 200, [{ user: { id: 'u1', username: 'ada' }, roles: ['r1'] }]);
    }
    if (p === '/guilds/gx/members') return json(res, 403, { message: 'Missing Access', code: 50001 });
    if (p === '/channels/c1') return json(res, 200, { id: 'c1', name: 'general', type: 0, guild_id: 'g1', topic: 'the main one' });

    if (p === '/channels/c1/messages' && req.method === 'POST') {
      const msg = {
        id: String(state.nextId++),
        content: body.content,
        author: { username: 'testbot', bot: true },
        timestamp: new Date().toISOString(),
        allowed_mentions: body.allowed_mentions,
        message_reference: body.message_reference,
        attachments: [],
      };
      state.messages.push(msg);
      return json(res, 200, msg);
    }
    if (p === '/channels/c1/messages' && req.method === 'GET') {
      const after = url.searchParams.get('after');
      let list = state.messages;
      if (after) list = list.filter((m) => Number(m.id) > Number(after));
      const limit = Number(url.searchParams.get('limit') ?? 50);
      // Discord answers newest first.
      return json(res, 200, [...list].reverse().slice(0, limit));
    }
    if (/^\/channels\/c1\/messages\/\d+$/.test(p) && req.method === 'PATCH') {
      return json(res, 200, { id: p.split('/').pop(), content: body.content });
    }
    if (/^\/channels\/c1\/messages\/\d+$/.test(p) && req.method === 'DELETE') {
      return json(res, 204, {});
    }
    if (/reactions/.test(p) && req.method === 'PUT') return json(res, 204, {});
    if (/threads$/.test(p) && req.method === 'POST') return json(res, 200, { id: 't1', name: body.name });
    if (/typing$/.test(p)) return json(res, 204, {});
    return json(res, 404, { message: '404: Not Found', code: 0 });
  });
  return { srv, state };
}

// --------------------------------------------------------------- mock FiveM
function mockFiveMHttp() {
  const state = { bridgeCalls: [], txCalls: [], loggedIn: false, bridgeResource: 'terminalmcp_bridge' };
  const srv = createServer(async (req, res) => {
    const raw = await readBody(req);
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (p === '/info.json') {
      return json(res, 200, {
        version: 7290,
        resources: ['spawnmanager', 'chat', 'mapmanager', 'my-custom-resource', state.bridgeResource],
        vars: { sv_projectName: 'Test Roleplay', sv_enforceGameBuild: '2802', onesync_enabled: 'true', sv_projectDesc: 'a test server' },
      });
    }
    if (p === '/players.json') {
      return json(res, 200, [
        { id: 1, name: 'Ada', ping: 34, identifiers: ['license:aaa', 'steam:bbb'] },
        { id: 3, name: 'Grace', ping: 51, identifiers: ['license:ccc'] },
      ]);
    }
    if (p === '/dynamic.json') {
      return json(res, 200, { clients: 2, sv_maxclients: 48, hostname: 'Test Roleplay', gametype: 'Roleplay', mapname: 'Los Santos' });
    }

    // ---- the optional bridge resource
    // FiveM routes on the first path segment, which is the resource's FOLDER
    // name — so the mock accepts whatever name it is given and records it,
    // exactly as a real server would only answer on its own name.
    const bridgeMatch = p.match(/^\/([^/]+)\/(ping|client_exec|client_lua|server_lua)$/);
    if (bridgeMatch && bridgeMatch[1] === state.bridgeResource) {
      const endpoint = bridgeMatch[2];
      const secret = req.headers['x-terminalmcp-secret'];
      state.bridgeCalls.push({ endpoint, secret, path: p, body: raw.toString() });
      if (secret !== BRIDGE_SECRET) return json(res, 401, { ok: false, error: 'bad or missing secret' });
      const body = raw.length ? JSON.parse(raw.toString()) : {};
      if (endpoint === 'ping') return json(res, 200, { ok: true, version: '0.1.0', resource: 'terminalmcp_bridge', players: 2 });
      if (endpoint === 'client_exec') {
        if (body.player === '99') return json(res, 200, { ok: false, error: 'player 99 is not connected' });
        return json(res, 200, { ok: true, note: 'ran it' });
      }
      if (endpoint === 'client_lua') return json(res, 200, { ok: true, result: { x: 1.5, y: 2.5, z: 3.5 } });
      if (endpoint === 'server_lua') return json(res, 200, { ok: true, result: 2 });
      return json(res, 404, { ok: false, error: 'unknown endpoint', resource: state.bridgeResource });
    }

    // ---- txAdmin
    if (p === '/auth/password' && req.method === 'POST') {
      const body = JSON.parse(raw.toString());
      state.txCalls.push({ path: p, body });
      if (body.username !== 'admin' || body.password !== 'tx-password') {
        return json(res, 200, { error: 'Wrong username or password!' });
      }
      state.loggedIn = true;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'txAdmin-sess=abc123; Path=/; HttpOnly' });
      return res.end(JSON.stringify({ name: 'admin', csrfToken: 'csrf-token-value' }));
    }
    if (p === '/host/status') {
      if (req.headers['x-txadmin-envtoken'] !== 'tx-env-token-1234567890') {
        return json(res, 401, { error: 'invalid token' });
      }
      return json(res, 200, { status: 'online', uptime: 1234, players: 2 });
    }
    if (p === '/fxserver/controls' || p === '/fxserver/commands') {
      const body = JSON.parse(raw.toString());
      state.txCalls.push({ path: p, body, cookie: req.headers.cookie, csrf: req.headers['x-txadmin-csrftoken'] });
      if (!req.headers.cookie?.includes('txAdmin-sess')) return json(res, 401, { error: 'no session' });
      if (!req.headers['x-txadmin-csrftoken']) return json(res, 403, { error: 'missing csrf token' });
      if (body.action === 'explode') return json(res, 200, { type: 'error', msg: 'that is not a thing' });
      return json(res, 200, { type: 'success', msg: 'done' });
    }
    if (p === '/fxserver/downloadLog') {
      if (!req.headers.cookie?.includes('txAdmin-sess')) return json(res, 401, { error: 'no session' });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(['line one', 'ERROR something broke', 'line three'].join('\n'));
    }
    return json(res, 404, { error: 'not found' });
  });
  return { srv, state };
}

/** A UDP responder that speaks the real Quake3 RCON wire format. */
function mockRcon() {
  const state = { received: [], reply: 'default reply', packets: 1, silent: false };
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    state.received.push(msg);
    if (state.silent) return;

    const header = msg.subarray(0, 4);
    const text = msg.subarray(4).toString('utf8');
    const m = text.match(/^rcon (\S+) ([\s\S]*)$/);
    if (!header.equals(Buffer.from([0xff, 0xff, 0xff, 0xff])) || !m) return;

    const [, password, command] = m;
    const send = (body) => {
      const packet = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from(`print${body}`, 'utf8')]);
      sock.send(packet, rinfo.port, rinfo.address);
    };
    if (password !== RCON_PASSWORD) return send('\nInvalid password.\n');
    state.lastCommand = command;

    if (state.packets > 1) {
      // A long reply really does arrive in several datagrams.
      for (let i = 0; i < state.packets; i++) {
        setTimeout(() => send(`\npart ${i + 1} of ${state.packets}`), i * 40);
      }
      return;
    }
    send(`\n${state.reply.replace('{cmd}', command)}`);
  });
  return { sock, state };
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'tmcp-plugins-'));

  const tg = mockTelegram();
  const dc = mockDiscord();
  const fm = mockFiveMHttp();
  const rc = mockRcon();

  await new Promise((r) => tg.srv.listen(0, '127.0.0.1', r));
  await new Promise((r) => dc.srv.listen(0, '127.0.0.1', r));
  await new Promise((r) => fm.srv.listen(0, '127.0.0.1', r));
  await new Promise((r) => rc.sock.bind(0, '127.0.0.1', r));

  const tgBase = `http://127.0.0.1:${tg.srv.address().port}`;
  const dcBase = `http://127.0.0.1:${dc.srv.address().port}`;
  const fmPort = fm.srv.address().port;
  const rconPort = rc.sock.address().port;

  // A port nothing listens on: bind one, note it, let it go.
  const closedPort = await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

  const configPath = join(dir, 'cfg.json');
  await writeFile(
    configPath,
    JSON.stringify({
      plugins: ['fivem', 'discord', 'telegram'],
      pluginConfig: {
        telegram: {
          token: TG_TOKEN,
          apiBase: tgBase,
          defaultChat: '555',
          allowedChats: ['555', '777', '999'],
        },
        discord: {
          token: DISCORD_TOKEN,
          apiBase: dcBase,
          webhook: `${dcBase}/hook/abc`,
          defaultChannel: 'c1',
          pollMs: 300,
        },
        fivem: {
          host: '127.0.0.1',
          port: fmPort,
          rconPort,
          rconPassword: RCON_PASSWORD,
          denyCommands: ['^quit', 'stop\\s+essential'],
          bridge: { secret: BRIDGE_SECRET },
          txadmin: {
            url: `http://127.0.0.1:${fmPort}`,
            user: 'admin',
            password: 'tx-password',
            envToken: 'tx-env-token-1234567890',
          },
        },
      },
    }),
    'utf8',
  );

  const c = await new Client(dir, [], { TERMINALMCP_CONFIG: configPath }).init();

  try {
    console.log('\n--- the loader ---');
    {
      const names = await c.tools();
      check('plugin tools are exposed', ['fivem', 'discord', 'telegram'].every((n) => names.includes(n)), names.join(','));
      check('the built-in tools are still there', names.includes('shell_exec') && names.includes('browser'), names.join(','));

      const bare = await new Client(dir, [], { TERMINALMCP_CONFIG: join(dir, 'none.json') }).init();
      const bareNames = await bare.tools();
      check('a plugin is absent unless asked for', !bareNames.some((n) => ['fivem', 'discord', 'telegram'].includes(n)), bareNames.join(','));
      check('...even under the "all" profile', bareNames.length > 20, String(bareNames.length));
      bare.close();

      const removed = await new Client(dir, ['--tools', 'all,-telegram'], { TERMINALMCP_CONFIG: configPath }).init();
      const removedNames = await removed.tools();
      check('a loaded plugin can still be removed with -name', !removedNames.includes('telegram') && removedNames.includes('discord'), removedNames.join(','));
      removed.close();

      const trimmed = await new Client(dir, ['--tools', 'core'], { TERMINALMCP_CONFIG: configPath }).init();
      const trimmedNames = await trimmed.tools();
      check('a plugin survives a minimal profile, since naming it was the request', trimmedNames.includes('telegram'), trimmedNames.join(','));
      trimmed.close();
    }

    console.log('\n--- a broken plugin does not take the server down ---');
    {
      const bad = join(dir, 'not-a-plugin.js');
      await writeFile(bad, 'export const NOPE = 1;\n');
      const badClient = new Client(dir, ['--plugin', bad, '--plugin', 'nosuchthing'], { TERMINALMCP_CONFIG: join(dir, 'none.json') });
      await badClient.init();
      const names = await badClient.tools();
      check('the server still starts', names.includes('shell_exec'), names.join(','));
      check('a module that is not a plugin is reported', /must export TOOLS and createHandlers/.test(badClient.stderr), badClient.stderr.slice(0, 300));
      check('an unknown name lists the built-in ones', /Built in: fivem, discord, telegram/.test(badClient.stderr), badClient.stderr.slice(0, 300));
      badClient.close();
    }

    console.log('\n--- telegram ---');
    {
      let r = await c.call('telegram', { action: 'me' });
      check('me identifies the bot', !r.isError && /@testbot/.test(r.text), r.text);
      check('me warns about privacy mode', /privacy mode on/.test(r.text), r.text);

      r = await c.call('telegram', { action: 'send', text: 'hello from the test' });
      check('send uses the default chat', !r.isError && /chat 555/.test(r.text), r.text);
      const sent = tg.state.calls.find((x) => x.method === 'sendMessage');
      check('...and really sent the text', sent?.body?.text === 'hello from the test', JSON.stringify(sent?.body));

      r = await c.call('telegram', { action: 'send', text: 'x'.repeat(9000) });
      check('an over-long message is split rather than rejected', !r.isError && /3 parts/.test(r.text), r.text);

      r = await c.call('telegram', { action: 'send', chat: '999', text: 'nope' });
      check('a Telegram error comes back readably', r.isError && /chat not found/.test(r.text), r.text);
      check('...with the reason it usually happens', /cannot start a conversation|send it a message first/i.test(r.text), r.text);

      r = await c.call('telegram', { action: 'send', chat: '111', text: 'nope' });
      check('a chat outside allowedChats is refused before any request', r.isError && /allowedChats/.test(r.text), r.text);

      const before = tg.state.calls.length;
      await c.call('telegram', { action: 'send', chat: '111', text: 'nope' });
      check('...and really sent nothing', tg.state.calls.length === before, `${tg.state.calls.length} vs ${before}`);

      const file = join(dir, 'shot.png');
      await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
      r = await c.call('telegram', { action: 'send_file', path: file, caption: 'a screenshot' });
      check('send_file uploads', !r.isError && /uploaded shot\.png/.test(r.text), r.text);
      check('...as a photo, from the extension', /as photo/.test(r.text), r.text);
      const upload = tg.state.calls.find((x) => x.method === 'sendPhoto');
      check('...over multipart', /multipart\/form-data/.test(upload?.contentType ?? ''), upload?.contentType);
      check('...carrying the filename', /shot\.png/.test(upload?.raw ?? ''), (upload?.raw ?? '').slice(0, 200));

      tg.state.updates = [
        { update_id: 10, message: { message_id: 1, chat: { id: 555, title: 'Test Group' }, from: { id: 2, username: 'ada' }, text: 'first' } },
        { update_id: 11, message: { message_id: 2, chat: { id: 555, title: 'Test Group' }, from: { id: 2, username: 'ada' }, text: 'second' } },
      ];
      r = await c.call('telegram', { action: 'updates' });
      check('updates returns queued messages', !r.isError && /first/.test(r.text) && /second/.test(r.text), r.text);
      check('...and shows who sent them', /@ada/.test(r.text), r.text);

      r = await c.call('telegram', { action: 'updates' });
      check('the offset means a message is not delivered twice', /no new messages/.test(r.text), r.text);

      tg.state.updates.push({ update_id: 12, message: { message_id: 3, chat: { id: 555 }, from: { id: 2, username: 'ada' }, text: 'third' } });
      r = await c.call('telegram', { action: 'updates', peek: true });
      check('peek returns without consuming', /third/.test(r.text) && /peeked/.test(r.text), r.text);
      r = await c.call('telegram', { action: 'updates' });
      check('...so the same message is still there next time', /third/.test(r.text), r.text);

      const started = Date.now();
      const waiter = c.call('telegram', { action: 'updates', wait: 5 });
      setTimeout(() => {
        tg.state.updates.push({ update_id: 13, message: { message_id: 4, chat: { id: 555 }, from: { id: 9, first_name: 'Late' }, text: 'arrived late' } });
      }, 400);
      r = await waiter;
      const waited = Date.now() - started;
      check('a long poll returns as soon as a message arrives', /arrived late/.test(r.text), r.text);
      check('...having actually waited for it', waited > 300 && waited < 5000, `${waited}ms`);

      r = await c.call('telegram', { action: 'chat' });
      check('chat describes the conversation', /Test Group/.test(r.text) && /7 member/.test(r.text), r.text);

      r = await c.call('telegram', { action: 'admins' });
      check('admins lists them', /creator/.test(r.text) && /@ada/.test(r.text), r.text);

      r = await c.call('telegram', { action: 'download', path: join(dir, 'got.bin'), file_id: 'f1' });
      check('download saves a file', !r.isError && /got\.bin/.test(r.text), r.text);
      const got = await readFile(join(dir, 'got.bin')).catch(() => null);
      check('...with the bytes intact, not mangled as text', got?.equals(tg.state.file), got ? [...got].join(',') : 'missing');

      r = await c.call('telegram', { action: 'raw', method: 'sendDice', params: { chat_id: '555' } });
      check('raw reaches any Bot API method', !r.isError && /"value": 4/.test(r.text), r.text);

      r = await c.call('telegram', { action: 'raw', method: 'noSuchMethod', params: {} });
      check('an unknown method is reported clearly', r.isError && /not supported/.test(r.text), r.text);

      r = await c.call('telegram', { action: 'nope' });
      check('an unknown action lists the real ones', r.isError && /me, send, send_file/.test(r.text), r.text);
    }

    console.log('\n--- telegram: the token never leaks ---');
    {
      const leaky = await new Client(dir, [], {
        TERMINALMCP_CONFIG: join(dir, 'leaky.json'),
      }).init();
      await writeFile(
        join(dir, 'leaky.json'),
        JSON.stringify({
          plugins: ['telegram'],
          pluginConfig: { telegram: { token: TG_TOKEN, apiBase: 'http://127.0.0.1:1', defaultChat: '1' } },
        }),
      );
      leaky.close();

      const l2 = await new Client(dir, [], { TERMINALMCP_CONFIG: join(dir, 'leaky.json') }).init();
      const r = await l2.call('telegram', { action: 'me' });
      check('a connection failure is reported', r.isError, r.text);
      check('and the token is not in the message', !r.text.includes(TG_TOKEN), r.text);
      check('the message still says what failed', /Telegram getMe/.test(r.text), r.text);
      l2.close();
    }

    console.log('\n--- discord ---');
    {
      let r = await c.call('discord', { action: 'me' });
      check('me identifies the bot', !r.isError && /testbot/.test(r.text), r.text);

      r = await c.call('discord', { action: 'guilds' });
      check('guilds lists them', /Test Guild/.test(r.text), r.text);

      r = await c.call('discord', { action: 'channels', guild: 'g1' });
      check('channels lists them with ids and types', /c1\s+text\s+general/.test(r.text), r.text);

      r = await c.call('discord', { action: 'send', text: 'deploy finished' });
      check('send posts to the default channel', !r.isError && /channel c1/.test(r.text), r.text);
      const posted = dc.state.calls.find((x) => x.method === 'POST' && x.path === '/channels/c1/messages');
      check('...with the right content', /deploy finished/.test(posted?.raw ?? ''), posted?.raw);
      check('...suppressing pings by default', /"allowed_mentions":\{"parse":\[\]\}/.test(posted?.raw ?? ''), posted?.raw);
      check('...and saying so', /pings were suppressed/.test(r.text), r.text);

      r = await c.call('discord', { action: 'send', text: '@everyone real ping', mentions: true });
      check('mentions:true allows them through', !r.isError && !/suppressed/.test(r.text), r.text);

      r = await c.call('discord', { action: 'read', limit: 5 });
      check('read returns messages oldest first', /deploy finished/.test(r.text), r.text);
      const lines = r.text.split('\n').filter((l) => /testbot/.test(l));
      check('...in that order', lines.length >= 2 && lines[0].includes('deploy finished'), lines.join(' | '));

      dc.state.rateLimitOnce = true;
      r = await c.call('discord', { action: 'send', text: 'after a 429' });
      check('a 429 is waited out and retried once', !r.isError && /channel c1/.test(r.text), r.text);

      r = await c.call('discord', { action: 'members', guild: 'gx' });
      check('a 403 explains the intent that is probably missing', r.isError && /Server Members intent/.test(r.text), r.text);

      r = await c.call('discord', { action: 'send', channel: 'c9', text: 'nope' });
      check('a channel outside allowedChannels is refused', r.isError || !/channel c9/.test(r.text), r.text);

      const file = join(dir, 'log.txt');
      await writeFile(file, 'build output\n');
      r = await c.call('discord', { action: 'upload', path: file, caption: 'the build log' });
      check('upload attaches a file', !r.isError && /uploaded log\.txt/.test(r.text), r.text);
      const up = dc.state.calls.find((x) => x.contentType?.includes('multipart'));
      check('...as multipart with payload_json', /payload_json/.test(up?.raw ?? ''), (up?.raw ?? '').slice(0, 200));

      r = await c.call('discord', { action: 'send', text: 'via the hook', webhook: true, username: 'Deploy Bot' });
      check('a webhook post works without touching the bot API', !r.isError && /webhook/.test(r.text), r.text);

      r = await c.call('discord', { action: 'edit', message_id: 1000, text: 'edited' });
      check('edit works', !r.isError && /edited message 1000/.test(r.text), r.text);

      r = await c.call('discord', { action: 'react', message_id: 1000, emoji: '👍' });
      check('react works', !r.isError && /reacted/.test(r.text), r.text);

      r = await c.call('discord', { action: 'delete', message_id: 1000 });
      check('delete works', !r.isError && /deleted message 1000/.test(r.text), r.text);

      r = await c.call('discord', { action: 'thread', message_id: 1001, name: 'a thread' });
      check('thread creation works', !r.isError && /created thread/.test(r.text), r.text);

      // Sync the read point first: `wait` deliberately returns anything that
      // arrived since the last read, so without this it would return the
      // backlog immediately — correct, but not what this assertion is about.
      await c.call('discord', { action: 'read', limit: 1 });
      const started = Date.now();
      const waiter = c.call('discord', { action: 'wait', wait: 6 });
      setTimeout(() => {
        dc.state.messages.push({
          id: String(dc.state.nextId++), content: 'a new one', author: { username: 'ada' },
          timestamp: new Date().toISOString(), attachments: [],
        });
      }, 600);
      r = await waiter;
      check('wait blocks until a message arrives', /a new one/.test(r.text), r.text);
      check('...having waited for it', Date.now() - started > 500, `${Date.now() - started}ms`);

      r = await c.call('discord', { action: 'wait', wait: 1 });
      check('wait reports an empty window rather than erroring', !r.isError && /nothing new/.test(r.text), r.text);

      // Nothing is waiting when this arrives, so the next wait must still see
      // it: messages between calls are not allowed to fall through the gap.
      dc.state.messages.push({
        id: String(dc.state.nextId++), content: 'arrived between calls', author: { username: 'ada' },
        timestamp: new Date().toISOString(), attachments: [],
      });
      r = await c.call('discord', { action: 'wait', wait: 2 });
      check('a message that arrived between calls is not missed', /arrived between calls/.test(r.text), r.text);

      r = await c.call('discord', { action: 'raw', endpoint: '/channels/c1' });
      check('raw reaches any endpoint', !r.isError && /"name": "general"/.test(r.text), r.text);

      r = await c.call('discord', { action: 'nope' });
      check('an unknown action lists the real ones', r.isError && /me, guilds, channels/.test(r.text), r.text);
    }

    console.log('\n--- fivem: the endpoints that need no password ---');
    {
      let r = await c.call('fivem', { action: 'status' });
      check('status works with no credentials at all', !r.isError && /Test Roleplay/.test(r.text), r.text);
      check('...and reports the player count', /2\/48/.test(r.text), r.text);
      check('...and the resource count', /resources 5/.test(r.text), r.text);
      check('...and says no RCON was involved', /no RCON password involved/.test(r.text), r.text);

      r = await c.call('fivem', { action: 'players' });
      check('players lists them by id', /Ada/.test(r.text) && /Grace/.test(r.text), r.text);
      check('...with ping and identifier counts', /ping\s+34/.test(r.text) && /2 identifier/.test(r.text), r.text);

      r = await c.call('fivem', { action: 'resources', match: 'custom' });
      check('resources can be filtered', /my-custom-resource/.test(r.text) && !/spawnmanager/.test(r.text), r.text);

      // A closed port, not a blocked one: this must exercise a real refused
      // connection, which is what a wrong port actually looks like.
      r = await c.call('fivem', { action: 'status', port: closedPort });
      check('a refused connection is explained, not just failed', r.isError && /Nothing is listening/.test(r.text), r.text);
      check('...and names the port to use instead', /game\/HTTP port/.test(r.text), r.text);

      r = await c.call('fivem', { action: 'status', port: 1 });
      check('a port the runtime refuses to dial says why', r.isError && /bad port/.test(r.text), r.text);
    }

    console.log('\n--- fivem: reading the manifest before reading the code ---');
    {
      const {
        classifyResourceFiles,
        escrowLabel,
        escrowStatus,
        globToRegExp,
        parseEscrowIgnore,
        stripLuaComments,
      } = await import('../plugins/fivem/plugin.js');

      const manifest = [
        "fx_version 'cerulean'",
        "game 'gta5'",
        "-- escrow_ignore { 'commented_out.lua' }",
        '--[[ escrow_ignore { "block_commented.lua" } ]]',
        'escrow_ignore {',
        "  'config.lua',",
        '  "client/cl_open.lua",',
        "  'locales/**/*.lua',",
        '}',
        "dependency '/assetpacks'",
      ].join('\n');

      const globs = parseEscrowIgnore(manifest);
      check('escrow_ignore is read from the manifest', globs.length === 3, JSON.stringify(globs));
      check('...keeping both quote styles', globs.includes('client/cl_open.lua'), JSON.stringify(globs));
      check('a commented-out directive is not obeyed', !globs.includes('commented_out.lua'), JSON.stringify(globs));
      check('...nor one inside a block comment', !globs.includes('block_commented.lua'), JSON.stringify(globs));
      check('comments are stripped without eating code', /fx_version/.test(stripLuaComments(manifest)));
      check('the one-line form is read too', parseEscrowIgnore("escrow_ignore { 'a.lua', 'b.lua' }").length === 2);
      check('...and the call form with parentheses', parseEscrowIgnore("escrow_ignore({ 'a.lua' })").length === 1);
      check('a manifest with no directive yields nothing', parseEscrowIgnore("fx_version 'cerulean'").length === 0);

      check('* stays inside one path segment', globToRegExp('client/*.lua').test('client/a.lua') && !globToRegExp('client/*.lua').test('client/sub/a.lua'));
      check('** crosses directories', globToRegExp('locales/**/*.lua').test('locales/it/it.lua'));
      check('...and also matches none of them', globToRegExp('locales/**/*.lua').test('locales/en.lua'));
      check('a literal path matches only itself', globToRegExp('config.lua').test('config.lua') && !globToRegExp('config.lua').test('other/config.lua'));

      const files = [
        'fxmanifest.lua', 'config.lua', 'client/cl_open.lua', 'client/cl_main.lua',
        'locales/it.lua', 'server/sv_main.lua', 'html/ui.js', 'stream/car.ytd', 'x.fxap',
      ];
      const st = escrowStatus({ manifest, files });
      check('an .fxap makes it certain', st.escrowed && st.certain, JSON.stringify(st.signals));
      check('...and every signal is reported', st.signals.length === 3, JSON.stringify(st.signals));
      check('escrow_ignore alone is only escrow-ready', escrowLabel(escrowStatus({ manifest, files: ['fxmanifest.lua'] })) === 'ESCROW-READY');
      check('no signals at all is open', escrowLabel(escrowStatus({ manifest: "fx_version 'cerulean'", files: ['a.lua'] })) === 'open');

      const c1 = classifyResourceFiles(files, st.globs);
      check('the manifest is always readable', c1.readable.includes('fxmanifest.lua'), c1.readable.join(','));
      check('listed files are readable', c1.readable.includes('config.lua') && c1.readable.includes('locales/it.lua'), c1.readable.join(','));
      check('unlisted scripts are encrypted', c1.encrypted.includes('client/cl_main.lua') && c1.encrypted.includes('server/sv_main.lua'), c1.encrypted.join(','));
      check('javascript counts as a script', c1.encrypted.includes('html/ui.js'), c1.encrypted.join(','));
      check('assets are neither', c1.assets.includes('stream/car.ytd'), c1.assets.join(','));
      const c2 = classifyResourceFiles(files, [], { escrowed: false });
      check('with no escrow, nothing is called encrypted', c2.encrypted.length === 0 && c2.readable.includes('server/sv_main.lua'), c2.encrypted.join(','));

      // And now the whole thing, against a folder shaped like a real server's.
      const res = join(dir, 'resources');
      const paid = join(res, '[esx]', 'esx_policejob');
      await mkdir(join(paid, 'client'), { recursive: true });
      await mkdir(join(paid, 'server'), { recursive: true });
      await mkdir(join(paid, 'locales', 'extra'), { recursive: true });
      await writeFile(join(paid, 'fxmanifest.lua'), manifest);
      await writeFile(join(paid, 'config.lua'), 'Config = {}\n'.repeat(50));
      await writeFile(join(paid, 'client', 'cl_open.lua'), '-- open\n');
      await writeFile(join(paid, 'client', 'cl_main.lua'), 'GARBAGE'.repeat(100));
      await writeFile(join(paid, 'server', 'sv_main.lua'), 'GARBAGE'.repeat(100));
      await writeFile(join(paid, 'locales', 'extra', 'nl.lua'), 'Locales = {}\n');
      await writeFile(join(paid, 'esx_policejob.fxap'), 'FXAP');

      const open = join(res, 'myscript');
      await mkdir(open, { recursive: true });
      await writeFile(join(open, '__resource.lua'), "resource_manifest_version '44febabe-d386-4d18-afbe-5e627f4af937'\nclient_script 'client.lua'\n");
      await writeFile(join(open, 'client.lua'), 'print("hi")\n');

      let r = await c.call('fivem', { action: 'inspect', dir: res, resource: 'esx_policejob' });
      check('inspect finds a resource inside a [category] folder', !r.isError && /esx_policejob/.test(r.text), r.text.slice(0, 200));
      check('...and calls it escrowed', /ESCROWED/.test(r.text), r.text.slice(0, 200));
      check('...naming the .fxap as the reason', /\.fxap file is present/.test(r.text), r.text.slice(0, 300));
      check('...listing the readable files', /config\.lua/.test(r.text) && /cl_open\.lua/.test(r.text), r.text);
      check('...with their sizes, so the cost is visible', /config\.lua\s+\d/.test(r.text), r.text);
      check('...matching ** across directories', /locales\/extra\/nl\.lua/.test(r.text), r.text);
      check('...and listing what not to read', /do not read/.test(r.text) && /cl_main\.lua/.test(r.text), r.text);
      check('...telling the reader why it matters', /ciphertext/.test(r.text), r.text);
      const readableSection = r.text.split(/^encrypted/m)[0];
      check('the encrypted files are not in the readable list',
        !/cl_main\.lua|sv_main\.lua/.test(readableSection), readableSection);

      r = await c.call('fivem', { action: 'inspect', dir: res, resource: 'myscript' });
      check('a legacy __resource.lua is understood', !r.isError && /__resource\.lua/.test(r.text), r.text);
      check('...and an open resource says read what you like', /nothing is encrypted/.test(r.text), r.text);

      r = await c.call('fivem', { action: 'inspect', dir: res });
      check('inspect with no name scans them all', !r.isError && /esx_policejob/.test(r.text) && /myscript/.test(r.text), r.text);
      check('...marking which are escrowed', /ESCROWED/.test(r.text) && /open/.test(r.text), r.text);
      check('...and counting them', /2 resource\(s\).*1 escrowed/.test(r.text), r.text);

      r = await c.call('fivem', { action: 'inspect', dir: paid });
      check('a resource folder can be given directly', !r.isError && /ESCROWED/.test(r.text), r.text.slice(0, 160));

      r = await c.call('fivem', { action: 'inspect', dir: res, resource: 'no_such_resource' });
      check('an unknown resource says what to do instead', r.isError && /lists what is there/.test(r.text), r.text);

      r = await c.call('fivem', { action: 'inspect', dir: join(dir, 'not-a-directory') });
      check('a missing directory is reported plainly', r.isError && /No such directory/.test(r.text), r.text);
    }

    console.log('\n--- fivem: RCON, on a real UDP socket ---');
    {
      rc.state.reply = 'executed: {cmd}';
      let r = await c.call('fivem', { action: 'rcon', command: 'status' });
      check('rcon gets a reply', !r.isError && /executed: status/.test(r.text), r.text);
      check('...and reports packet count and timing', /1 packet\(s\)/.test(r.text), r.text);

      const packet = rc.state.received[rc.state.received.length - 1];
      check('the packet starts with the four 0xFF bytes', packet.subarray(0, 4).equals(Buffer.from([0xff, 0xff, 0xff, 0xff])), [...packet.subarray(0, 4)].join(','));
      check('...followed by "rcon <password> <command>"', packet.subarray(4).toString() === `rcon ${RCON_PASSWORD} status`, packet.subarray(4).toString());

      rc.state.packets = 3;
      r = await c.call('fivem', { action: 'rcon', command: 'resources' });
      check('a reply split across datagrams is reassembled', /part 1 of 3/.test(r.text) && /part 3 of 3/.test(r.text), r.text);
      check('...and counted', /3 packet\(s\)/.test(r.text), r.text);
      rc.state.packets = 1;

      r = await c.call('fivem', { action: 'say', message: 'server restarting soon' });
      check('say broadcasts', !r.isError && /broadcast/.test(r.text), r.text);
      check('...as the say command', rc.state.lastCommand === 'say server restarting soon', rc.state.lastCommand);

      r = await c.call('fivem', { action: 'resource', resource: 'my-custom-resource', op: 'restart' });
      check('resource restart sends the right command', rc.state.lastCommand === 'restart my-custom-resource', rc.state.lastCommand);

      r = await c.call('fivem', { action: 'kick', player: '3', reason: 'afk' });
      check('kick sends clientkick', rc.state.lastCommand === 'clientkick 3 afk', rc.state.lastCommand);

      r = await c.call('fivem', { action: 'rcon', command: 'quit' });
      check('denyCommands refuses a command', r.isError && /denyCommands/.test(r.text), r.text);
      check('...before it reaches the socket', rc.state.lastCommand !== 'quit', rc.state.lastCommand);

      r = await c.call('fivem', { action: 'resource', resource: 'essential', op: 'stop' });
      check('a deny pattern also covers the resource action', r.isError && /denyCommands/.test(r.text), r.text);

      rc.state.silent = true;
      r = await c.call('fivem', { action: 'rcon', command: 'status', timeout_ms: 700 });
      check('silence is explained as the four things it can mean', r.isError && /firewall/.test(r.text) && /rcon_password is unset/.test(r.text), r.text);
      rc.state.silent = false;
    }

    console.log('\n--- fivem: a wrong RCON password ---');
    {
      const wrongCfg = join(dir, 'wrong-rcon.json');
      await writeFile(
        wrongCfg,
        JSON.stringify({
          plugins: ['fivem'],
          pluginConfig: { fivem: { host: '127.0.0.1', port: fmPort, rconPort, rconPassword: 'not-the-password' } },
        }),
      );
      const w = await new Client(dir, [], { TERMINALMCP_CONFIG: wrongCfg }).init();
      const r = await w.call('fivem', { action: 'rcon', command: 'status' });
      check('a wrong password is named as such', r.isError && /password is wrong/.test(r.text), r.text);
      check('...and the password itself is not echoed', !r.text.includes('not-the-password'), r.text);
      w.close();
    }

    console.log('\n--- fivem: the F8 client console ---');
    {
      const log = join(dir, 'CitizenFX.log');
      await writeFile(log, [
        '[   12345] [b2802_GTAProce]             MainThrd/ hello',
        '[   12346] [b2802_GTAProce]             MainThrd/ [script:mine] SCRIPT ERROR: @mine/client.lua:12: attempt to index a nil value',
        '[   12347] [b2802_GTAProce]             MainThrd/ all fine again',
      ].join('\n'));

      let r = await c.call('fivem', { action: 'f8', path: log });
      check('f8 reads the client log', !r.isError && /hello/.test(r.text), r.text);
      check('...and says what it is', /F8 client console log/.test(r.text), r.text);
      check('...and explains how to type into one', /bridge resource must be installed/.test(r.text), r.text);

      r = await c.call('fivem', { action: 'f8', path: log, errors: true });
      check('f8 errors:true filters to the failures', /SCRIPT ERROR/.test(r.text) && !/all fine again/.test(r.text), r.text);

      r = await c.call('fivem', { action: 'f8', path: join(dir, 'no-such.log') });
      check('a missing log is reported', r.isError && /No such log file/.test(r.text), r.text);
    }

    console.log('\n--- fivem: the optional bridge ---');
    {
      let r = await c.call('fivem', { action: 'bridge' });
      check('bridge reports the resource is up', !r.isError && /terminalmcp_bridge/.test(r.text), r.text);

      r = await c.call('fivem', { action: 'f8_exec', player: '1', command: 'say hi' });
      check('f8_exec runs a command in a client console', !r.isError && /ran in player 1/.test(r.text), r.text);
      const call = fm.state.bridgeCalls.find((x) => x.endpoint === 'client_exec');
      check('...authenticated with the secret', call?.secret === BRIDGE_SECRET, String(call?.secret));

      r = await c.call('fivem', { action: 'f8_exec', player: '99', command: 'say hi' });
      check('a disconnected player is reported', r.isError && /not connected/.test(r.text), r.text);

      r = await c.call('fivem', { action: 'client_lua', player: '1', lua: 'GetEntityCoords(PlayerPedId())' });
      check('client_lua returns a value', !r.isError && /"x": 1.5/.test(r.text), r.text);

      r = await c.call('fivem', { action: 'server_lua', lua: '#GetPlayers()' });
      check('server_lua returns a value', !r.isError && /returned:\n2/.test(r.text), r.text);
    }

    console.log('\n--- fivem: the bridge URL, which is where the resource name goes wrong ---');
    {
      // FiveM routes an HTTP request by its first path segment, and that
      // segment is the resource's folder name. Every way of getting that
      // wrong produces the same blank 404, so each one gets a test.
      const variants = [
        ['bridge.url as a bare origin keeps the resource segment', { url: `http://127.0.0.1:${fmPort}` }],
        ['bridge.url that already names the resource is not doubled', { url: `http://127.0.0.1:${fmPort}/terminalmcp_bridge` }],
        ['a trailing slash makes no difference', { url: `http://127.0.0.1:${fmPort}/terminalmcp_bridge/` }],
        ['no url at all falls back to host:port', {}],
      ];
      for (const [label, extra] of variants) {
        const cfgPath = join(dir, `bridge-${Buffer.from(label).toString('hex').slice(0, 8)}.json`);
        await writeFile(
          cfgPath,
          JSON.stringify({
            plugins: ['fivem'],
            pluginConfig: {
              fivem: { host: '127.0.0.1', port: fmPort, bridge: { secret: BRIDGE_SECRET, ...extra } },
            },
          }),
        );
        const v = await new Client(dir, [], { TERMINALMCP_CONFIG: cfgPath }).init();
        const r = await v.call('fivem', { action: 'bridge' });
        check(label, /terminalmcp_bridge/.test(r.text) && !/not reachable/.test(r.text), r.text);
        const last = fm.state.bridgeCalls[fm.state.bridgeCalls.length - 1];
        check(`  ...and hit /terminalmcp_bridge/ping exactly`, last?.path === '/terminalmcp_bridge/ping', String(last?.path));
        v.close();
      }
    }

    console.log('\n--- fivem: a resource installed under another name ---');
    {
      // The name in fxmanifest.lua is metadata; FiveM uses the folder name.
      // Renaming the folder must be a config change, not a dead end.
      fm.state.bridgeResource = 'tmcp_bridge_renamed';

      const wrongCfg = join(dir, 'bridge-wrong-name.json');
      await writeFile(
        wrongCfg,
        JSON.stringify({
          plugins: ['fivem'],
          pluginConfig: { fivem: { host: '127.0.0.1', port: fmPort, bridge: { secret: BRIDGE_SECRET } } },
        }),
      );
      const w = await new Client(dir, [], { TERMINALMCP_CONFIG: wrongCfg }).init();
      let r = await w.call('fivem', { action: 'bridge' });
      check('the wrong resource name reports what it tried', /terminalmcp_bridge/.test(r.text), r.text);
      check('...names bridge.resource as the fix', /bridge\.resource/.test(r.text), r.text);
      check('...and finds the real one in the server resource list', /tmcp_bridge_renamed/.test(r.text), r.text);

      r = await w.call('fivem', { action: 'server_lua', lua: '1' });
      check('a real action fails with the same three-cause explanation', r.isError && /RESOURCE name/.test(r.text), r.text);
      w.close();

      const rightCfg = join(dir, 'bridge-right-name.json');
      await writeFile(
        rightCfg,
        JSON.stringify({
          plugins: ['fivem'],
          pluginConfig: {
            fivem: {
              host: '127.0.0.1', port: fmPort,
              bridge: { secret: BRIDGE_SECRET, resource: 'tmcp_bridge_renamed' },
            },
          },
        }),
      );
      const g = await new Client(dir, [], { TERMINALMCP_CONFIG: rightCfg }).init();
      r = await g.call('fivem', { action: 'bridge' });
      check('setting bridge.resource fixes it', !/not reachable/.test(r.text) && /tmcp_bridge_renamed/.test(r.text), r.text);
      const last = fm.state.bridgeCalls[fm.state.bridgeCalls.length - 1];
      check('...and the path uses the configured name', last?.path === '/tmcp_bridge_renamed/ping', String(last?.path));

      r = await g.call('fivem', { action: 'server_lua', lua: '#GetPlayers()' });
      check('...so the real actions work again', !r.isError && /returned:\n2/.test(r.text), r.text);
      g.close();

      fm.state.bridgeResource = 'terminalmcp_bridge';
    }

    console.log('\n--- fivem: the bridge is optional and says so ---');
    {
      const noBridge = join(dir, 'no-bridge.json');
      await writeFile(
        noBridge,
        JSON.stringify({ plugins: ['fivem'], pluginConfig: { fivem: { host: '127.0.0.1', port: fmPort } } }),
      );
      const n = await new Client(dir, [], { TERMINALMCP_CONFIG: noBridge }).init();
      const r = await n.call('fivem', { action: 'server_lua', lua: '1' });
      check('without the bridge, the error explains how to install it', r.isError && /resource into your server/.test(r.text), r.text);
      check('...and warns what it grants', /arbitrary Lua execution/.test(r.text), r.text);
      const s = await n.call('fivem', { action: 'status' });
      check('...while everything else carries on working', !s.isError && /Test Roleplay/.test(s.text), s.text);
      n.close();
    }

    console.log('\n--- fivem: txAdmin ---');
    {
      let r = await c.call('fivem', { action: 'tx_status' });
      check('tx_status uses the documented token endpoint', !r.isError && /"status": "online"/.test(r.text), r.text);

      r = await c.call('fivem', { action: 'tx_announce', message: 'restarting in 5' });
      check('tx_announce logs in and broadcasts', !r.isError && /announced through txAdmin/.test(r.text), r.text);
      const cmd = fm.state.txCalls.find((x) => x.path === '/fxserver/commands');
      check('...with the action/parameter pair txAdmin expects', cmd?.body?.action === 'admin_broadcast' && cmd?.body?.parameter === 'restarting in 5', JSON.stringify(cmd?.body));
      check('...carrying the session cookie', /txAdmin-sess/.test(cmd?.cookie ?? ''), cmd?.cookie);
      check('...and the CSRF token', cmd?.csrf === 'csrf-token-value', String(cmd?.csrf));

      r = await c.call('fivem', { action: 'tx_control', control: 'restart' });
      check('tx_control restarts the server', !r.isError && /txAdmin restart/.test(r.text), r.text);

      r = await c.call('fivem', { action: 'tx_control', control: 'explode' });
      check('an invalid control is refused', r.isError && /restart, stop or start/.test(r.text), r.text);

      r = await c.call('fivem', { action: 'tx_log', match: 'ERROR' });
      check('tx_log reads the server console log', !r.isError && /something broke/.test(r.text), r.text);
      check('...filtered', !/line one/.test(r.text), r.text);
    }

    console.log('\n--- fivem: bad txAdmin credentials ---');
    {
      const badTx = join(dir, 'bad-tx.json');
      await writeFile(
        badTx,
        JSON.stringify({
          plugins: ['fivem'],
          pluginConfig: {
            fivem: {
              host: '127.0.0.1', port: fmPort,
              txadmin: { url: `http://127.0.0.1:${fmPort}`, user: 'admin', password: 'wrong-password' },
            },
          },
        }),
      );
      const b = await new Client(dir, [], { TERMINALMCP_CONFIG: badTx }).init();
      let r = await b.call('fivem', { action: 'tx_announce', message: 'hi' });
      check('a bad txAdmin login is reported', r.isError && /login failed/.test(r.text), r.text);
      check('...and the password is not echoed', !r.text.includes('wrong-password'), r.text);

      r = await b.call('fivem', { action: 'tx_status' });
      check('tx_status without a token explains which token it needs', r.isError && /TXHOST_API_TOKEN/.test(r.text), r.text);
      check('...and points at the action that needs nothing', /action "status" still works/.test(r.text), r.text);
      b.close();
    }

    console.log('\n--- readOnly refuses what reaches outside ---');
    {
      const ro = await new Client(dir, ['--read-only'], { TERMINALMCP_CONFIG: configPath }).init();
      for (const [tool, args, label] of [
        ['telegram', { action: 'send', text: 'hi' }, 'telegram send'],
        ['discord', { action: 'send', text: 'hi' }, 'discord send'],
        ['fivem', { action: 'rcon', command: 'status' }, 'fivem rcon'],
        ['fivem', { action: 'tx_control', control: 'restart' }, 'fivem tx_control'],
      ]) {
        const r = await ro.call(tool, args);
        check(`readOnly refuses ${label}`, r.isError && /readOnly/.test(r.text), r.text);
      }
      for (const [tool, args, label] of [
        ['telegram', { action: 'me' }, 'telegram me'],
        ['discord', { action: 'me' }, 'discord me'],
        ['fivem', { action: 'status' }, 'fivem status'],
      ]) {
        const r = await ro.call(tool, args);
        check(`readOnly still allows ${label}`, !r.isError, r.text);
      }
      ro.close();
    }

    console.log('\n--- environment variables, and secrets kept out of files ---');
    {
      const envCfg = join(dir, 'env.json');
      await writeFile(
        envCfg,
        JSON.stringify({
          plugins: ['telegram'],
          pluginConfig: { telegram: { token: 'env:MY_TG_TOKEN', apiBase: tgBase, defaultChat: '555' } },
        }),
      );
      const e = await new Client(dir, [], { TERMINALMCP_CONFIG: envCfg, MY_TG_TOKEN: TG_TOKEN }).init();
      const r = await e.call('telegram', { action: 'me' });
      check('"env:NAME" reads the token from the environment', !r.isError && /@testbot/.test(r.text), r.text);
      e.close();

      const e2 = await new Client(dir, [], { TERMINALMCP_CONFIG: envCfg }).init();
      const r2 = await e2.call('telegram', { action: 'me' });
      check('an unset variable is reported as "not configured", not as a 401', r2.isError && /No Telegram bot token/.test(r2.text), r2.text);
      check('...and says where to put it', /BotFather/.test(r2.text), r2.text);
      e2.close();
    }

    check('the server logged no crashes', !/handler crash|uncaught/.test(c.stderr), c.stderr.slice(-400));
  } finally {
    c.close();
    tg.srv.close();
    dc.srv.close();
    fm.srv.close();
    rc.sock.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('test harness crashed:', err);
  process.exit(1);
});
