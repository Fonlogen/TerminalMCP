// Plugin: fivem — FiveM / RedM server and client control.
//
// "Control the console" turns out to mean four different consoles, reached
// four different ways, and being clear about which is which is most of the
// value here:
//
//   server console   RCON over UDP (stable, documented by every host), or —
//                    better, when this server started the FXServer itself —
//                    its real stdout and stdin through shell_exec_async and
//                    shell_job, which loses nothing to a dropped datagram.
//   txAdmin          Its own web panel. Only /host/status is a documented,
//                    token-authenticated API; the rest is the panel's private
//                    interface, so it is supported here but flagged as
//                    version-dependent rather than promised.
//   F8 (client)      The game client's console. Its *output* is a log file on
//                    disk, which `f8` reads. Sending *input* to it is not
//                    something a remote process can do at all — unless the
//                    optional bridge resource is installed on the server, in
//                    which case `f8_exec` runs a command in a chosen player's
//                    console for real.
//   server info      /info.json, /players.json, /dynamic.json, on the game
//                    port. No password needed, and the fastest way to answer
//                    "is it up and who is on it".

import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { PolicyError } from '../../src/guards.js';
import { apiFetch } from '../../src/plugins.js';
import { fileRead } from '../../src/files.js';
import { ms, truncateMiddle } from '../../src/format.js';
import { rconCommand, rconRejection } from './rcon.js';

export const LABEL = 'FiveM: RCON, txAdmin, server info, F8 client log';

/** Actions that change something outside this machine; refused by readOnly. */
export const MUTATING_ACTIONS = [
  'rcon', 'resource', 'say', 'kick', 'f8_exec', 'client_lua', 'server_lua',
  'tx_control', 'tx_announce',
];

export const TOOLS = [
  {
    name: 'fivem',
    description:
      'Control a FiveM/RedM server. status and players answer "is it up, who is on" with no ' +
      'password at all. rcon runs any console command over RCON; resource ensures/restarts one; ' +
      'say broadcasts; kick removes a player. f8 reads the game client\'s F8 console log — the ' +
      'place client-side script errors actually appear. With the optional bridge resource ' +
      'installed, f8_exec runs a command in a chosen player\'s F8 console and client_lua/' +
      'server_lua evaluate Lua and return the value. tx_status, tx_control and tx_announce drive ' +
      'txAdmin. If this server started the FXServer, prefer shell_job for the console: it is the ' +
      'real stdout, not a UDP echo of it.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'status', 'players', 'resources',
            'rcon', 'resource', 'say', 'kick',
            'f8', 'f8_exec', 'client_lua', 'server_lua', 'bridge',
            'tx_status', 'tx_control', 'tx_announce', 'tx_log',
          ],
          description: 'What to do.',
        },
        command: { type: 'string', description: 'rcon: the console command, exactly as you would type it in the server console.' },
        resource: { type: 'string', description: 'resource: which resource to act on.' },
        op: { type: 'string', enum: ['ensure', 'start', 'stop', 'restart', 'refresh'], description: 'resource: what to do with it. Default ensure, which starts it or restarts it if already running.' },
        message: { type: 'string', description: 'say / tx_announce: the text to broadcast to everyone.' },
        player: { type: 'string', description: 'kick / f8_exec / client_lua: the player, by the server id that action "players" lists.' },
        reason: { type: 'string', description: 'kick: the reason shown to the player.' },
        lua: { type: 'string', description: 'client_lua / server_lua: a Lua expression or block. A block must return a value to get one back.' },
        lines: { type: 'integer', description: 'f8 / tx_log: how many lines from the end. Default 80.' },
        match: { type: 'string', description: 'f8 / resources / tx_log: only lines (or resources) matching this regex.' },
        errors: { type: 'boolean', description: 'f8: only lines that look like errors, warnings or script failures.' },
        path: { type: 'string', description: 'f8: read this log file instead of finding the client log automatically.' },
        control: { type: 'string', enum: ['restart', 'stop', 'start'], description: 'tx_control: what to do with the server txAdmin supervises.' },
        host: { type: 'string', description: 'Override the configured server host for this call.' },
        port: { type: 'integer', description: 'Override the configured server port for this call.' },
        timeout_ms: { type: 'integer', description: 'Per-call timeout.' },
        max_bytes: { type: 'integer', description: 'Byte cap on returned text.' },
      },
      required: ['action'],
    },
  },
];

/** Where the FiveM client keeps the log that the F8 console prints into. */
function clientLogCandidates() {
  const local = process.env.LOCALAPPDATA;
  if (!local) return [];
  const app = join(local, 'FiveM', 'FiveM.app');
  return [join(app, 'logs'), app, join(local, 'FiveM')];
}

async function findClientLog(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`No such log file: ${explicit}`);
    return explicit;
  }
  if (process.platform !== 'win32') {
    throw new Error(
      'The FiveM client only runs on Windows, so there is no client log to find here. ' +
      'Pass "path" if the log is on this machine anyway (a Wine prefix, a copied file, or a share).',
    );
  }

  let newest = null;
  for (const dir of clientLogCandidates()) {
    let entries = [];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!/^CitizenFX(_log.*)?\.log$/i.test(name)) continue;
      const full = join(dir, name);
      const st = await stat(full).catch(() => null);
      if (st?.isFile() && (!newest || st.mtimeMs > newest.mtimeMs)) {
        newest = { path: full, mtimeMs: st.mtimeMs };
      }
    }
  }
  if (!newest) {
    throw new Error(
      'No FiveM client log found. Looked in:\n  ' + clientLogCandidates().join('\n  ') +
      '\nStart FiveM once, or pass "path" to the log you mean.',
    );
  }
  return newest.path;
}

const ERROR_LINE = /error|exception|failed|warning|traceback|stack traceback|\[ *script:[^\]]*\] *(SCRIPT ERROR|error)/i;

export function describe({ settings, secret }) {
  const bits = [`server ${settings.host ?? '127.0.0.1'}:${settings.port ?? 30120}`];
  bits.push(secret(settings.rconPassword ?? 'env:FIVEM_RCON_PASSWORD') ? 'rcon password set' : 'no rcon password');
  const tx = settings.txadmin ?? {};
  if (tx.url) {
    const has = [];
    if (secret(tx.envToken ?? 'env:TXHOST_API_TOKEN')) has.push('env token');
    if (tx.user && secret(tx.password ?? 'env:TXADMIN_PASSWORD')) has.push('login');
    bits.push(`txAdmin ${tx.url}${has.length ? ` (${has.join(' + ')})` : ' (no credentials)'}`);
  }
  const bridge = settings.bridge ?? {};
  if (secret(bridge.secret ?? 'env:FIVEM_BRIDGE_SECRET')) bits.push('bridge configured');
  return bits.join(', ');
}

export function createHandlers({ cfg, settings, redactor, secret }) {
  const host = settings.host ?? '127.0.0.1';
  const port = Number(settings.port ?? 30120);
  const rconPort = Number(settings.rconPort ?? port);
  const rconPassword = secret(settings.rconPassword ?? 'env:FIVEM_RCON_PASSWORD');

  const tx = settings.txadmin ?? {};
  const txUrl = (tx.url ?? '').replace(/\/+$/, '');
  const txEnvToken = secret(tx.envToken ?? 'env:TXHOST_API_TOKEN');
  const txUser = tx.user ?? null;
  const txPassword = secret(tx.password ?? 'env:TXADMIN_PASSWORD');

  const bridge = settings.bridge ?? {};
  const bridgeSecret = secret(bridge.secret ?? 'env:FIVEM_BRIDGE_SECRET');

  const allowCommands = compile(settings.allowCommands, 'allowCommands');
  const denyCommands = compile(settings.denyCommands, 'denyCommands');

  // A txAdmin panel session, once logged in, for the life of the process.
  let txSession = null;

  function compile(list, label) {
    return (list ?? []).map((p) => {
      try {
        return p instanceof RegExp ? p : new RegExp(p, 'i');
      } catch (err) {
        throw new Error(`Invalid regex in fivem.${label}: ${p} (${err.message})`);
      }
    });
  }

  function target(a) {
    return { host: a.host ?? host, port: Number(a.port ?? port) };
  }

  function checkCommand(command) {
    if (denyCommands.some((re) => re.test(command))) {
      throw new PolicyError(
        `the command "${command}" matches fivem.denyCommands, so it was refused. ` +
        'The operator configured that.',
      );
    }
    if (allowCommands.length && !allowCommands.some((re) => re.test(command))) {
      throw new PolicyError(
        `only commands matching fivem.allowCommands may be run, and "${command}" does not. ` +
        `Allowed patterns: ${allowCommands.map((r) => r.source).join(', ')}`,
      );
    }
  }

  async function rcon(command, { timeoutMs = 5000 } = {}) {
    if (!rconPassword) {
      throw new Error(
        'No RCON password. Set pluginConfig.fivem.rconPassword (or "env:FIVEM_RCON_PASSWORD"), ' +
        'and make sure the server has `set rcon_password "…"` in its server.cfg. ' +
        'If this server started the FXServer itself, shell_job is a better channel than RCON: ' +
        'it is the real console, and it cannot lose a packet.',
      );
    }
    const t = target({});
    const out = await rconCommand({
      host: t.host,
      port: rconPort,
      password: rconPassword,
      command,
      timeoutMs,
      quietMs: settings.rconQuietMs ?? 350,
    });
    const rejected = rconRejection(out.text);
    if (rejected) throw new Error(`RCON refused the command: ${rejected}`);
    if (!out.packets) {
      throw new Error(
        `No reply from ${t.host}:${rconPort} within ${ms(timeoutMs)}. RCON is UDP, so silence ` +
        'means one of: the server is down, the port is wrong (it is the game port, not the ' +
        'txAdmin one), rcon_password is unset, or a firewall dropped it.',
      );
    }
    return out;
  }

  /** The unauthenticated JSON endpoints every FiveM server exposes. */
  async function serverJson(a, name) {
    const t = target(a);
    // The wrong port is the single most common cause here, and it shows up as
    // a refused connection rather than as an HTTP error — so the hint belongs
    // on both paths, not just the one where a server answered.
    const wrongPortHint =
      ` The port to use is the game/HTTP port from server.cfg (endpoint_add_tcp / endpoint_add_udp, ` +
      `usually 30120), not txAdmin's 40120.`;

    let result;
    try {
      result = await apiFetch(`http://${t.host}:${t.port}/${name}`, {
        timeoutMs: a.timeout_ms ?? 8000,
        redactor,
        label: `FiveM ${name}`,
      });
    } catch (err) {
      throw new Error(
        `Could not reach ${t.host}:${t.port} — ${err.message.replace(/^FiveM \S+ failed: /, '')}.` +
        `${/ECONNREFUSED|refused/i.test(err.message) ? ` Nothing is listening there.${wrongPortHint}` : wrongPortHint}`,
      );
    }

    const { status, json, raw } = result;
    if (status !== 200 || !json) {
      throw new Error(
        `${name} from ${t.host}:${t.port} returned HTTP ${status}${raw ? `: ${truncateMiddle(raw, 200).text}` : ''}.` +
        wrongPortHint,
      );
    }
    return json;
  }

  // ------------------------------------------------------------- txAdmin
  function requireTx() {
    if (!txUrl) {
      throw new Error(
        'No txAdmin URL. Set pluginConfig.fivem.txadmin.url, e.g. "http://127.0.0.1:40120".',
      );
    }
  }

  async function txLogin() {
    if (txSession) return txSession;
    requireTx();
    if (!txUser || !txPassword) {
      throw new Error(
        'This needs a txAdmin login: set pluginConfig.fivem.txadmin.user and .password ' +
        '(or "env:TXADMIN_PASSWORD"). Note that txAdmin\'s panel API is its own internal ' +
        'interface, not a documented one, so it can change between txAdmin versions.',
      );
    }

    const { status, json, raw, headers } = await apiFetch(`${txUrl}/auth/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: txUser, password: txPassword }),
      timeoutMs: 15000,
      redactor,
      label: 'txAdmin login',
    });
    if (status !== 200 || !json || json.error) {
      throw new Error(
        `txAdmin login failed (HTTP ${status}): ${json?.error ?? truncateMiddle(raw, 200).text}`,
      );
    }

    const cookies = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie')].filter(Boolean);
    if (!cookies.length) {
      throw new Error('txAdmin login returned no session cookie, so nothing can be authenticated afterwards');
    }
    // The panel sends its CSRF token back with the auth data and then expects
    // it on every write; the field name has moved around between versions, so
    // take whichever one is there.
    const csrf = json.csrfToken ?? json.csrf_token ?? json.csrf ?? null;
    txSession = {
      cookie: cookies.map((c) => String(c).split(';')[0]).join('; '),
      csrf,
      name: json.name ?? json.username ?? txUser,
    };
    if (csrf) redactor.add(csrf);
    return txSession;
  }

  async function txPost(path, body, label) {
    const session = await txLogin();
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Cookie: session.cookie,
    };
    if (session.csrf) headers['X-TxAdmin-CsrfToken'] = session.csrf;

    const { status, json, raw } = await apiFetch(`${txUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      timeoutMs: 20000,
      redactor,
      label,
    });

    if (status === 401 || status === 403) {
      // The session may simply have expired; make the next call log in again.
      txSession = null;
      throw new Error(
        `txAdmin refused ${path} (HTTP ${status}): ${json?.msg ?? json?.error ?? truncateMiddle(raw, 200).text}. ` +
        'Either the admin lacks the permission for this, or the CSRF handshake differs in your ' +
        'txAdmin version — this part of txAdmin is not a documented API.',
      );
    }
    if (status < 200 || status >= 300) {
      throw new Error(`txAdmin ${path} failed (HTTP ${status}): ${json?.msg ?? truncateMiddle(raw, 300).text}`);
    }
    // The panel answers with a toast: { type: 'success' | 'error', msg }.
    if (json?.type === 'error') throw new Error(`txAdmin: ${json.msg ?? 'the action failed'}`);
    return json ?? {};
  }

  // -------------------------------------------------------------- bridge
  function bridgeUrl() {
    const explicit = bridge.url ? bridge.url.replace(/\/+$/, '') : null;
    return explicit ?? `http://${host}:${port}/terminalmcp_bridge`;
  }

  async function bridgeCall(endpoint, body, { timeoutMs = 15000 } = {}) {
    if (!bridgeSecret) {
      throw new Error(
        'This needs the bridge resource. It is optional and not installed by default: copy ' +
        'plugins/fivem/resource into your server\'s resources as [terminalmcp]/terminalmcp_bridge, ' +
        'add `ensure terminalmcp_bridge` and `set terminalmcp_secret "<a long random string>"` to ' +
        'server.cfg, then set pluginConfig.fivem.bridge.secret to the same value. ' +
        'Read plugins/fivem/resource/README.md first — it grants arbitrary Lua execution to ' +
        'whoever holds that secret.',
      );
    }
    const { status, json, raw } = await apiFetch(`${bridgeUrl()}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Terminalmcp-Secret': bridgeSecret },
      body: JSON.stringify(body),
      timeoutMs,
      redactor,
      label: `FiveM bridge ${endpoint}`,
    });
    if (status === 404) {
      throw new Error(
        `The bridge did not answer at ${bridgeUrl()}/${endpoint} (HTTP 404). ` +
        'Is terminalmcp_bridge started? Check the server console for "terminalmcp_bridge" and ' +
        'confirm the resource name matches the URL path.',
      );
    }
    if (status === 401) throw new Error('The bridge rejected the secret: terminalmcp_secret in server.cfg does not match the configured one');
    if (status < 200 || status >= 300 || !json) {
      throw new Error(`Bridge ${endpoint} failed (HTTP ${status}): ${truncateMiddle(raw, 300).text}`);
    }
    if (json.ok === false) throw new Error(`Bridge ${endpoint}: ${json.error ?? 'failed'}`);
    return json;
  }

  return {
    async fivem(a) {
      const action = a.action;
      if (!action) throw new Error('fivem needs "action"');
      const cap = a.max_bytes ?? cfg.maxOutputBytes;

      switch (action) {
        // ------------------------------------------------- no password needed
        case 'status': {
          const t = target(a);
          const info = await serverJson(a, 'info.json');
          const dynamic = await serverJson(a, 'dynamic.json').catch(() => null);
          const vars = info.vars ?? {};
          return [
            `${dynamic?.hostname ?? vars.sv_projectName ?? 'FiveM server'} — ${t.host}:${t.port}`,
            dynamic ? `players  ${dynamic.clients}/${dynamic.sv_maxclients}` : null,
            dynamic ? `map      ${dynamic.mapname ?? '?'}   gametype ${dynamic.gametype ?? '?'}` : null,
            `version  ${info.version ?? '?'}${vars.sv_enforceGameBuild ? `, game build ${vars.sv_enforceGameBuild}` : ''}`,
            `onesync  ${vars.onesync_enabled === 'true' || vars.onesync === 'on' ? 'on' : vars.onesync ?? 'off'}`,
            `resources ${(info.resources ?? []).length}`,
            vars.sv_projectDesc ? `about    ${vars.sv_projectDesc}` : null,
            '',
            'This came from the public info endpoints — no RCON password involved.',
          ].filter((l) => l !== null).join('\n');
        }

        case 'players': {
          const list = await serverJson(a, 'players.json');
          if (!Array.isArray(list) || !list.length) return 'Nobody is on the server.';
          const rows = list
            .sort((x, y) => Number(x.id) - Number(y.id))
            .map(
              (p) =>
                `${String(p.id).padStart(3)}  ${String(p.name).slice(0, 32).padEnd(32)} ` +
                `ping ${String(p.ping).padStart(4)}  ${(p.identifiers ?? []).length} identifier(s)`,
            );
          return `${list.length} player(s)\n${truncateMiddle(rows.join('\n'), cap).text}`;
        }

        case 'resources': {
          const info = await serverJson(a, 'info.json');
          let list = info.resources ?? [];
          if (a.match) {
            const re = new RegExp(a.match, 'i');
            list = list.filter((r) => re.test(r));
          }
          if (!list.length) return a.match ? `No resource matches ${a.match}.` : 'The server reported no resources.';
          return (
            `${list.length} resource(s)${a.match ? ` matching ${a.match}` : ''}\n` +
            truncateMiddle(list.sort().join('\n'), cap).text
          );
        }

        // ------------------------------------------------------------- RCON
        case 'rcon': {
          if (!a.command) throw new Error('rcon needs "command"');
          checkCommand(a.command);
          const out = await rcon(a.command, { timeoutMs: a.timeout_ms ?? 5000 });
          const text = out.text.trim();
          return (
            `${a.command}  (${out.packets} packet(s), ${ms(out.ms)})\n` +
            (text ? truncateMiddle(text, cap).text : '(the server printed nothing — many commands do not)')
          );
        }

        case 'resource': {
          if (!a.resource) throw new Error('resource needs "resource" (the resource name)');
          const op = a.op ?? 'ensure';
          const command = op === 'refresh' ? 'refresh' : `${op} ${a.resource}`;
          checkCommand(command);
          const out = await rcon(command, { timeoutMs: a.timeout_ms ?? 10000 });
          return (
            `${command}\n${out.text.trim() || '(no output)'}\n\n` +
            'Resource errors appear in the server console, not here — read them with shell_job if ' +
            'this server started the FXServer, or with tx_log.'
          );
        }

        case 'say': {
          if (!a.message) throw new Error('say needs "message"');
          const command = `say ${a.message}`;
          checkCommand(command);
          const out = await rcon(command);
          return `broadcast to everyone on the server\n${out.text.trim() || '(no output)'}`;
        }

        case 'kick': {
          if (!a.player) throw new Error('kick needs "player" (the server id from action "players")');
          const command = `clientkick ${a.player} ${a.reason ?? 'Kicked'}`;
          checkCommand(command);
          const out = await rcon(command);
          return `kicked player ${a.player}${a.reason ? ` (${a.reason})` : ''}\n${out.text.trim() || '(no output)'}`;
        }

        // ------------------------------------------------- the F8 console
        case 'f8': {
          const logPath = await findClientLog(a.path);
          const params = {
            path: logPath,
            tail_lines: a.lines ?? 80,
            max_bytes: cap,
            line_numbers: false,
          };
          if (a.match) params.match = a.match;
          else if (a.errors) params.match = ERROR_LINE.source;
          const body = await fileRead(cfg, params);
          return (
            `F8 client console log: ${logPath}\n` +
            `${a.errors && !a.match ? 'showing error-like lines only\n' : ''}` +
            `${body}\n\n` +
            'This is the client console\'s output. To type INTO a client console, the bridge ' +
            'resource must be installed — see action "f8_exec".'
          );
        }

        case 'f8_exec': {
          if (!a.command) throw new Error('f8_exec needs "command" — what you would type in the F8 console');
          if (!a.player) throw new Error('f8_exec needs "player" — whose console to type into (see action "players")');
          const out = await bridgeCall('client_exec', { player: String(a.player), command: a.command });
          return (
            `ran in player ${a.player}'s F8 console: ${a.command}\n` +
            `${out.note ?? 'The client console does not report back what it printed.'}\n` +
            'Read the result with action "f8" on that player\'s machine, or use client_lua to get ' +
            'a value back directly.'
          );
        }

        case 'client_lua': {
          if (!a.lua) throw new Error('client_lua needs "lua"');
          if (!a.player) throw new Error('client_lua needs "player"');
          const out = await bridgeCall(
            'client_lua',
            { player: String(a.player), lua: a.lua },
            { timeoutMs: a.timeout_ms ?? 20000 },
          );
          return `client ${a.player} returned:\n${truncateMiddle(JSON.stringify(out.result, null, 2) ?? 'nil', cap).text}`;
        }

        case 'server_lua': {
          if (!a.lua) throw new Error('server_lua needs "lua"');
          const out = await bridgeCall('server_lua', { lua: a.lua }, { timeoutMs: a.timeout_ms ?? 20000 });
          return `server returned:\n${truncateMiddle(JSON.stringify(out.result, null, 2) ?? 'nil', cap).text}`;
        }

        case 'bridge': {
          const out = await bridgeCall('ping', {}).catch((err) => ({ error: err.message }));
          if (out.error) return `bridge not reachable\n${out.error}`;
          return (
            `bridge ${out.version ?? '?'} on ${bridgeUrl()}\n` +
            `resource: ${out.resource ?? 'terminalmcp_bridge'}, ${out.players ?? '?'} player(s) connected`
          );
        }

        // ----------------------------------------------------------- txAdmin
        case 'tx_status': {
          requireTx();
          if (!txEnvToken) {
            throw new Error(
              'tx_status uses txAdmin\'s documented /host/status endpoint, which needs its API ' +
              'token: set TXHOST_API_TOKEN for txAdmin itself, then put the same value in ' +
              'pluginConfig.fivem.txadmin.envToken (or "env:TXHOST_API_TOKEN"). ' +
              'Without it, action "status" still works — it needs no credentials at all.',
            );
          }
          const { status, json, raw } = await apiFetch(`${txUrl}/host/status`, {
            headers: { 'x-txadmin-envtoken': txEnvToken, Accept: 'application/json' },
            timeoutMs: a.timeout_ms ?? 10000,
            redactor,
            label: 'txAdmin /host/status',
          });
          if (status !== 200 || !json) {
            throw new Error(
              `txAdmin /host/status returned HTTP ${status}${raw ? `: ${truncateMiddle(raw, 200).text}` : ''}` +
              `${status === 401 ? ' — the token does not match TXHOST_API_TOKEN' : ''}` +
              `${status === 404 ? ' — this txAdmin is too old for /host/status' : ''}`,
            );
          }
          return truncateMiddle(JSON.stringify(json, null, 2), cap).text;
        }

        case 'tx_control': {
          const control = a.control ?? 'restart';
          if (!['restart', 'stop', 'start'].includes(control)) {
            throw new Error('tx_control "control" must be restart, stop or start');
          }
          const out = await txPost('/fxserver/controls', { action: control }, `txAdmin ${control}`);
          return `txAdmin ${control}: ${out.msg ?? 'accepted'}`;
        }

        case 'tx_announce': {
          if (!a.message) throw new Error('tx_announce needs "message"');
          const out = await txPost(
            '/fxserver/commands',
            { action: 'admin_broadcast', parameter: a.message },
            'txAdmin broadcast',
          );
          return `announced through txAdmin: ${out.msg ?? 'sent'}`;
        }

        case 'tx_log': {
          requireTx();
          const session = await txLogin();
          const { status, raw } = await apiFetch(`${txUrl}/fxserver/downloadLog`, {
            headers: { Cookie: session.cookie },
            timeoutMs: a.timeout_ms ?? 30000,
            redactor,
            label: 'txAdmin downloadLog',
          });
          if (status !== 200) throw new Error(`txAdmin downloadLog returned HTTP ${status}`);
          let lines = raw.split(/\r?\n/);
          if (a.match) {
            const re = new RegExp(a.match, 'i');
            lines = lines.filter((l) => re.test(l));
          }
          const tail = lines.slice(-(a.lines ?? 80));
          return (
            `txAdmin server console log, last ${tail.length} line(s)${a.match ? ` matching ${a.match}` : ''}\n` +
            truncateMiddle(tail.join('\n'), cap).text
          );
        }

        default:
          throw new Error(
            `Unknown fivem action "${action}". ` +
            'Try: status, players, resources, rcon, resource, say, kick, f8, f8_exec, ' +
            'client_lua, server_lua, bridge, tx_status, tx_control, tx_announce, tx_log.',
          );
      }
    },
  };
}
