// Tool registry and profiles.
//
// Every tool definition sits in the model's context on EVERY request, so the
// full set is not always the right set. Groups can be switched on and off with
// --tools / config.tools, and `shell_info` reports what the current profile
// costs so the trade-off is visible rather than guessed at.

import { CORE_TOOLS, createCoreHandlers } from './core.js';
import * as search from './search.js';
import * as git from './git.js';
import * as fsops from './fsops.js';
import * as archive from './archive.js';
import * as sys from './sys.js';
import * as net from './net.js';
import * as dev from './dev.js';
import * as data from './data.js';
import * as watch from './watch.js';
import * as browser from './browser.js';
import * as screen from './screen.js';
import * as input from './input.js';
import * as varsTool from './vars.js';

/** Group modules export TOOLS + createHandlers; normalise that shape here. */
function group(label, mod) {
  if (!Array.isArray(mod.TOOLS)) throw new Error(`Tool group "${label}" does not export TOOLS`);
  if (typeof mod.createHandlers !== 'function') {
    throw new Error(`Tool group "${label}" does not export createHandlers`);
  }
  return { label, tools: mod.TOOLS, createHandlers: mod.createHandlers };
}

/** Group order here is the order tools appear in tools/list. */
export const GROUPS = {
  core: {
    label: 'shell, jobs, bulk, file read/write/edit',
    tools: CORE_TOOLS,
    createHandlers: createCoreHandlers,
    always: true,
  },
  // Always on: ${vars.…} expansion is always active, so being unable to set
  // a variable would be a confusing half-feature.
  vars: { ...group('server-side variables reusable across calls', varsTool), always: true },
  search: group('grep a tree, find files, project-wide replace', search),
  git: group('git status/log/diff/branch/commit and raw passthrough', git),
  fs: group('copy, move, delete, stat, hash, chmod, tree, disk usage', fsops),
  archive: group('zip / tar / gzip create, list and extract', archive),
  sys: group('machine facts and process control', sys),
  net: group('HTTP client, DNS, port checks, interfaces', net),
  dev: group('package managers, project detection, code outline', dev),
  data: group('JSON query/patch, diff/patch, encode/hash', data),
  watch: group('watch paths for changes', watch),
  browser: group('drive a real browser: navigate, read, click, screenshot', browser),
  screen: group('screenshot the desktop, a window or a region; view images', screen),
  input: group('move the mouse, click, drag, type, press keys', input),
};

export const GROUP_NAMES = Object.keys(GROUPS);

/** Named bundles, so nobody has to remember the group list. */
export const ALIASES = {
  all: GROUP_NAMES,
  minimal: ['core'],
  // What a coding agent reaches for constantly.
  dev: ['core', 'search', 'git', 'dev', 'data', 'fs'],
  // Driving a machine rather than writing code.
  ops: ['core', 'search', 'fs', 'sys', 'net', 'archive'],
  // Looking at things: a web app under test, or whatever is on screen.
  web: ['core', 'browser', 'screen', 'net', 'search', 'fs'],
  // Driving a GUI that has no other way in: see it, then act on it.
  desktop: ['core', 'screen', 'input', 'fs', 'search'],
};

export const DEFAULT_PROFILE = 'all';

/**
 * Resolve a profile spec into a group list.
 *
 * Accepts a comma/space separated list of group names and aliases, with
 * `-name` removing one:  "all", "dev", "core,git,sys", "all,-watch,-archive".
 * `core` is always present — without it there is no server.
 *
 * `groupMap` may carry plugin groups alongside the built-in ones. A plugin is
 * enabled by having been loaded at all (naming it in `plugins` is the request
 * to use it), so it is never part of `all` but is on unless explicitly
 * removed with `-name`.
 */
export function resolveGroups(spec, groupMap = GROUPS) {
  const names = Object.keys(groupMap);
  const builtin = names.filter((n) => !groupMap[n].plugin);
  const pluginNames = names.filter((n) => groupMap[n].plugin);
  const aliases = { ...ALIASES, all: builtin };

  const raw = spec === undefined || spec === null || spec === '' ? DEFAULT_PROFILE : spec;
  const tokens = (Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/))
    .map((t) => String(t).trim())
    .filter(Boolean);

  const selected = new Set();
  const removed = new Set();
  const unknown = [];

  for (const token of tokens) {
    const negate = token.startsWith('-') || token.startsWith('!');
    const name = (negate ? token.slice(1) : token).toLowerCase();

    const expand = aliases[name] ?? (groupMap[name] ? [name] : null);
    if (!expand) { unknown.push(name); continue; }
    for (const g of expand) {
      if (negate) removed.add(g);
      else selected.add(g);
    }
  }

  if (unknown.length) {
    throw new Error(
      `Unknown tool group(s): ${unknown.join(', ')}. ` +
      `Groups: ${builtin.join(', ')}. Bundles: ${Object.keys(aliases).join(', ')}.` +
      `${pluginNames.length ? ` Plugins loaded: ${pluginNames.join(', ')}.` : ''}`,
    );
  }

  // A spec of only removals means "everything except these".
  if (!selected.size && removed.size) for (const g of builtin) selected.add(g);

  for (const g of pluginNames) selected.add(g);
  for (const g of removed) selected.delete(g);

  // Order matters more than it looks. Some MCP clients cap how much tool
  // schema they will accept and silently drop whatever is past the cap — so
  // the tail of this list is the part most likely to go missing. A spec that
  // names groups explicitly therefore keeps the caller's order, which is the
  // only lever they have over what survives. `all` and the bundles still come
  // out in registry order, so nothing changes for the default.
  const always = names.filter((g) => groupMap[g].always);
  for (const g of always) selected.delete(g);
  const rest = [...selected];
  return [...always, ...rest];
}

/**
 * Build the active toolset.
 * Returns { groups, tools, handlers, bytes, estimatedTokens }.
 */
export function buildToolset(spec, ctx, pluginGroups = {}) {
  const groupMap = { ...GROUPS, ...pluginGroups };
  const groups = resolveGroups(spec, groupMap);
  const tools = [];
  let handlers = {};

  for (const name of groups) {
    const group = groupMap[name];
    tools.push(...group.tools);
    if (group.createHandlers) handlers = { ...handlers, ...group.createHandlers(ctx) };
  }

  const bytes = JSON.stringify({ tools }).length;
  return {
    groups,
    tools,
    handlers,
    bytes,
    // Rough but consistent: JSON schema text runs ~3.6 bytes per token.
    estimatedTokens: Math.round(bytes / 3.6),
  };
}

/** One line per group, for --list-tools and shell_info. */
export function describeGroups(activeGroups = [], pluginGroups = {}) {
  const groupMap = { ...GROUPS, ...pluginGroups };
  const active = new Set(activeGroups);
  return Object.keys(groupMap).map((name) => {
    const g = groupMap[name];
    const bytes = JSON.stringify({ tools: g.tools }).length;
    return {
      name,
      label: g.label,
      active: active.has(name),
      always: Boolean(g.always),
      plugin: Boolean(g.plugin),
      toolNames: g.tools.map((t) => t.name),
      estimatedTokens: Math.round(bytes / 3.6),
    };
  });
}
