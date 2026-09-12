// Where ${...} is expanded, declared in one place.
//
// Interpolation is applied in the dispatch layer rather than inside 25
// handlers, so the list of fields that can contain a variable reference is
// auditable at a glance — and so nothing expands by accident.
//
// Deliberately absent: file content, regex patterns and patch bodies. A JS
// template literal, a GitHub Actions workflow and a regex all legitimately
// contain `${...}`, and silently rewriting them would be worse than making
// the caller ask. file_write takes `interpolate: true` when it really wants it.

import process from 'node:process';
import { interpolate } from '../expr.js';

/**
 * Field specs, per tool:
 *   'name'        a string field
 *   'name.*'      every string value of an object field
 *   'name[]'      every string of an array field
 */
export const INTERPOLATE_FIELDS = {
  shell_exec: ['command', 'cwd', 'stdin', 'env.*'],
  shell_exec_async: ['command', 'cwd', 'env.*'],
  // shell_bulk is missing on purpose: it interpolates per step, as it runs, so
  // that a step can use what the step before it produced.
  file_read: ['path'],
  file_write: ['path'],
  file_edit: ['path'],
  fs_list: ['path'],

  search_text: ['path'],
  search_files: ['path'],

  git: ['cwd', 'message', 'ref', 'paths[]', 'remote', 'key'],

  fs_op: ['path', 'to'],
  archive: ['path', 'from', 'to', 'files[]'],

  pkg: ['cwd', 'script', 'packages[]', 'args[]'],
  project_info: ['cwd'],
  code: ['path'],

  // "content" here is inline JSON the caller passes explicitly, so expanding
  // it is how a captured response body feeds straight into a query.
  json_tool: ['path', 'json_path', 'content'],
  diff: ['path', 'to'],
  encode: ['text', 'path'],

  http_request: ['url', 'body', 'headers.*', 'query.*', 'form.*'],
  net: ['host'],

  watch: ['path'],
  vars: ['value'],

  // `expression` is absent on purpose: page JavaScript legitimately contains
  // ${...} in template literals, and rewriting someone's code before running
  // it in their browser would be the worst possible place to be clever.
  browser: ['url', 'selector', 'text', 'value', 'label', 'path'],
  screen: ['path', 'window'],
};

/** Context every ${...} is resolved against. */
export function varContext(store) {
  return {
    vars: store ? store.snapshot() : {},
    env: process.env,
    platform: process.platform,
  };
}

function expand(value, ctx, unresolved) {
  if (typeof value !== 'string' || !value.includes('${')) return value;
  return interpolate(value, ctx, { unresolved });
}

/**
 * Expand the declared fields of `args` in place on a shallow copy.
 * Returns { args, unresolved } — `unresolved` names references that parsed as
 * ours but matched nothing, which is almost always a typo worth reporting.
 */
export function applyInterpolation(toolName, args, ctx) {
  const spec = INTERPOLATE_FIELDS[toolName];
  if (!spec || !args || typeof args !== 'object') return { args, unresolved: [] };

  const unresolved = [];
  let out = args;
  const copy = () => {
    if (out === args) out = { ...args };
    return out;
  };

  for (const field of spec) {
    if (field.endsWith('.*')) {
      const key = field.slice(0, -2);
      const obj = args[key];
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
      let changed = false;
      const next = {};
      for (const [k, v] of Object.entries(obj)) {
        const e = expand(v, ctx, unresolved);
        if (e !== v) changed = true;
        next[k] = e;
      }
      if (changed) copy()[key] = next;
      continue;
    }

    if (field.endsWith('[]')) {
      const key = field.slice(0, -2);
      const arr = args[key];
      if (!Array.isArray(arr)) continue;
      let changed = false;
      const next = arr.map((v) => {
        const e = expand(v, ctx, unresolved);
        if (e !== v) changed = true;
        return e;
      });
      if (changed) copy()[key] = next;
      continue;
    }

    const v = args[field];
    const e = expand(v, ctx, unresolved);
    if (e !== v) copy()[field] = e;
  }

  return { args: out, unresolved };
}

/** One-line note appended to a result when a reference went unresolved. */
export function unresolvedNote(unresolved, store) {
  if (!unresolved.length) return null;
  const known = store ? Object.keys(store.snapshot()) : [];
  return (
    `note: ${unresolved.map((u) => `\${${u}}`).join(', ')} did not resolve and was passed through ` +
    `literally. ${known.length ? `Defined variables: ${known.slice(0, 25).join(', ')}` : 'No variables are set.'}`
  );
}
