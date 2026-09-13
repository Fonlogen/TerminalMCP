// Optional plugins: integrations that are not part of the default toolset.
//
// Three things separate a plugin from a tool group:
//
//   1. It is never in `all`. Tool schemas cost tokens on every request, and
//      nobody should pay for a Telegram integration they do not use. A plugin
//      exists only when it is named in `plugins`.
//   2. It needs credentials. So a plugin declares where its secrets come from,
//      and everything it returns is scrubbed of them — which matters more than
//      it sounds, because Telegram puts the bot token in the URL, and a naive
//      error message would print it.
//   3. It talks to the outside world. Sending a message or restarting a game
//      server is not something to do by accident, so each plugin declares
//      which of its actions mutate, and `readOnly` refuses those centrally
//      rather than in thirty handlers.
//
// A plugin is an ES module exporting the same shape a tool group does —
// TOOLS + createHandlers — plus a little metadata. Which means a third-party
// plugin is just a path in the config file; there is no API to learn beyond
// what src/tools/*.js already does.

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import { PolicyError } from './guards.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Plugins that ship with the server. */
export const BUILTIN_PLUGINS = ['fivem', 'discord', 'telegram'];

/**
 * Read a config value that may name an environment variable instead of
 * holding a secret directly.
 *
 * `"env:DISCORD_BOT_TOKEN"` keeps the token out of a file that people commit
 * by accident. Returns null when the variable is unset, so "not configured"
 * is a state the tool can report rather than a confusing 401 later.
 */
export function resolveSecret(value, env = process.env) {
  if (typeof value !== 'string') return value ?? null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('env:')) {
    const name = trimmed.slice(4).trim();
    const found = env[name];
    return found && found.trim() ? found.trim() : null;
  }
  return trimmed;
}

/**
 * Strings that must never reach the model or the audit log.
 *
 * Substring replacement rather than pattern matching: we know the exact
 * secrets, so there is no reason to guess at their shape, and no way for a
 * token to slip through in a form we did not anticipate.
 */
export class Redactor {
  constructor(values = []) {
    this.values = new Set();
    for (const v of values) this.add(v);
  }

  add(value) {
    // Short strings would redact half the output; a real token is long.
    if (typeof value === 'string' && value.length >= 8) this.values.add(value);
    return value;
  }

  scrub(text) {
    if (!text) return text;
    let out = String(text);
    for (const secret of this.values) {
      if (out.includes(secret)) out = out.split(secret).join('<redacted>');
    }
    return out;
  }

  get size() {
    return this.values.size;
  }
}

function modulePathFor(spec) {
  // A path (anything with a separator or a .js suffix) loads a third-party
  // plugin; a bare name loads one that ships here.
  if (/[\\/]/.test(spec) || spec.endsWith('.js')) {
    const abs = isAbsolute(spec) ? spec : resolve(process.cwd(), spec);
    return { path: abs, builtin: false };
  }
  return { path: join(ROOT, 'plugins', spec, 'plugin.js'), builtin: true };
}

/** Normalise `plugins` from a config file, an env var or the CLI. */
export function parsePluginList(spec) {
  if (!spec) return [];
  const list = Array.isArray(spec) ? spec : String(spec).split(/[,\s]+/);
  return list.map((s) => String(s).trim()).filter(Boolean);
}

/**
 * Wrap a plugin's handlers so that policy and redaction apply to every
 * action, including ones added later, without each plugin remembering to.
 */
function protect(name, handlers, { cfg, redactor, mutating }) {
  const wrapped = {};
  for (const [toolName, fn] of Object.entries(handlers)) {
    wrapped[toolName] = async (args) => {
      const action = args?.action;
      if (cfg.readOnly && action && mutating.has(action)) {
        throw new PolicyError(
          `readOnly is on, so ${toolName} "${action}" is refused — it changes something outside this machine. ` +
          `Read-only actions of this plugin still work.`,
        );
      }
      try {
        const out = await fn(args);
        if (typeof out === 'string') return redactor.scrub(out);
        if (out && typeof out === 'object' && typeof out.text === 'string') {
          return { ...out, text: redactor.scrub(out.text) };
        }
        return out;
      } catch (err) {
        // The message is rewritten rather than wrapped: a Telegram URL carries
        // the bot token, and an unscrubbed error would publish it to the
        // transcript and the audit log.
        const scrubbed = redactor.scrub(err.message);
        if (scrubbed !== err.message) {
          const replacement = err instanceof PolicyError ? new PolicyError(scrubbed) : new Error(scrubbed);
          replacement.stack = err.stack;
          throw replacement;
        }
        throw err;
      }
    };
  }
  return wrapped;
}

/**
 * Load the named plugins.
 *
 * Returns { groups, loaded, errors }. A plugin that fails to load is reported
 * rather than thrown: one broken integration must not stop the server, since
 * everything else on the machine still works.
 */
export async function loadPlugins(cfg) {
  const names = parsePluginList(cfg.plugins);
  const groups = {};
  const loaded = [];
  const errors = [];

  for (const spec of names) {
    const { path, builtin } = modulePathFor(spec);
    const name = builtin ? spec : spec.replace(/.*[\\/]/, '').replace(/\.js$/, '');

    if (groups[name]) {
      errors.push({ name, message: `loaded twice; the second "${spec}" was ignored` });
      continue;
    }
    if (!existsSync(path)) {
      errors.push({
        name,
        message: builtin
          ? `unknown plugin "${spec}". Built in: ${BUILTIN_PLUGINS.join(', ')}. ` +
            'For your own, give a path to its .js file.'
          : `no such file: ${path}`,
      });
      continue;
    }

    let mod;
    try {
      mod = await import(pathToFileURL(path).href);
    } catch (err) {
      errors.push({ name, message: `failed to load: ${err.message}` });
      continue;
    }

    if (!Array.isArray(mod.TOOLS) || typeof mod.createHandlers !== 'function') {
      errors.push({ name, message: 'is not a plugin: it must export TOOLS and createHandlers' });
      continue;
    }

    const settings = (cfg.pluginConfig ?? {})[name] ?? {};
    const redactor = new Redactor();
    const mutating = new Set(mod.MUTATING_ACTIONS ?? []);

    let handlers;
    let status;
    try {
      const pluginCtx = { cfg, settings, redactor, secret: (v) => redactor.add(resolveSecret(v)) };
      handlers = mod.createHandlers(pluginCtx);
      status = typeof mod.describe === 'function' ? mod.describe(pluginCtx) : null;
    } catch (err) {
      errors.push({ name, message: `failed to initialise: ${err.message}` });
      continue;
    }

    groups[name] = {
      label: mod.LABEL ?? `${name} integration`,
      tools: mod.TOOLS,
      createHandlers: () => protect(name, handlers, { cfg, redactor, mutating }),
      plugin: true,
      path,
      builtin,
      status,
    };
    loaded.push({ name, path, builtin, label: groups[name].label, status, secrets: redactor.size });
  }

  return { groups, loaded, errors };
}

/**
 * Shared helper for plugin HTTP calls.
 *
 * Every plugin here talks to a JSON API over HTTPS, and all three need the
 * same things: a timeout that actually fires, the response body included in
 * the error (an API's own message is the useful part), and no chance of the
 * URL — which may carry a token — reaching the caller unscrubbed.
 */
/**
 * Dig the useful error code out of a failed fetch.
 *
 * `fetch` reports every network failure as the same "fetch failed", with the
 * real cause underneath — and when a host resolves to several addresses the
 * cause is an AggregateError whose own `.code` is undefined. Losing
 * ECONNREFUSED there is the difference between a message that says the port
 * is wrong and one that says nothing at all.
 */
export function causeCode(err) {
  const seen = new Set();
  let node = err;
  while (node && typeof node === 'object' && !seen.has(node)) {
    seen.add(node);
    if (typeof node.code === 'string') return node.code;
    if (Array.isArray(node.errors)) {
      const found = node.errors.map((e) => causeCode(e)).find(Boolean);
      if (found) return found;
    }
    node = node.cause;
  }
  return null;
}

export async function apiFetch(url, { method = 'GET', headers = {}, body = null, timeoutMs = 20000, redactor = null, label = null, binary = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const shown = label ?? `${method} ${url}`;

  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    const code = causeCode(err);
    // "fetch failed" on its own tells nobody anything. The code is best, but
    // when there is none the cause's own message ("bad port", "unable to
    // verify the first certificate") is what the reader actually needs.
    const detail = code ?? (err.cause?.message && err.cause.message !== err.message ? err.cause.message : null);
    const why =
      err.name === 'AbortError'
        ? `timed out after ${timeoutMs}ms`
        : `${err.message}${detail ? ` (${detail})` : ''}`;
    const msg = `${shown} failed: ${why}`;
    throw new Error(redactor ? redactor.scrub(msg) : msg);
  }
  clearTimeout(timer);

  // A downloaded file must come back as bytes: reading it as text decodes it
  // as UTF-8, and no amount of re-encoding afterwards recovers the original.
  if (binary) {
    const buf = Buffer.from(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
    return { res, status: res.status, ok: res.ok, buffer: buf, raw: '', json: null, headers: res.headers };
  }

  const raw = await res.text().catch(() => '');
  let json = null;
  if (raw && /^\s*[[{]/.test(raw)) {
    try {
      json = JSON.parse(raw);
    } catch {
      /* not JSON after all */
    }
  }
  return { res, status: res.status, ok: res.ok, raw, json, headers: res.headers };
}

/** One line per plugin, for --doctor. */
export function describePlugins({ loaded, errors }) {
  const lines = [];
  for (const p of loaded) {
    lines.push(
      `  ${p.name.padEnd(9)} ${p.status ?? 'loaded'}${p.builtin ? '' : ` [${p.path}]`}`,
    );
  }
  for (const e of errors) lines.push(`  ${e.name.padEnd(9)} ERROR: ${e.message}`);
  if (!lines.length) {
    lines.push(`  (none enabled. Available: ${BUILTIN_PLUGINS.join(', ')} — enable with --plugin <name>)`);
  }
  return lines;
}
