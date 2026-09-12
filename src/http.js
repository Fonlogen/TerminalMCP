// HTTP transport. Two shapes, both served at once:
//
//  1. Streamable HTTP (MCP 2025-03-26 / 2025-06-18) — the current transport.
//     POST /mcp   send a JSON-RPC message, get the reply back
//     GET  /mcp   open an SSE stream for server-initiated messages
//     DELETE /mcp end the session
//
//  2. HTTP+SSE (MCP 2024-11-05) — the legacy transport, for older clients.
//     GET  /sse       open the stream, first event names the POST endpoint
//     POST /messages  send a message; the reply arrives on the SSE stream
//
// There is NO authentication, by design of this build. Bind to 127.0.0.1
// unless you intend to expose the machine.

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { SERVER_NAME, SERVER_VERSION, log } from './server.js';
import { TOOLS } from './tools.js';

const SSE_KEEPALIVE_MS = 15000;
const SESSION_IDLE_MS = 30 * 60 * 1000;

export const HTTP_DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  path: '/mcp',
  ssePath: '/sse',
  messagePath: '/messages',
  maxBodyBytes: 32 * 1024 * 1024,
  cors: true,
  // When false (the default) a request carrying an unknown session id is still
  // served instead of being rejected with 404. Nothing here is authenticated,
  // so being strict only breaks clients that forget the header.
  strictSessions: false,
  // Reply to POSTs with an SSE stream even when the client would take JSON.
  // Off by default: clients send "Accept: application/json, text/event-stream"
  // on every request, and wrapping every small reply in an event stream buys
  // nothing. Turn it on behind a proxy that cuts idle responses, so keepalive
  // comments can flow while a long command runs.
  sseReplies: false,
};

class Session {
  constructor(id) {
    this.id = id;
    this.createdAt = Date.now();
    this.lastSeen = Date.now();
    // Per-connection protocol state, read and written by Server.handle().
    this.protocolVersion = null;
    this.clientInfo = null;
    this.initialized = false;
    // Open SSE streams: GET /mcp streams, plus the legacy GET /sse stream.
    this.streams = new Set();
    this.legacyStream = null;
  }

  touch() {
    this.lastSeen = Date.now();
  }

  send(msg) {
    const target = this.legacyStream ?? [...this.streams][0];
    if (!target) return false;
    writeSse(target, 'message', msg);
    return true;
  }

  closeStreams() {
    for (const res of this.streams) endQuietly(res);
    this.streams.clear();
    if (this.legacyStream) {
      endQuietly(this.legacyStream);
      this.legacyStream = null;
    }
  }
}

function writeSse(res, event, data) {
  if (res.writableEnded) return;
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  // Data may contain newlines (it should not, as JSON, but be safe): SSE
  // requires one `data:` line per line of payload.
  const lines = payload.split('\n').map((l) => `data: ${l}`).join('\n');
  res.write(`event: ${event}\n${lines}\n\n`);
}

function endQuietly(res) {
  try {
    if (!res.writableEnded) res.end();
  } catch {
    /* the peer is already gone */
  }
}

function corsHeaders(opts, req) {
  if (!opts.cors) return {};
  return {
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, Authorization',
    // Without this the browser hides the session id from the client.
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, MCP-Protocol-Version',
    'Access-Control-Max-Age': '86400',
  };
}

function sendJson(res, status, body, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    ...extra,
  });
  res.end(text);
}

function sendText(res, status, text, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...extra,
  });
  res.end(text);
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflowed = false;
    req.on('data', (c) => {
      if (overflowed) return;
      size += c.length;
      if (size > maxBytes) {
        overflowed = true;
        // Stop buffering but leave the socket alone: destroying it here would
        // race the 413 and the client would see a reset instead of the reason.
        req.pause();
        reject(Object.assign(new Error(`Request body exceeds ${maxBytes} bytes`), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** True when the message is a request (expects a reply) rather than a notification. */
function isRequest(msg) {
  return msg && typeof msg === 'object' && msg.id !== undefined && msg.id !== null;
}

function isInitialize(messages) {
  return messages.some((m) => m && m.method === 'initialize');
}

export function serveHttp(server, options = {}) {
  const opts = { ...HTTP_DEFAULTS, ...options };
  const sessions = new Map();

  // A session-less fallback so lenient clients that never send the header
  // still get consistent protocol state instead of a fresh one per request.
  const implicitSession = new Session('implicit');

  const gc = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, s] of sessions) {
      if (s.lastSeen < cutoff && s.streams.size === 0 && !s.legacyStream) {
        sessions.delete(id);
        log(`session ${id} expired`);
      }
    }
  }, 60000);
  gc.unref();

  function resolveSession(req, res, messages) {
    const given = req.headers['mcp-session-id'];

    if (Array.isArray(messages) && isInitialize(messages)) {
      // A fresh initialize always starts a new session.
      const s = new Session(randomUUID());
      sessions.set(s.id, s);
      log(`session ${s.id} opened (${sessions.size} active)`);
      return { session: s, isNew: true };
    }

    if (given) {
      const s = sessions.get(given);
      if (s) {
        s.touch();
        return { session: s, isNew: false };
      }
      if (opts.strictSessions) {
        sendJson(res, 404, rpcError(null, -32001, 'Unknown or expired session; send initialize again.'), {
          ...corsHeaders(opts, req),
        });
        return null;
      }
    }
    return { session: implicitSession, isNew: false };
  }

  /** Run a batch of messages and collect the replies that are actually owed. */
  async function dispatch(messages, session) {
    const replies = [];
    for (const msg of messages) {
      const reply = await server.handle(msg, session).catch((err) => {
        log(`handler crash: ${err.stack || err.message}`);
        return rpcError(msg?.id ?? null, -32603, err.message);
      });
      if (reply) replies.push(reply);
    }
    return replies;
  }

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const cors = corsHeaders(opts, req);

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        res.end();
        return;
      }

      // ------------------------------------------------------- info / health
      if (req.method === 'GET' && (path === '/' || path === '/health')) {
        const live = server.jobs.list();
        const body = {
          name: SERVER_NAME,
          version: SERVER_VERSION,
          status: 'ok',
          transport: 'streamable-http + legacy-sse',
          endpoints: {
            streamableHttp: opts.path,
            legacySse: opts.ssePath,
            legacyMessages: opts.messagePath,
          },
          platform: `${process.platform}/${process.arch}`,
          node: process.version,
          cwd: server.cfg.cwd,
          shell: server.cfg.shell,
          tools: TOOLS.map((t) => t.name),
          sessions: sessions.size,
          jobs: { tracked: live.length, running: live.filter((j) => j.run.running).length },
          uptimeSeconds: Math.round(process.uptime()),
        };
        sendJson(res, 200, body, cors);
        return;
      }

      // -------------------------------------------- Streamable HTTP: POST
      if (req.method === 'POST' && path === opts.path) {
        const raw = await readBody(req, opts.maxBodyBytes);
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          sendJson(res, 400, rpcError(null, -32700, `Invalid JSON: ${err.message}`), cors);
          return;
        }
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        const resolved = resolveSession(req, res, messages);
        if (!resolved) return; // already answered with 404
        const { session, isNew } = resolved;

        const sessionHeader = session.id === 'implicit' ? {} : { 'Mcp-Session-Id': session.id };
        const expectsReply = messages.some(isRequest);

        if (!expectsReply) {
          // Nothing but notifications / responses: acknowledge and stop.
          res.writeHead(202, { ...cors, ...(isNew ? sessionHeader : {}) });
          res.end();
          return;
        }

        // Both shapes are spec-legal and the server picks. Clients send
        // "application/json, text/event-stream" on every request, so prefer
        // plain JSON and reserve SSE for clients that will not take JSON (or
        // for when sseReplies is on).
        const accept = String(req.headers.accept || '');
        const acceptsSse = accept.includes('text/event-stream');
        const acceptsJson =
          accept === '' || accept.includes('application/json') || accept.includes('*/*');
        const useSse = acceptsSse && (!acceptsJson || opts.sseReplies);

        if (!useSse) {
          const replies = await dispatch(messages, session);
          const body = Array.isArray(parsed) ? replies : replies[0];
          sendJson(res, 200, body, { ...cors, ...sessionHeader });
          return;
        }

        // SSE reply stream: keepalive comments stop a proxy from cutting the
        // connection while a tool call runs for minutes (a build, a test run).
        res.writeHead(200, {
          ...cors,
          ...sessionHeader,
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(': open\n\n');

        const keepalive = setInterval(() => {
          if (!res.writableEnded) res.write(': keepalive\n\n');
        }, SSE_KEEPALIVE_MS);
        let closed = false;
        req.on('close', () => {
          closed = true;
          clearInterval(keepalive);
        });

        const replies = await dispatch(messages, session);
        clearInterval(keepalive);
        if (!closed) {
          for (const reply of replies) writeSse(res, 'message', reply);
          endQuietly(res);
        }
        return;
      }

      // --------------------------------------------- Streamable HTTP: GET
      if (req.method === 'GET' && path === opts.path) {
        const accept = String(req.headers.accept || '');
        if (!accept.includes('text/event-stream') && accept !== '' && !accept.includes('*/*')) {
          sendText(res, 406, 'This endpoint speaks text/event-stream on GET.', cors);
          return;
        }
        const given = req.headers['mcp-session-id'];
        const session = (given && sessions.get(given)) || implicitSession;
        session.touch();

        res.writeHead(200, {
          ...cors,
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(': open\n\n');
        session.streams.add(res);

        const keepalive = setInterval(() => {
          if (!res.writableEnded) res.write(': keepalive\n\n');
        }, SSE_KEEPALIVE_MS);
        req.on('close', () => {
          clearInterval(keepalive);
          session.streams.delete(res);
        });
        return;
      }

      // ------------------------------------------ Streamable HTTP: DELETE
      if (req.method === 'DELETE' && path === opts.path) {
        const given = req.headers['mcp-session-id'];
        const session = given && sessions.get(given);
        if (session) {
          session.closeStreams();
          sessions.delete(given);
          log(`session ${given} closed by client`);
        }
        res.writeHead(204, cors);
        res.end();
        return;
      }

      // --------------------------------------------- legacy: GET /sse
      if (req.method === 'GET' && path === opts.ssePath) {
        const session = new Session(randomUUID());
        sessions.set(session.id, session);
        log(`legacy SSE session ${session.id} opened`);

        res.writeHead(200, {
          ...cors,
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        session.legacyStream = res;
        // The 2024-11-05 transport starts by telling the client where to POST.
        writeSse(res, 'endpoint', `${opts.messagePath}?sessionId=${session.id}`);

        const keepalive = setInterval(() => {
          if (!res.writableEnded) res.write(': keepalive\n\n');
        }, SSE_KEEPALIVE_MS);
        req.on('close', () => {
          clearInterval(keepalive);
          session.legacyStream = null;
          sessions.delete(session.id);
          log(`legacy SSE session ${session.id} closed`);
        });
        return;
      }

      // ----------------------------------------- legacy: POST /messages
      if (req.method === 'POST' && path === opts.messagePath) {
        const sid = url.searchParams.get('sessionId') || req.headers['mcp-session-id'];
        const session = sid && sessions.get(sid);
        if (!session) {
          sendJson(res, 404, rpcError(null, -32001, 'Unknown sessionId; reconnect to the SSE endpoint.'), cors);
          return;
        }
        session.touch();

        const raw = await readBody(req, opts.maxBodyBytes);
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          sendJson(res, 400, rpcError(null, -32700, `Invalid JSON: ${err.message}`), cors);
          return;
        }
        const messages = Array.isArray(parsed) ? parsed : [parsed];

        // The legacy transport acknowledges over HTTP and delivers the actual
        // reply on the SSE stream, so answer now and dispatch in the background.
        res.writeHead(202, { ...cors, 'Content-Type': 'text/plain' });
        res.end('Accepted');

        dispatch(messages, session)
          .then((replies) => {
            for (const reply of replies) {
              if (!session.send(reply)) {
                log(`session ${session.id}: no open stream, dropped reply id=${reply.id}`);
              }
            }
          })
          .catch((err) => log(`legacy dispatch failed: ${err.stack || err.message}`));
        return;
      }

      sendText(
        res,
        404,
        `Not found: ${req.method} ${path}\n\n` +
          `Streamable HTTP: POST|GET|DELETE ${opts.path}\n` +
          `Legacy SSE:      GET ${opts.ssePath} then POST ${opts.messagePath}\n` +
          `Health:          GET /health\n`,
        cors,
      );
    } catch (err) {
      const status = err.status || 500;
      log(`http ${req.method} ${path} failed: ${err.stack || err.message}`);
      if (!res.headersSent) {
        const code = status === 413 ? -32600 : -32603;
        sendJson(res, status, rpcError(null, code, err.message), {
          ...cors,
          // The request body was cut short, so the connection is not reusable.
          ...(status === 413 ? { Connection: 'close' } : {}),
        });
      } else {
        endQuietly(res);
      }
      if (status === 413) res.on('finish', () => req.destroy());
    }
  });

  // Long shell commands must not be cut off by a server-side socket timeout.
  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = 60000;
  httpServer.keepAliveTimeout = 72000;
  httpServer.timeout = 0;

  const shutdown = (why) => {
    log(`${why}: shutting down HTTP transport`);
    clearInterval(gc);
    for (const s of sessions.values()) s.closeStreams();
    implicitSession.closeStreams();
    const n = server.jobs.killAll('SIGTERM');
    if (n) log(`terminated ${n} running job(s)`);
    httpServer.close(() => process.exit(0));
    // Do not let a lingering keep-alive socket hold the process open.
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => log(`uncaught: ${err.stack || err.message}`));
  process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err?.stack || err}`));

  httpServer.listen(opts.port, opts.host, () => {
    const shown = opts.host === '0.0.0.0' || opts.host === '::' ? 'localhost' : opts.host;
    log(`HTTP transport listening on http://${opts.host}:${opts.port}`);
    log(`  streamable http: http://${shown}:${opts.port}${opts.path}`);
    log(`  legacy sse:      http://${shown}:${opts.port}${opts.ssePath}`);
    log(`  health:          http://${shown}:${opts.port}/health`);
    if (opts.host !== '127.0.0.1' && opts.host !== 'localhost' && opts.host !== '::1') {
      log('  NOTE: reachable off-machine and there is NO authentication — anyone');
      log('        who can reach this port has a full shell on this machine.');
    }
  });

  return httpServer;
}
