// MCP server over stdio: newline-delimited JSON-RPC 2.0.
//
// Implemented by hand rather than via the SDK so the whole thing runs with
// zero dependencies — `node bin/terminalmcp.js` and it is live, no install.

import process from 'node:process';
import { appendFile } from 'node:fs/promises';
import { buildToolset } from './tools/index.js';
import { stopAllWatchers } from './tools/watch.js';
import { VarStore } from './vars.js';
import { applyInterpolation, varContext, unresolvedNote } from './tools/interpolate.js';
import { JobManager } from './jobs.js';
import { PolicyError } from './guards.js';

export const SERVER_NAME = 'terminalmcp';
export const SERVER_VERSION = '0.1.0';

// Protocol revisions we know how to speak. We echo the client's choice when we
// recognise it, otherwise we answer with our newest.
export const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];
export const LATEST_PROTOCOL = '2025-06-18';

const JSONRPC = '2.0';
const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
};

export function log(...args) {
  // stdout carries the protocol — diagnostics must go to stderr only.
  process.stderr.write(`[terminalmcp] ${args.join(' ')}\n`);
}

export class Server {
  constructor(cfg) {
    this.cfg = cfg;
    this.jobs = new JobManager(cfg);
    this.vars = new VarStore({
      varsFile: cfg.varsFile,
      persistSecrets: cfg.persistSecrets,
      maxVars: cfg.maxVars,
      maxVarBytes: cfg.maxVarBytes,
      maxTotalBytes: cfg.maxVarsTotalBytes,
    });
    // The active toolset depends on cfg.tools, so it is built per server
    // rather than being a module-level constant.
    const toolset = buildToolset(cfg.tools, {
      cfg,
      jobs: this.jobs,
      vars: this.vars,
      server: this,
    });
    this.tools = toolset.tools;
    this.handlers = toolset.handlers;
    this.toolGroups = toolset.groups;
    this.toolTokens = toolset.estimatedTokens;
    this.initialized = false;
    this.clientInfo = null;
    this.protocolVersion = LATEST_PROTOCOL;
  }

  async audit(entry) {
    if (!this.cfg.logFile) return;
    try {
      await appendFile(this.cfg.logFile, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
    } catch {
      /* never let logging break a tool call */
    }
  }

  /**
   * Handle one parsed JSON-RPC message. Returns a response, or null for
   * notifications.
   *
   * `session` carries the per-connection protocol state. stdio has exactly one
   * connection so it defaults to the server itself; the HTTP transport passes
   * a distinct session object per client, since several clients may be talking
   * to the same machine at different protocol revisions.
   */
  async handle(msg, session = this) {
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
      return errorResponse(null, ERR.invalidRequest, 'Request must be a JSON object');
    }
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    if (typeof method !== 'string') {
      return isNotification ? null : errorResponse(id, ERR.invalidRequest, 'Missing "method"');
    }

    try {
      switch (method) {
        case 'initialize': {
          const requested = params?.protocolVersion;
          session.protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : LATEST_PROTOCOL;
          session.clientInfo = params?.clientInfo ?? null;
          log(
            `initialize from ${session.clientInfo?.name ?? 'unknown client'} ` +
            `(protocol ${requested ?? 'unspecified'} -> ${session.protocolVersion})`,
          );
          return result(id, {
            protocolVersion: session.protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            instructions:
              'Full terminal and system control. Batch work through shell_bulk instead of many ' +
              'shell_exec calls; locate code with search_text instead of reading whole files; ' +
              'patch files with file_edit; call project_info once to orient in an unfamiliar repo.',
          });
        }

        case 'notifications/initialized':
        case 'initialized':
          session.initialized = true;
          return null;

        case 'ping':
          return result(id, {});

        case 'tools/list':
          return result(id, { tools: this.tools });

        // Declared capabilities do not include these, but some clients probe
        // anyway; empty lists are friendlier than a method-not-found error.
        case 'resources/list':
          return result(id, { resources: [] });
        case 'resources/templates/list':
          return result(id, { resourceTemplates: [] });
        case 'prompts/list':
          return result(id, { prompts: [] });

        case 'tools/call':
          return await this.callTool(id, params);

        case 'notifications/cancelled':
        case 'notifications/roots/list_changed':
          return null;

        case 'shutdown':
          return result(id, {});

        default:
          if (isNotification) return null;
          return errorResponse(id, ERR.methodNotFound, `Unknown method: ${method}`);
      }
    } catch (err) {
      log(`internal error in ${method}: ${err.stack || err.message}`);
      return isNotification ? null : errorResponse(id, ERR.internal, err.message);
    }
  }

  async callTool(id, params) {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const handler = this.handlers[name];
    if (!handler) {
      return errorResponse(
        id,
        ERR.invalidParams,
        `Unknown tool "${name}". Available: ${this.tools.map((t) => t.name).join(', ')}`,
      );
    }

    const startedAt = Date.now();
    // ${vars.…} is expanded here rather than in 25 handlers; see
    // tools/interpolate.js for exactly which fields are eligible.
    const { args: expanded, unresolved } = applyInterpolation(name, args, varContext(this.vars));

    try {
      const text = await handler(expanded);
      const note = unresolvedNote(unresolved, this.vars);
      this.audit({ tool: name, ok: true, ms: Date.now() - startedAt, args: redact(expanded) });
      return result(id, {
        content: [{ type: 'text', text: note ? `${text}\n${note}` : String(text) }],
      });
    } catch (err) {
      this.audit({ tool: name, ok: false, ms: Date.now() - startedAt, error: err.message, args: redact(expanded) });
      const prefix = err instanceof PolicyError ? 'Policy' : 'Error';
      // Tool failures come back as content with isError, not as protocol
      // errors: the model needs to read the message and correct itself.
      const note = unresolvedNote(unresolved, this.vars);
      return result(id, {
        content: [{ type: 'text', text: `${prefix}: ${err.message}${note ? `\n${note}` : ''}` }],
        isError: true,
      });
    }
  }
}

function redact(args) {
  const out = { ...args };
  // A secret being stored must not land in the audit log in plain text.
  if (out.secret === true && out.value !== undefined) out.value = '<secret>';
  if (typeof out.content === 'string') out.content = `<${out.content.length} chars>`;
  if (typeof out.stdin === 'string') out.stdin = `<${out.stdin.length} chars>`;
  if (typeof out.data === 'string') out.data = `<${out.data.length} chars>`;
  return out;
}

function result(id, value) {
  return { jsonrpc: JSONRPC, id, result: value };
}

function errorResponse(id, code, message) {
  return { jsonrpc: JSONRPC, id: id ?? null, error: { code, message } };
}

/** Wire a Server to stdin/stdout and start reading messages. */
export function serveStdio(server, { input = process.stdin, output = process.stdout } = {}) {
  let buffer = '';

  const send = (msg) => {
    if (!msg) return;
    output.write(`${JSON.stringify(msg)}\n`);
  };

  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        send(errorResponse(null, ERR.parse, `Invalid JSON: ${err.message}`));
        continue;
      }

      // Batches are legal JSON-RPC; handle each element independently.
      const items = Array.isArray(msg) ? msg : [msg];
      for (const item of items) {
        // Deliberately not awaited: a long shell_exec must not block the loop,
        // so other requests (and shell_job polls) stay responsive.
        server.handle(item).then(send).catch((err) => {
          log(`handler crash: ${err.stack || err.message}`);
          send(errorResponse(item?.id ?? null, ERR.internal, err.message));
        });
      }
    }
  });

  const shutdown = (why) => {
    server.vars.flush();
    const n = server.jobs.killAll('SIGTERM');
    const w = stopAllWatchers();
    if (n || w) log(`${why}: terminated ${n} job(s), closed ${w} watcher(s)`);
    process.exit(0);
  };

  input.on('end', () => shutdown('stdin closed'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => log(`uncaught: ${err.stack || err.message}`));
  process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err?.stack || err}`));
}
