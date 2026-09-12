// Group: net — an HTTP client for poking at APIs, plus basic network probes.

import { lookup, resolve4, resolve6, resolveMx, resolveTxt, resolveCname, resolveNs, reverse } from 'node:dns/promises';
import { connect } from 'node:net';
import os from 'node:os';
import process from 'node:process';
import { runArgv } from '../exec.js';
import { shapeOutput, truncateMiddle, ms } from '../format.js';

const IS_WIN = process.platform === 'win32';

export const TOOLS = [
  {
    name: 'http_request',
    description:
      'Make an HTTP(S) request and report status, timing, headers and body — for testing the API ' +
      'you are building or calling. JSON bodies are pretty-printed; large bodies are truncated. ' +
      'Pass json= for a JSON body (sets Content-Type), or body= for anything else.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL. http:// is assumed if no scheme is given.' },
        method: { type: 'string', description: 'GET (default), POST, PUT, PATCH, DELETE, HEAD, OPTIONS...' },
        headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Request headers.' },
        json: { description: 'Body sent as JSON (any value). Sets Content-Type: application/json.' },
        body: { type: 'string', description: 'Raw request body.' },
        form: { type: 'object', additionalProperties: { type: 'string' }, description: 'Body sent as application/x-www-form-urlencoded.' },
        query: { type: 'object', additionalProperties: { type: 'string' }, description: 'Query parameters appended to the URL.' },
        timeout_ms: { type: 'integer', description: 'Abort after this long. Default 30000.' },
        follow_redirects: { type: 'boolean', description: 'Follow 3xx. Default true.' },
        insecure: { type: 'boolean', description: 'Accept invalid TLS certificates (self-signed dev servers).' },
        headers_only: { type: 'boolean', description: 'Report status and headers, skip the body.' },
        assign: { type: 'string', description: 'Store the response body in the server variable of this name instead of relying on it coming back through the conversation. See the vars tool.' },
        max_bytes: { type: 'integer', description: 'Byte cap on the returned body. Default: server maxOutputBytes.' },
      },
      required: ['url'],
    },
  },

  {
    name: 'net',
    description:
      'Network probes: dns (A/AAAA/MX/TXT/CNAME/NS/PTR lookup), tcp_check (is host:port accepting ' +
      'connections, with timing), listening (which ports are open on this machine, and which pid ' +
      'owns them), interfaces (local addresses), ping.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['dns', 'tcp_check', 'listening', 'interfaces', 'ping'], description: 'Which probe to run.' },
        host: { type: 'string', description: 'Hostname or IP for dns, tcp_check and ping.' },
        port: { type: 'integer', description: 'tcp_check: port to connect to. listening: only report this port.' },
        ports: { type: 'array', items: { type: 'integer' }, description: 'tcp_check: several ports at once.' },
        type: { type: 'string', enum: ['A', 'AAAA', 'MX', 'TXT', 'CNAME', 'NS', 'PTR', 'ALL'], description: 'dns: record type. Default A.' },
        count: { type: 'integer', description: 'ping: how many packets. Default 3.' },
        timeout_ms: { type: 'integer', description: 'Per-probe timeout. Default 5000.' },
        max_bytes: { type: 'integer', description: 'Byte cap on returned output.' },
      },
      required: ['action'],
    },
  },
];

function humanBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** Headers worth showing by default; the rest are counted, not printed. */
const INTERESTING_HEADERS = new Set([
  'content-type', 'content-length', 'location', 'set-cookie', 'cache-control', 'etag',
  'server', 'x-request-id', 'retry-after', 'www-authenticate', 'content-encoding',
  'access-control-allow-origin', 'x-ratelimit-remaining', 'x-ratelimit-limit',
]);

function tcpCheck(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = connect({ host, port, timeout: timeoutMs });
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ...result, ms: Date.now() - started });
    };
    socket.once('connect', () => done({ open: true }));
    socket.once('timeout', () => done({ open: false, reason: 'timeout' }));
    socket.once('error', (err) => done({ open: false, reason: err.code || err.message }));
  });
}

async function listeningPorts(cfg, wanted) {
  // ss is the modern tool; netstat is the fallback that exists nearly everywhere.
  const attempts = IS_WIN
    ? [{ file: 'netstat', args: ['-ano'] }]
    : [
        { file: 'ss', args: ['-tulpnH'] },
        { file: 'netstat', args: ['-tulpn'] },
        { file: 'netstat', args: ['-an'] },
      ];

  for (const attempt of attempts) {
    const run = await runArgv(cfg, { ...attempt, timeoutMs: 15000 });
    if (run.error || run.exitCode !== 0 || !run.stdout.trim()) continue;

    const rows = [];
    for (const line of run.stdout.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      if (!/LISTEN|UNCONN|^udp|^tcp/i.test(t)) continue;

      // Grab the local address field, then the last :port in it.
      const fields = t.split(/\s+/);
      const localField = IS_WIN ? fields[1] : fields.find((f) => /:\d+$/.test(f));
      if (!localField) continue;
      const portMatch = /:(\d+)$/.exec(localField);
      if (!portMatch) continue;
      const port = Number(portMatch[1]);
      if (wanted && port !== wanted) continue;

      const pidMatch = IS_WIN
        ? /(\d+)\s*$/.exec(t)
        : /pid=(\d+)/.exec(t) || /\s(\d+)\/(\S+)/.exec(t);
      const nameMatch = /(?:users:\(\("([^"]+)"|\d+\/(\S+))/.exec(t);

      rows.push({
        proto: /^udp/i.test(t) || fields[0]?.toLowerCase() === 'udp' ? 'udp' : 'tcp',
        address: localField,
        port,
        pid: pidMatch ? Number(pidMatch[1]) : null,
        name: nameMatch ? nameMatch[1] || nameMatch[2] : null,
      });
    }
    if (rows.length) {
      // Deduplicate: ss and netstat both list IPv4 and IPv6 rows per socket.
      const seen = new Set();
      const unique = rows.filter((r) => {
        const key = `${r.proto}:${r.port}:${r.pid ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { rows: unique.sort((a, b) => a.port - b.port), via: `${attempt.file} ${attempt.args.join(' ')}` };
    }
  }
  return { rows: [], via: null };
}

export function createHandlers({ cfg, vars = null }) {
  return {
    async http_request(p) {
      if (!p.url) throw new Error('"url" is required');
      let urlStr = String(p.url);
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(urlStr)) urlStr = `http://${urlStr}`;

      let url;
      try {
        url = new URL(urlStr);
      } catch (err) {
        throw new Error(`Invalid url ${JSON.stringify(p.url)}: ${err.message}`);
      }
      for (const [k, v] of Object.entries(p.query ?? {})) url.searchParams.set(k, String(v));

      const method = (p.method || 'GET').toUpperCase();
      const headers = { ...(p.headers ?? {}) };
      let body;

      if (p.json !== undefined) {
        body = typeof p.json === 'string' ? p.json : JSON.stringify(p.json);
        if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json';
        }
      } else if (p.form) {
        body = new URLSearchParams(Object.entries(p.form).map(([k, v]) => [k, String(v)])).toString();
        if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
      } else if (p.body !== undefined) {
        body = String(p.body);
      }

      const timeout = p.timeout_ms ?? 30000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      // Node reads this env var at TLS handshake time, so toggling it around
      // the call is the only way to allow a self-signed cert per-request.
      const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      if (p.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

      const started = Date.now();
      let res;
      try {
        res = await fetch(url, {
          method,
          headers,
          body,
          redirect: p.follow_redirects === false ? 'manual' : 'follow',
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (p.insecure) restoreTls(prevTls);
        if (err.name === 'AbortError') throw new Error(`${method} ${url} timed out after ${ms(timeout)}`);
        const cause = err.cause?.code ? ` (${err.cause.code})` : '';
        throw new Error(`${method} ${url} failed: ${err.message}${cause}`);
      }

      let raw = '';
      let bytes = 0;
      if (!p.headers_only && method !== 'HEAD') {
        const buf = Buffer.from(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
        bytes = buf.length;
        raw = buf.toString('utf8');
      }
      clearTimeout(timer);
      if (p.insecure) restoreTls(prevTls);
      const elapsed = Date.now() - started;

      const shown = [];
      let hidden = 0;
      for (const [k, v] of res.headers.entries()) {
        if (INTERESTING_HEADERS.has(k.toLowerCase())) shown.push(`${k}: ${v}`);
        else hidden++;
      }

      const contentType = res.headers.get('content-type') ?? '';
      let renderedBody = raw;
      if (raw && /json/i.test(contentType)) {
        try {
          renderedBody = JSON.stringify(JSON.parse(raw), null, 2);
        } catch {
          /* the server lied about the content type; show it as-is */
        }
      }

      const head =
        `${res.status} ${res.statusText || ''} ${method} ${res.url || url} ` +
        `${ms(elapsed)}${bytes ? ` ${humanBytes(bytes)}` : ''}`;
      const cut = shapeOutput(renderedBody, { maxBytes: p.max_bytes ?? cfg.maxOutputBytes, ansi: true, tidy: false });

      let assigned = null;
      if (p.assign && vars) {
        try {
          const entry = vars.set(p.assign, raw);
          assigned = `stored ${entry.bytes} bytes in ${p.assign} — use it as \${vars.${p.assign}}`;
        } catch (err) {
          assigned = `not stored: ${err.message}`;
        }
      }

      return [
        head.trim(),
        shown.length ? shown.join('\n') : null,
        hidden ? `(${hidden} more header(s))` : null,
        assigned,
        p.headers_only || method === 'HEAD' ? null : cut.text ? `--- body${cut.truncated ? ' TRUNCATED' : ''} ---\n${cut.text}` : '(empty body)',
      ]
        .filter(Boolean)
        .join('\n');
    },

    async net(p) {
      const a = p.action;
      if (!a) throw new Error('"action" is required: dns | tcp_check | listening | interfaces | ping');
      const timeout = p.timeout_ms ?? 5000;
      const cap = p.max_bytes ?? cfg.maxOutputBytes;

      if (a === 'interfaces') {
        const ifaces = os.networkInterfaces();
        const rows = [];
        for (const [name, addrs] of Object.entries(ifaces)) {
          for (const addr of addrs ?? []) {
            rows.push(
              `${name.padEnd(14)} ${addr.family.padEnd(5)} ${addr.address}` +
              `${addr.internal ? ' (internal)' : ''}`,
            );
          }
        }
        return rows.join('\n') || '(no interfaces)';
      }

      if (a === 'dns') {
        if (!p.host) throw new Error('dns needs "host"');
        const type = (p.type || 'A').toUpperCase();
        const lookups = {
          A: () => resolve4(p.host),
          AAAA: () => resolve6(p.host),
          MX: () => resolveMx(p.host).then((r) => r.map((x) => `${x.priority} ${x.exchange}`)),
          TXT: () => resolveTxt(p.host).then((r) => r.map((x) => x.join(''))),
          CNAME: () => resolveCname(p.host),
          NS: () => resolveNs(p.host),
          PTR: () => reverse(p.host),
        };

        if (type === 'ALL') {
          const parts = [];
          for (const key of ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS']) {
            const records = await lookups[key]().catch((err) => [`(${err.code || err.message})`]);
            parts.push(`${key.padEnd(6)} ${records.join(', ') || '-'}`);
          }
          return `${p.host}\n${truncateMiddle(parts.join('\n'), cap).text}`;
        }

        const fn = lookups[type];
        if (!fn) throw new Error(`Unsupported dns type "${type}"`);

        let records = null;
        let resolverError = null;
        try {
          records = await fn();
        } catch (err) {
          resolverError = err.code || err.message;
        }

        // A DNS query is not the same thing as "can this host be reached":
        // localhost, /etc/hosts entries and mDNS names resolve through the
        // system resolver but have no DNS records. Fall back to it and say so.
        if (!records || !records.length) {
          if (type === 'A' || type === 'AAAA') {
            const hit = await lookup(p.host, { family: type === 'AAAA' ? 6 : 4 }).catch(() => null);
            if (hit) {
              return (
                `${p.host} ${type}: no DNS records (${resolverError ?? 'empty answer'}), but the ` +
                `system resolver returns ${hit.address} (IPv${hit.family}) — likely /etc/hosts or mDNS`
              );
            }
          }
          throw new Error(`${type} lookup for ${p.host} failed: ${resolverError ?? 'no records'}`);
        }

        const resolved = type === 'A' ? await lookup(p.host).catch(() => null) : null;
        return (
          `${p.host} ${type}: ${records.join(', ')}` +
          (resolved && !records.includes(resolved.address)
            ? `\nsystem resolver: ${resolved.address} (IPv${resolved.family})`
            : '')
        );
      }

      if (a === 'tcp_check') {
        if (!p.host) throw new Error('tcp_check needs "host"');
        const ports = Array.isArray(p.ports) && p.ports.length ? p.ports : p.port ? [p.port] : null;
        if (!ports) throw new Error('tcp_check needs "port" or "ports"');
        const results = await Promise.all(
          ports.map(async (port) => ({ port, ...(await tcpCheck(p.host, Number(port), timeout)) })),
        );
        return results
          .map((r) =>
            r.open
              ? `${p.host}:${r.port} OPEN (${r.ms}ms)`
              : `${p.host}:${r.port} closed — ${r.reason} (${r.ms}ms)`,
          )
          .join('\n');
      }

      if (a === 'listening') {
        const { rows, via } = await listeningPorts(cfg, p.port ? Number(p.port) : null);
        if (!rows.length) {
          return p.port
            ? `nothing is listening on port ${p.port}`
            : 'no listening sockets found (ss and netstat were unavailable or returned nothing)';
        }
        const body = rows
          .map(
            (r) =>
              `${r.proto.padEnd(4)} ${String(r.port).padStart(6)}  ${r.address.padEnd(24)}` +
              `${r.pid ? ` pid=${r.pid}` : ''}${r.name ? ` ${r.name}` : ''}`,
          )
          .join('\n');
        return `${rows.length} listening socket(s) (via ${via})\n${truncateMiddle(body, cap).text}`;
      }

      if (a === 'ping') {
        if (!p.host) throw new Error('ping needs "host"');
        const count = p.count ?? 3;
        const args = IS_WIN ? ['-n', String(count), p.host] : ['-c', String(count), p.host];
        const run = await runArgv(cfg, { file: 'ping', args, timeoutMs: Math.max(timeout, count * 2000 + 3000) });
        if (run.error) throw new Error(`ping unavailable: ${run.error}`);
        return `ping ${p.host} exit=${run.exitCode}\n${shapeOutput(run.stdout || run.stderr, { maxBytes: cap }).text}`;
      }

      throw new Error(`Unknown net action "${a}"`);
    },
  };
}

function restoreTls(prev) {
  if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
}
