#!/usr/bin/env node
// TerminalMCP entry point.
//   terminalmcp                 start the MCP server on stdio
//   terminalmcp --print-config  print a client config snippet to paste
//   terminalmcp --doctor        check the environment and exit

import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { Server, serveStdio, SERVER_NAME, SERVER_VERSION, log } from '../src/server.js';
import { serveHttp } from '../src/http.js';
import { detectAvailable, resolveShell } from '../src/shells.js';
import { buildToolset, describeGroups, GROUP_NAMES, ALIASES } from '../src/tools/index.js';
import { findBrowser } from '../src/cdp.js';
import { LINUX_CAPTURERS, sessionType } from '../src/screen.js';
import { BUILTIN_PLUGINS, describePlugins, loadPlugins, parsePluginList } from '../src/plugins.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ENTRY = join(ROOT, 'bin', 'terminalmcp.js');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [rawKey, inlineVal] = a.slice(2).split(/=(.*)/s);
    const key = rawKey.replace(/-/g, '_');
    // A flag given more than once accumulates, so --allowed-root and --plugin
    // can each be repeated rather than the last one silently winning.
    const set = (v) => {
      if (out[key] === undefined) out[key] = v;
      else if (Array.isArray(out[key])) out[key].push(v);
      else out[key] = [out[key], v];
    };
    if (inlineVal !== undefined) { set(inlineVal); continue; }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { set(next); i++; } else { set(true); }
  }
  return out;
}

const HELP = `${SERVER_NAME} v${SERVER_VERSION} — full terminal control over MCP, zero dependencies.

Usage:
  terminalmcp [options]              start the server (stdio transport)
  terminalmcp --http                 start the server on HTTP instead of stdio
  terminalmcp --print-config         print an MCP client config snippet
  terminalmcp --doctor               report platform, shells and config, then exit
  terminalmcp --list-tools           list the exposed tools, then exit

HTTP transport (no authentication — see README):
  --http                 serve over HTTP rather than stdio
  --port <n>             port to listen on (default 8787)
  --host <addr>          bind address (default 127.0.0.1; use 0.0.0.0 to expose)
  --path <path>          Streamable HTTP endpoint (default /mcp)
  --no-cors              do not send CORS headers
  --strict-sessions      reject requests carrying an unknown Mcp-Session-Id
  --sse-replies          answer POSTs with an SSE stream even when JSON would do
                         (only needed behind a proxy that cuts idle responses)
  --max-body-bytes <n>   request body cap (default 33554432)

Options:
  --cwd <dir>            default working directory for commands
  --shell <name|path>    auto | bash | gitbash | zsh | fish | sh | cmd | powershell | pwsh | wsl | /path/to/shell
  --config <file>        explicit config file (else terminalmcp.config.json / ~/.terminalmcp/config.json)
  --timeout-ms <n>       default per-command timeout (0 = unlimited)
  --max-output-bytes <n> byte cap per returned stream
  --login                run commands through a login shell
  --read-only            block writes and command execution
  --allowed-root <dir>   restrict file tools to this directory (repeatable)
  --log-file <file>      append a JSONL audit log of tool calls
  --vars-file <file>     mirror the server variable store to this file so it survives a restart
  --persist-secrets      also write variables marked secret to that file
  --max-vars <n>         how many variables may be stored (default 200)
  --max-var-bytes <n>    size cap per variable (default 1048576)
  --plugin <name|path>   enable an optional plugin (repeatable): fivem, discord, telegram,
                         or a path to your own .js. Off by default — plugin schemas
                         cost tokens too. Credentials go in the config file or env vars.
  --browser-path <file>  Chromium-family binary for the browser tool (else auto-detected)
  --no-headless          launch the browser with a visible window
  --shots-dir <dir>      where screenshots are saved (default <cwd>/.terminalmcp/shots)
  --max-image-width <n>  scale screenshots to this width before returning (default 1200).
                         An image costs roughly width x height / 750 tokens, so this matters.
  --tools <profile>      which tool groups to expose (default all). Tool schemas cost tokens
                         on every request, so trim them when you do not need them:
                           all      everything (28 tools, ~13.9k tokens)
                           core     shell, jobs, bulk, files, vars (10 tools, ~4.8k)
                           dev      core + search, git, fs, dev, data (~9.2k)
                           ops      core + search, fs, archive, sys, net (~8.5k)
                           web      core + browser, screen, net, search, fs (~10.6k)
                         Or a list: --tools core,git,search  /  --tools all,-watch,-archive
                         Groups: ${GROUP_NAMES.join(', ')}
  -h, --help             this text
  -v, --version          print the version

Env: TERMINALMCP_SHELL, TERMINALMCP_CWD, TERMINALMCP_TIMEOUT_MS, TERMINALMCP_MAX_OUTPUT_BYTES,
     TERMINALMCP_LOGIN, TERMINALMCP_KEEP_ANSI, TERMINALMCP_READ_ONLY, TERMINALMCP_LOG_FILE,
     TERMINALMCP_ALLOWED_ROOTS, TERMINALMCP_CONFIG, TERMINALMCP_TOOLS, TERMINALMCP_VARS_FILE,
     TERMINALMCP_BROWSER_PATH, TERMINALMCP_BROWSER_HEADLESS, TERMINALMCP_SHOTS_DIR,
     TERMINALMCP_PLUGINS,
     TERMINALMCP_HTTP, TERMINALMCP_HTTP_HOST, TERMINALMCP_HTTP_PORT, TERMINALMCP_HTTP_PATH,
     TERMINALMCP_HTTP_CORS
`;

function overridesFrom(args) {
  const o = {};
  if (typeof args.cwd === 'string') o.cwd = args.cwd;
  if (typeof args.shell === 'string') o.shell = args.shell;
  if (args.timeout_ms !== undefined) o.timeoutMs = Number(args.timeout_ms);
  if (args.max_output_bytes !== undefined) o.maxOutputBytes = Number(args.max_output_bytes);
  if (args.login) o.login = true;
  if (args.keep_ansi) o.keepAnsi = true;
  if (args.read_only) o.readOnly = true;
  if (typeof args.log_file === 'string') o.logFile = args.log_file;
  if (args.allowed_root) {
    o.allowedRoots = Array.isArray(args.allowed_root) ? args.allowed_root : [args.allowed_root];
  }
  if (args.max_jobs !== undefined) o.maxJobs = Number(args.max_jobs);
  if (typeof args.tools === 'string') o.tools = args.tools;
  if (typeof args.vars_file === 'string') o.varsFile = args.vars_file;
  if (args.persist_secrets) o.persistSecrets = true;
  if (args.max_vars !== undefined) o.maxVars = Number(args.max_vars);
  if (args.max_var_bytes !== undefined) o.maxVarBytes = Number(args.max_var_bytes);

  if (args.plugin) o.plugins = Array.isArray(args.plugin) ? args.plugin : [args.plugin];
  if (typeof args.plugins === 'string') o.plugins = args.plugins;

  const browser = {};
  if (typeof args.browser_path === 'string') browser.executable = args.browser_path;
  if (args.no_headless) browser.headless = false;
  if (Object.keys(browser).length) o.browser = browser;

  const shots = {};
  if (typeof args.shots_dir === 'string') shots.dir = args.shots_dir;
  if (args.max_image_width !== undefined) shots.maxWidth = Number(args.max_image_width);
  if (Object.keys(shots).length) o.screenshots = shots;

  const http = {};
  if (args.http) http.enabled = true;
  if (args.port !== undefined) http.port = Number(args.port);
  if (typeof args.host === 'string') http.host = args.host;
  if (typeof args.path === 'string') http.path = args.path;
  if (args.no_cors) http.cors = false;
  if (args.strict_sessions) http.strictSessions = true;
  if (args.sse_replies) http.sseReplies = true;
  if (args.max_body_bytes !== undefined) http.maxBodyBytes = Number(args.max_body_bytes);
  if (Object.keys(http).length) o.http = http;

  return o;
}

function printConfigSnippet(cfg) {
  if (cfg.http.enabled) {
    printHttpConfigSnippet(cfg);
    return;
  }
  const block = {
    mcpServers: {
      terminal: {
        command: 'node',
        args: [ENTRY],
        env: {
          TERMINALMCP_CWD: cfg.cwd,
          ...(cfg.shell !== 'auto' ? { TERMINALMCP_SHELL: String(cfg.shell) } : {}),
        },
      },
    },
  };

  const lines = [
    '# Claude Code / Claude Desktop / Cursor  (claude_desktop_config.json, .mcp.json)',
    JSON.stringify(block, null, 2),
    '',
    '# Claude Code, one-liner:',
    `claude mcp add terminal -- node "${ENTRY}"`,
    '',
    '# VS Code (.vscode/mcp.json):',
    JSON.stringify(
      { servers: { terminal: { type: 'stdio', command: 'node', args: [ENTRY] } } },
      null,
      2,
    ),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function printHttpConfigSnippet(cfg) {
  const { host, port, path, ssePath } = cfg.http;
  // 0.0.0.0 is a bind address, not something a client can dial.
  const dialHost = host === '0.0.0.0' || host === '::' ? '<this-machine-ip>' : host;
  const base = `http://${dialHost}:${port}`;

  const lines = [
    `# Start the server first:  node "${ENTRY}" --http --host ${host} --port ${port}`,
    '',
    '# Claude Code, one-liner:',
    `claude mcp add --transport http terminal ${base}${path}`,
    '',
    '# Claude Desktop / Cursor (.mcp.json, claude_desktop_config.json):',
    JSON.stringify(
      { mcpServers: { terminal: { type: 'http', url: `${base}${path}` } } },
      null,
      2,
    ),
    '',
    '# VS Code (.vscode/mcp.json):',
    JSON.stringify(
      { servers: { terminal: { type: 'http', url: `${base}${path}` } } },
      null,
      2,
    ),
    '',
    '# Older clients that only speak the 2024-11-05 HTTP+SSE transport:',
    JSON.stringify(
      { mcpServers: { terminal: { type: 'sse', url: `${base}${ssePath}` } } },
      null,
      2,
    ),
    '',
    `# Health check:  curl ${base}/health`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** Whether the browser tool will find something to drive, without launching it. */
function describeBrowser(cfg) {
  try {
    const b = findBrowser(cfg.browser.executable);
    return `${b.path} (${b.kind}, found via ${b.source})${cfg.browser.headless ? ', headless' : ', windowed'}`;
  } catch {
    return 'no Chromium-family browser found — `browser attach` can still drive one started with --remote-debugging-port';
  }
}

/** Whether the screen tool has a desktop and a capture back end. */
function describeScreen() {
  const session = sessionType();
  if (!session) return 'no graphical session (DISPLAY/WAYLAND_DISPLAY unset) — desktop capture unavailable, browser screenshots still work';
  if (session === 'windows') return 'windows — PowerShell + System.Drawing';
  if (session === 'quartz') return 'macOS — screencapture (needs Screen Recording permission)';
  const found = LINUX_CAPTURERS.filter((c) => onPathSync(c.name)).map((c) => c.name);
  return found.length
    ? `${session} — ${found.join(', ')}`
    : `${session} — no capture tool installed (try: apt install ${session === 'wayland' ? 'grim' : 'maim'})`;
}

function onPathSync(name) {
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const dir of (process.env.PATH || '').split(sep).filter(Boolean)) {
    if (existsSync(join(dir, name))) return true;
  }
  return false;
}

function doctor(cfg, plugins = { groups: {}, loaded: [], errors: [] }) {
  const toolset = buildToolset(cfg.tools, { cfg, jobs: { list: () => [] } }, plugins.groups);
  const shell = (() => {
    try {
      return resolveShell(cfg.shell, cfg.shells);
    } catch (err) {
      return { name: 'ERROR', command: err.message, mode: '-' };
    }
  })();
  const out = [
    `${SERVER_NAME} v${SERVER_VERSION}`,
    `node        ${process.version}`,
    `platform    ${process.platform}/${process.arch}`,
    `entry       ${ENTRY}`,
    `cwd         ${cfg.cwd}`,
    `config      ${cfg.configPath || '(none, using defaults)'}`,
    `shell spec  ${cfg.shell}`,
    `resolved    ${shell.name} -> ${shell.command} (mode=${shell.mode})`,
    `shells here ${detectAvailable().map((s) => `${s.name}=${s.command}`).join('\n            ') || '(none detected!)'}`,
    `timeout     ${cfg.timeoutMs}ms`,
    `max output  ${cfg.maxOutputBytes} bytes`,
    `max jobs    ${cfg.maxJobs}`,
    `read-only   ${cfg.readOnly}`,
    `allowedRoots ${cfg.allowedRoots.length ? cfg.allowedRoots.join(', ') : '(unrestricted)'}`,
    `denyCommands ${cfg.denyCommands.length || 0} pattern(s)`,
    `vars store  ${cfg.varsFile ? `mirrored to ${cfg.varsFile}` : 'memory only'}, max ${cfg.maxVars} x ${cfg.maxVarBytes}B`,
    `browser     ${describeBrowser(cfg)}`,
    `screen      ${describeScreen()}`,
    `images      scaled to <=${cfg.screenshots.maxWidth}px wide, saved under ${cfg.screenshots.dir || '<cwd>/.terminalmcp/shots'}`,
    `profile     ${cfg.tools} -> ${toolset.groups.join(', ')}`,
    `tools       ${toolset.tools.length} tools, ~${toolset.estimatedTokens} tokens of schema per request`,
    ...describeGroups(toolset.groups, plugins.groups).map(
      (g) =>
        `  ${g.active ? '[x]' : '[ ]'} ${g.name.padEnd(9)} ~${String(g.estimatedTokens).padStart(5)} tok  ` +
        `${g.plugin ? 'plugin: ' : ''}${g.toolNames.join(', ')}`,
    ),
    `plugins     ${parsePluginList(cfg.plugins).length ? '' : 'none enabled'}`,
    ...describePlugins(plugins),
    `transport   ${
      cfg.http.enabled
        ? `http on ${cfg.http.host}:${cfg.http.port}${cfg.http.path} (no auth)`
        : 'stdio'
    }`,
  ];
  process.stdout.write(`${out.join('\n')}\n`);
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    process.stdout.write(`\nWARNING: node ${process.version} is too old; TerminalMCP needs >= 18.\n`);
    process.exitCode = 1;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) { process.stdout.write(HELP); return; }
  if (args.version || args.v) { process.stdout.write(`${SERVER_VERSION}\n`); return; }

  if (typeof args.config === 'string') process.env.TERMINALMCP_CONFIG = args.config;

  let cfg;
  try {
    cfg = loadConfig({ overrides: overridesFrom(args) });
  } catch (err) {
    process.stderr.write(`Config error: ${err.message}\n`);
    process.exit(2);
  }

  if (args.print_config) { printConfigSnippet(cfg); return; }

  // Plugins are loaded before anything reports on the toolset, so --doctor and
  // --list-tools describe what the server will actually expose.
  const plugins = await loadPlugins(cfg);
  for (const e of plugins.errors) process.stderr.write(`[terminalmcp] plugin ${e.name}: ${e.message}\n`);

  if (args.doctor) { doctor(cfg, plugins); return; }
  if (args.list_tools) {
    const set = buildToolset(cfg.tools, { cfg, jobs: { list: () => [] } }, plugins.groups);
    const lines = [
      `profile "${cfg.tools}" -> ${set.tools.length} tools, ~${set.estimatedTokens} tokens of schema`,
      '',
      `groups (bundles: ${Object.keys(ALIASES).join(', ')})`,
      ...describeGroups(set.groups, plugins.groups).map(
        (g) =>
          `  ${g.active ? '[x]' : '[ ]'} ${g.name.padEnd(9)} ~${String(g.estimatedTokens).padStart(5)} tok  ` +
          `${g.plugin ? 'plugin: ' : ''}${g.label}`,
      ),
      '',
      ...set.tools.map((t) => `${t.name}\n  ${t.description}`),
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  const server = new Server(cfg, plugins);
  log(
    `v${SERVER_VERSION} ready — shell=${cfg.shell} cwd=${cfg.cwd} ` +
    `tools=${server.tools.length} (${server.toolGroups.join(',')}, ~${server.toolTokens} tok)` +
    `${plugins.loaded.length ? ` plugins=${plugins.loaded.map((p) => p.name).join(',')}` : ''}` +
    `${cfg.readOnly ? ' [READ-ONLY]' : ''}`,
  );

  if (cfg.http.enabled) serveHttp(server, cfg.http);
  else serveStdio(server);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
