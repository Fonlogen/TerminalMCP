// Sequential mouse/keyboard/screen runner — shell_bulk's twin for the desktop.
//
// A GUI task is rarely one action: raise the window, click the field, type,
// press enter, wait for the dialog, look. As single `input` calls that is five
// or six round-trips, each paying for the whole context again. Here the model
// plans the sequence once, gives it the pauses a UI needs between actions, and
// gets back one report — plus the screenshots it asked for, capped so a long
// run cannot flood the reply with images.
//
// The runner knows nothing about platforms: it is handed `exec(action, args)`
// by the input tool, which already knows how to click on each of them.

import { PolicyError } from './guards.js';
import { evaluate, interpolate } from './expr.js';
import { whenToExpr } from './bulk.js';
import { parseChords } from './input.js';
import { ms } from './format.js';

export const BULK_ACTIONS = ['move', 'click', 'drag', 'scroll', 'type', 'key', 'focus', 'position', 'shot', 'wait'];
const MUTATES = new Set(['move', 'click', 'drag', 'scroll', 'type', 'key', 'focus']);

// Fields that must come out as numbers, even when written as "${step.p.x}".
const NUMERIC = ['x', 'y', 'dx', 'dy', 'to_x', 'to_y', 'width', 'height', 'count', 'amount', 'ms', 'hold_ms', 'interval_ms', 'max_width'];
// Fields that belong to the runner, not to the action.
const RUNNER_KEYS = new Set(['id', 'when', 'delay_before_ms', 'delay_ms', 'delay_after_ms', 'on_failure', 'retry']);

const sleep = (n) => (n > 0 ? new Promise((r) => setTimeout(r, Math.min(n, 600000))) : Promise.resolve());

/**
 * Shorthand for the common steps, so a sequence can be written as strings:
 *   "click 400 300"   "move 10 20"   "scroll -3"   "wait 500"
 *   "key ctrl+s"      "type hello world"           "focus Notepad"
 *   "click"           "shot"          "position"
 */
export function parseStepShorthand(s) {
  const text = String(s).trim();
  const sp = text.search(/\s/);
  const action = (sp === -1 ? text : text.slice(0, sp)).toLowerCase();
  const rest = sp === -1 ? '' : text.slice(sp + 1);
  const nums = () => rest.trim().split(/[\s,]+/).filter(Boolean).map(Number);

  switch (action) {
    case 'type': return { action, text: rest };
    case 'key': return { action, keys: rest.trim() };
    case 'focus': return { action, window: rest.trim() };
    case 'wait': return { action, ms: Number(rest.trim()) };
    case 'scroll': return rest.trim() ? { action, amount: Number(rest.trim()) } : { action };
    case 'click':
    case 'move': {
      const [x, y] = nums();
      if (x === undefined) return { action };
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(`"${text}": ${action} takes two numbers, x and y`);
      }
      return { action, x, y };
    }
    case 'shot':
    case 'position':
      return { action };
    default:
      throw new Error(`"${text}" is not a step. Shorthands: ${BULK_ACTIONS.join(', ')}; or pass an object`);
  }
}

function normalise(raw, i) {
  let spec;
  try {
    spec = typeof raw === 'string' ? parseStepShorthand(raw) : raw;
  } catch (err) {
    throw new Error(`steps[${i}] ${err.message}`);
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`steps[${i}] must be an object or a shorthand string`);
  }
  if (!BULK_ACTIONS.includes(spec.action)) {
    throw new Error(`steps[${i}] has action "${spec.action}". Actions: ${BULK_ACTIONS.join(' | ')}`);
  }
  return spec;
}

/** Catch what can be caught before the first event is sent. */
function preflight(specs) {
  specs.forEach((s, i) => {
    const where = `steps[${i}] (${s.id || `s${i + 1}`})`;
    const literal = (v) => typeof v === 'string' && !v.includes('${');
    if (s.action === 'key') {
      if (!s.keys) throw new Error(`${where} key needs "keys"`);
      if (literal(s.keys)) {
        try { parseChords(s.keys); } catch (err) { throw new Error(`${where} ${err.message}`); }
      }
    }
    if (s.action === 'type' && (s.text === undefined || s.text === null)) throw new Error(`${where} type needs "text"`);
    if (s.action === 'focus' && !s.window) throw new Error(`${where} focus needs "window"`);
    if (s.action === 'wait' && (s.ms === undefined || (typeof s.ms !== 'string' && !Number.isFinite(Number(s.ms))))) {
      throw new Error(`${where} wait needs "ms"`);
    }
    if (s.action === 'drag' && (s.to_x === undefined || s.to_y === undefined)) {
      throw new Error(`${where} drag needs to_x and to_y`);
    }
  });
}

/** Interpolate every string field of a step, then coerce the numeric ones. */
function expandStep(spec, ctx, unresolved) {
  const out = {};
  for (const [k, v] of Object.entries(spec)) {
    if (RUNNER_KEYS.has(k)) continue;
    out[k] = typeof v === 'string' ? interpolate(v, ctx, { unresolved }) : v;
  }
  for (const k of NUMERIC) {
    if (typeof out[k] !== 'string') continue;
    const n = Number(out[k].trim());
    if (out[k].trim() === '' || !Number.isFinite(n)) throw new Error(`"${k}" came out as "${out[k]}", not a number`);
    out[k] = n;
  }
  return out;
}

/**
 * Run `params.steps` through `exec(action, args)`, which returns
 * { text, images?, x?, y? } or throws. Returns the run, ready for renderInputBulk.
 */
export async function runInputBulk(cfg, params, { exec, store = null }) {
  const {
    steps,
    window: baseWindow,
    delay_ms: gap = 100,
    stop_on_failure = true,
    max_shots = 4,
    final_shot = false,
    timeout_ms: baseTimeout,
    vars: initialVars = {},
  } = params;

  if (!Array.isArray(steps) || steps.length === 0) throw new Error('steps must be a non-empty array');
  const specs = steps.map(normalise);

  if (cfg.readOnly) {
    const bad = specs.map((s) => s.action).filter((a) => MUTATES.has(a));
    if (bad.length || baseWindow) {
      throw new PolicyError(
        `readOnly is on, so input_bulk cannot run — ${bad.length ? `it would ${[...new Set(bad)].join(', ')}` : 'it would raise a window'}. ` +
        'Nothing was sent.',
      );
    }
  }
  preflight(specs);

  const results = [];
  const byId = {};
  const vars = { ...(store ? store.snapshot() : {}), ...initialVars };
  const unresolved = [];
  // Newest last. Past the cap the oldest is dropped: in a sequence the later
  // picture is the one that shows where things ended up.
  const images = [];
  const dropped = [];
  let okCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let aborted = false;
  let abortReason = null;
  let focused = null;
  const startedAt = Date.now();
  const shotCap = Math.max(0, Number(max_shots) || 0);

  const keepImages = (label, list) => {
    for (const img of list || []) {
      images.push({ label, img });
      while (images.length > shotCap) dropped.push(images.shift().label);
    }
  };

  const ctx = () => ({
    prev: results.length ? results[results.length - 1] : { ok: true, skipped: false, output: '' },
    steps: results,
    step: byId,
    vars,
    env: process.env,
    platform: process.platform,
    failed_count: failedCount,
    ok_count: okCount,
    skipped_count: skippedCount,
    index: results.length,
  });

  // A run-wide window is raised once, up front: everything after it assumes it
  // has the focus, so failing to get it is a reason not to start.
  if (baseWindow) {
    try {
      const r = await exec('focus', { window: baseWindow, timeout_ms: baseTimeout });
      focused = r.text;
    } catch (err) {
      throw new Error(`could not raise "${baseWindow}", so nothing was sent: ${err.message}`);
    }
  }

  let executed = 0;
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const id = spec.id || `s${i + 1}`;

    const whenExpr = whenToExpr(spec.when);
    if (whenExpr) {
      let pass;
      try {
        pass = evaluate(whenExpr, ctx());
      } catch (err) {
        throw new Error(`steps[${i}] (${id}) bad "when" condition: ${err.message}`);
      }
      if (!pass) {
        const r = { index: i, id, action: spec.action, skipped: true, reason: `when: ${whenExpr}`, ok: true, output: '', ms: 0 };
        results.push(r);
        byId[id] = r;
        skippedCount++;
        continue;
      }
    }

    if (executed > 0) await sleep(num(gap, 0));
    await sleep(num(spec.delay_before_ms ?? spec.delay_ms, 0));
    executed++;

    let args;
    try {
      args = expandStep(spec, ctx(), unresolved);
    } catch (err) {
      throw new Error(`steps[${i}] (${id}) interpolation failed: ${err.message}`);
    }
    if (args.timeout_ms === undefined && baseTimeout !== undefined) args.timeout_ms = baseTimeout;
    // "window" as a shot target means the run's window unless a step names another.
    const wantsWindowShot = args.action === 'shot' ? args.mode === 'window' : args.shot && args.shot_mode === 'window';
    if (wantsWindowShot && !args.window && baseWindow) args.window = baseWindow;

    const retry = spec.retry || {};
    const maxAttempts = Math.max(1, num(retry.count, 0) + 1);
    let attempt = 0;
    let out = null;
    let error = null;
    let refused = false;
    const t0 = Date.now();

    while (attempt < maxAttempts) {
      attempt++;
      try {
        out = args.action === 'wait'
          ? (await sleep(num(args.ms, 0)), { text: `waited ${ms(num(args.ms, 0))}` })
          : await exec(args.action, args);
        error = null;
        break;
      } catch (err) {
        error = err.name === 'PolicyError' ? `Policy: ${err.message}` : err.message;
        refused = err.name === 'PolicyError';
        if (refused || attempt >= maxAttempts) break;
        await sleep(num(retry.delay_ms, 500));
      }
    }

    const ok = !error;
    const r = {
      index: i,
      id,
      action: args.action,
      skipped: false,
      ok,
      refused,
      output: ok ? out.text : '',
      error,
      ms: Date.now() - t0,
      attempts: attempt,
    };
    if (ok && out.x !== undefined) { r.x = out.x; r.y = out.y; }
    results.push(r);
    byId[id] = r;
    if (ok) {
      okCount++;
      keepImages(`[${i + 1}] ${id}`, out.images);
    } else {
      failedCount++;
    }

    await sleep(num(spec.delay_after_ms, 0));

    if (!ok) {
      const policy = refused ? 'stop' : spec.on_failure ?? (stop_on_failure ? 'stop' : 'continue');
      if (policy === 'stop' || policy === 'abort') {
        aborted = true;
        // The step line carries the whole error; the header needs only its gist.
        abortReason = `step ${id} failed: ${oneLine(error.split('\n')[0], 160)}`;
        break;
      }
    }
  }

  // The picture of how it ended — above all of how it broke.
  let final = null;
  if (final_shot === true || final_shot === 'always' || (final_shot === 'on_failure' && failedCount > 0)) {
    try {
      const shot = await exec('shot', {
        action: 'shot',
        mode: params.final_shot_mode === 'window' && baseWindow ? 'window' : 'screen',
        window: baseWindow,
        max_width: params.max_width,
        timeout_ms: baseTimeout,
      });
      // Added last, so the cap drops an earlier picture rather than this one.
      keepImages('final', shot.images);
      final = shot.text;
    } catch (err) {
      final = `final shot failed: ${err.message}`;
    }
  }

  return {
    results,
    images: images.map((x) => x.img),
    imageLabels: images.map((x) => x.label),
    dropped,
    focused,
    final,
    unresolved,
    aborted,
    abortReason,
    stats: {
      total: specs.length,
      ok: okCount,
      failed: failedCount,
      skipped: skippedCount,
      notReached: specs.length - results.length,
      durationMs: Date.now() - startedAt,
    },
  };
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function oneLine(s, max = 200) {
  const flat = String(s).replace(/\s*\n\s*/g, ' ; ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/** Compact report, in the same shape as shell_bulk's. */
export function renderInputBulk(out) {
  const { stats, results, aborted, abortReason } = out;
  const lines = [
    `INPUT_BULK ${stats.total} steps: ${stats.ok} ok, ${stats.failed} failed, ${stats.skipped} skipped` +
    (stats.notReached ? `, ${stats.notReached} not reached` : '') +
    ` (${ms(stats.durationMs)})` +
    (aborted ? ` ABORTED: ${abortReason}` : ''),
  ];
  if (out.focused) lines.push(`first ${out.focused}`);

  for (const r of results) {
    if (r.skipped) {
      lines.push(`[${r.index + 1}] ${r.id} ${r.action} SKIPPED (${r.reason})`);
      continue;
    }
    const flags = [r.ok ? 'ok' : r.refused ? 'REFUSED' : 'FAIL', ms(r.ms), r.attempts > 1 ? `attempts=${r.attempts}` : null]
      .filter(Boolean)
      .join(' ');
    // An input reply is a few short lines; the screenshot notes are the long
    // ones, so they are folded onto the same line.
    const body = r.ok ? oneLine(r.output, 300) : r.error;
    lines.push(`[${r.index + 1}] ${r.id} ${r.action} ${flags} — ${body}`);
  }

  if (out.final) lines.push(`final: ${oneLine(out.final, 300)}`);
  if (out.imageLabels.length) lines.push(`images attached, in order: ${out.imageLabels.join(', ')}`);
  if (out.dropped.length) {
    lines.push(`not attached (max_shots reached, older ones dropped first): ${out.dropped.join(', ')}`);
  }
  if (out.unresolved.length) {
    lines.push(`note: ${out.unresolved.map((u) => `\${${u}}`).join(', ')} did not resolve and was passed through literally.`);
  }
  return lines.join('\n');
}
