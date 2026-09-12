// Configuration loading. Precedence (highest first):
//   1. per-call tool params      2. TERMINALMCP_* env vars
//   3. config file               4. built-in defaults
//
// Config file lookup order:
//   $TERMINALMCP_CONFIG
//   ./terminalmcp.config.json        (from --cwd / process cwd)
//   ./.terminalmcp.json
//   ~/.terminalmcp/config.json

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as resolvePath, isAbsolute } from 'node:path';
import process from 'node:process';

export const DEFAULTS = {
  // Shell: "auto" picks the system default (pwsh/powershell/cmd on Windows,
  // $SHELL then bash/zsh/sh elsewhere). Or name one: bash, gitbash, zsh, fish,
  // sh, cmd, powershell, pwsh, wsl — or give an absolute path to any binary.
  shell: 'auto',
  // Extra named shells usable by name from the `shell` param.
  // e.g. { "myshell": { "command": "C:/tools/busybox.exe", "args": ["sh","-c"] } }
  shells: {},
  // Run commands through a login shell (-lc) so ~/.profile aliases exist.
  login: false,
  // Default working directory for commands. Relative paths resolve against it.
  cwd: null,
  // Hard timeout per command (ms). 0 disables.
  timeoutMs: 120000,
  // Byte cap per returned stream, before truncation kicks in. ~4 bytes/token.
  maxOutputBytes: 16000,
  // Byte cap for what we buffer in memory per stream (protects the process).
  maxBufferBytes: 8 * 1024 * 1024,
  // Extra env vars injected into every command.
  env: {},
  // Keep ANSI colour codes in output (off: fewer tokens).
  keepAnsi: false,
  // Concurrency ceiling for background jobs.
  maxJobs: 32,
  // Completed jobs are dropped after this long (ms).
  jobRetentionMs: 30 * 60 * 1000,
  // --- Optional guardrails. Empty/false means "full access", as intended. ---
  // If non-empty, file tools and cwd must stay inside one of these roots.
  allowedRoots: [],
  // Regexes; a command matching any of them is refused.
  denyCommands: [],
  // Refuse writes to paths matching any of these regexes.
  denyPaths: [],
  // Read-only mode: block writes, edits and command execution.
  readOnly: false,
  // Append a JSONL audit log of every tool call here.
  logFile: null,
  // HTTP transport. Off by default: stdio is the normal way to run an MCP
  // server. Enable with --http, or set http.enabled here.
  http: {
    enabled: false,
    host: '127.0.0.1',
    port: 8787,
    path: '/mcp',
    ssePath: '/sse',
    messagePath: '/messages',
    maxBodyBytes: 33554432,
    cors: true,
    strictSessions: false,
    sseReplies: false,
  },
};

function readJson(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    // Tolerate JSONC-style // and /* */ comments and trailing commas.
    const stripped = raw
      .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*$|\/\*[\s\S]*?\*\/)/gm, (m, c) => (c ? '' : m))
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(stripped);
  } catch (err) {
    throw new Error(`Cannot parse config file ${path}: ${err.message}`);
  }
}

function candidatePaths(cwd) {
  const list = [];
  if (process.env.TERMINALMCP_CONFIG) list.push(process.env.TERMINALMCP_CONFIG);
  list.push(join(cwd, 'terminalmcp.config.json'));
  list.push(join(cwd, '.terminalmcp.json'));
  list.push(join(homedir(), '.terminalmcp', 'config.json'));
  return list;
}

function envOverrides() {
  const e = process.env;
  const out = {};
  if (e.TERMINALMCP_SHELL) out.shell = e.TERMINALMCP_SHELL;
  if (e.TERMINALMCP_CWD) out.cwd = e.TERMINALMCP_CWD;
  if (e.TERMINALMCP_TIMEOUT_MS) out.timeoutMs = Number(e.TERMINALMCP_TIMEOUT_MS);
  if (e.TERMINALMCP_MAX_OUTPUT_BYTES) out.maxOutputBytes = Number(e.TERMINALMCP_MAX_OUTPUT_BYTES);
  if (e.TERMINALMCP_LOGIN) out.login = truthy(e.TERMINALMCP_LOGIN);
  if (e.TERMINALMCP_KEEP_ANSI) out.keepAnsi = truthy(e.TERMINALMCP_KEEP_ANSI);
  if (e.TERMINALMCP_READ_ONLY) out.readOnly = truthy(e.TERMINALMCP_READ_ONLY);
  if (e.TERMINALMCP_LOG_FILE) out.logFile = e.TERMINALMCP_LOG_FILE;
  if (e.TERMINALMCP_ALLOWED_ROOTS) {
    out.allowedRoots = e.TERMINALMCP_ALLOWED_ROOTS.split(/[;:](?![\\/])/).filter(Boolean);
  }

  const http = {};
  if (e.TERMINALMCP_HTTP) http.enabled = truthy(e.TERMINALMCP_HTTP);
  if (e.TERMINALMCP_HTTP_HOST) http.host = e.TERMINALMCP_HTTP_HOST;
  if (e.TERMINALMCP_HTTP_PORT) http.port = Number(e.TERMINALMCP_HTTP_PORT);
  if (e.TERMINALMCP_HTTP_PATH) http.path = e.TERMINALMCP_HTTP_PATH;
  if (e.TERMINALMCP_HTTP_CORS) http.cors = truthy(e.TERMINALMCP_HTTP_CORS);
  if (Object.keys(http).length) out.http = http;

  return out;
}

function truthy(v) {
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

export function loadConfig({ cwd = process.cwd(), overrides = {} } = {}) {
  let fileCfg = {};
  let sourcePath = null;
  for (const p of candidatePaths(cwd)) {
    if (p && existsSync(p)) {
      fileCfg = readJson(p);
      sourcePath = p;
      break;
    }
  }

  const envCfg = envOverrides();
  const cfg = { ...DEFAULTS, ...fileCfg, ...envCfg, ...overrides };
  cfg.env = { ...(DEFAULTS.env), ...(fileCfg.env || {}), ...(overrides.env || {}) };
  cfg.shells = { ...(fileCfg.shells || {}), ...(overrides.shells || {}) };
  // http is a nested object, so merge it layer by layer instead of replacing.
  cfg.http = {
    ...DEFAULTS.http,
    ...(fileCfg.http || {}),
    ...(envCfg.http || {}),
    ...(overrides.http || {}),
  };
  cfg.configPath = sourcePath;

  // Normalize the base cwd to an absolute, existing directory.
  const base = cfg.cwd ? (isAbsolute(cfg.cwd) ? cfg.cwd : resolvePath(cwd, cfg.cwd)) : cwd;
  cfg.cwd = base;

  cfg.allowedRoots = (cfg.allowedRoots || []).map((r) =>
    isAbsolute(r) ? resolvePath(r) : resolvePath(base, r),
  );
  cfg.denyCommands = compileRegexes(cfg.denyCommands, 'denyCommands');
  cfg.denyPaths = compileRegexes(cfg.denyPaths, 'denyPaths');

  return cfg;
}

function compileRegexes(list, label) {
  return (list || []).map((p) => {
    try {
      return p instanceof RegExp ? p : new RegExp(p, 'i');
    } catch (err) {
      throw new Error(`Invalid regex in ${label}: ${p} (${err.message})`);
    }
  });
}
