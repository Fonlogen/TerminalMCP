// Sequential runner over ANY tool — shell_bulk's and input_bulk's big sibling.
//
// shell_bulk batches commands and input_bulk batches clicks, but real work
// mixes them: read a file, patch it, run the tests, check git, take a
// screenshot. As single calls that is a round-trip each, every one paying for
// the whole context again. Here the model plans the run once and gets back one
// report, with the same delays / when / retry / on_failure / assign it already
// knows from shell_bulk.
//
// Each step goes through the same handler a direct call would, so a file_edit
// in a run is exactly a file_edit on its own — same guards, same policy.

import process from 'node:process';
import { PolicyError } from './guards.js';
import { compile, evaluate } from './expr.js';
import { whenToExpr } from './bulk.js';
import { applyInterpolation } from './tools/interpolate.js';
import { truncateMiddle, ms } from './format.js';

export const SELF = 'tool_bulk';
const CAPTURES = ['full', 'on_failure', 'none'];

const sleep = (n) => (n > 0 ? new Promise((r) => setTimeout(r, Math.min(n, 600000))) : Promise.resolve());

/**
 * A step may be a bare tool name ("shell_info", "git_status") when the tool
 * needs no arguments; otherwise { tool, args, ...runner fields }.
 */
function normalise(raw, i, known) {
  const spec = typeof raw === 'string' ? { tool: raw.trim() } : raw;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`steps[${i}] must be an object {tool, args} or a tool name`);
  }
  if (typeof spec.tool !== 'string' || !spec.tool) throw new Error(`steps[${i}] needs "tool"`);
  if (spec.tool === SELF) throw new Error(`steps[${i}] ${SELF} cannot call itself`);
  if (!known(spec.tool)) {
    throw new Error(`steps[${i}] tool "${spec.tool}" is not enabled on this server`);
  }
  if (spec.args !== undefined && (spec.args === null || typeof spec.args !== 'object' || Array.isArray(spec.args))) {
    throw new Error(`steps[${i}] (${spec.tool}) "args" must be an object`);
  }
  if (spec.capture !== undefined && !CAPTURES.includes(spec.capture)) {
    throw new Error(`steps[${i}] capture must be one of ${CAPTURES.join(', ')}`);
  }
  return spec;
}

/** shell_exec reports failure as text, not as a throw: read its exit line. */
function exitOf(tool, text) {
  if (tool !== 'shell_exec') return null;
  const m = /(?:^|\s)exit=(-?\d+|killed)\b/.exec(String(text).split('\n')[0]);
  if (!m) return null;
  return m[1] === 'killed' ? 'killed' : Number(m[1]);
}

/**
 * Run `params.steps` through `call(tool, args)`, which returns what a handler
 * returns (a string or { text, images }) or throws.
 */
export async function runToolBulk(cfg, params, { call, known, store = null }) {
  const {
    steps,
    delay_ms: gap = 0,
    stop_on_failure = true,
    capture: baseCapture = 'full',
    max_output_bytes: baseMaxBytes,
    max_total_bytes = 40000,
    max_images = 4,
    vars: initialVars = {},
  } = params;

  if (!Array.isArray(steps) || steps.length === 0) throw new Error('steps must be a non-empty array');
  const specs = steps.map((s, i) => normalise(s, i, known));
  // A bad condition is a typo in the plan: say so before anything runs.
  specs.forEach((s, i) => {
    for (const key of ['when', 'ok_if']) {
      const expr = key === 'when' ? whenToExpr(s.when) : s.ok_if;
      if (!expr) continue;
      try {
        compile(expr);
      } catch (err) {
        throw new Error(`steps[${i}] (${s.id || `s${i + 1}`}) bad "${key}": ${err.message}`);
      }
    }
  });

  const results = [];
  const byId = {};
  // Read live, not snapshotted once: a vars step or a shell_exec assign in
  // this run writes to the store, and the steps after it should see that.
  const assigned = {};
  const liveVars = () => ({ ...(store ? store.snapshot() : {}), ...initialVars, ...assigned });
  const unresolved = [];
  const storeErrors = [];
  const images = [];
  const dropped = [];
  const imageCap = Math.max(0, Number(max_images) || 0);
  let okCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let aborted = false;
  let abortReason = null;
  let budgetLeft = num(max_total_bytes, 40000);
  const startedAt = Date.now();

  const ctx = () => ({
    prev: results.length ? results[results.length - 1] : { ok: true, skipped: false, output: '', exit: null },
    steps: results,
    step: byId,
    vars: liveVars(),
    env: process.env,
    platform: process.platform,
    failed_count: failedCount,
    ok_count: okCount,
    skipped_count: skippedCount,
    index: results.length,
  });

  let executed = 0;
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const id = spec.id || `s${i + 1}`;
    const tool = spec.tool;

    const whenExpr = whenToExpr(spec.when);
    if (whenExpr) {
      let pass;
      try {
        pass = evaluate(whenExpr, ctx());
      } catch (err) {
        throw new Error(`steps[${i}] (${id}) bad "when" condition: ${err.message}`);
      }
      if (!pass) {
        const r = { index: i, id, tool, skipped: true, reason: `when: ${whenExpr}`, ok: true, output: '', exit: null, ms: 0 };
        results.push(r);
        byId[id] = r;
        skippedCount++;
        continue;
      }
    }

    if (executed > 0) await sleep(num(gap, 0));
    await sleep(num(spec.delay_before_ms ?? spec.delay_ms, 0));
    executed++;

    // Same fields a direct call would expand, but against this run's context,
    // so a step can use prev.output or step.<id>.output as well as vars.
    const expanded = applyInterpolation(tool, spec.args ?? {}, ctx());
    let args = expanded.args;
    for (const u of expanded.unresolved) if (!unresolved.includes(u)) unresolved.push(u);
    // shell_exec already knows how to keep just its stdout; the rendered
    // report (exit line, stream headers) is not a value anyone wants stored.
    const delegated = Boolean(spec.assign) && tool === 'shell_exec' && store && args.assign === undefined;
    if (delegated) args = { ...args, assign: spec.assign };

    const retry = spec.retry || {};
    const maxAttempts = Math.max(1, num(retry.count, 0) + 1);
    let attempt = 0;
    let text = '';
    let stepImages = [];
    let error = null;
    let refused = false;
    let exit = null;
    let ok = false;
    const t0 = Date.now();

    while (attempt < maxAttempts) {
      attempt++;
      error = null;
      refused = false;
      try {
        const out = await call(tool, args);
        const rich = out && typeof out === 'object' && !Array.isArray(out);
        text = rich ? String(out.text ?? '') : String(out ?? '');
        stepImages = rich && Array.isArray(out.images) ? out.images.filter((m) => m?.type === 'image' && m.data) : [];
        exit = exitOf(tool, text);
        if (spec.ok_if) {
          ok = evaluate(spec.ok_if, { ...ctx(), output: text, exit });
        } else {
          ok = exit === null || exit === 0;
        }
        if (!ok) error = spec.ok_if ? `ok_if was false: ${spec.ok_if}` : `exit=${exit}`;
      } catch (err) {
        refused = err instanceof PolicyError || err.name === 'PolicyError';
        error = refused ? `Policy: ${err.message}` : err.message;
        text = '';
        stepImages = [];
        ok = false;
      }
      if (ok || refused || attempt >= maxAttempts) break;
      await sleep(num(retry.delay_ms, 500));
    }

    // Kept whole for later steps to read; only the report is capped.
    const r = {
      index: i, id, tool, skipped: false, ok, refused, output: text, exit, error,
      ms: Date.now() - t0, attempts: attempt, assigned: null, shown: '', suppressed: null,
    };

    const capture = spec.capture ?? baseCapture;
    const perStep = num(spec.max_output_bytes ?? baseMaxBytes, Math.min(cfg.maxOutputBytes, 6000));
    if (capture === 'none' || (capture === 'on_failure' && ok)) {
      r.suppressed = `capture=${capture}`;
    } else if (budgetLeft <= 0) {
      r.suppressed = 'max_total_bytes budget exhausted';
    } else {
      r.shown = truncateMiddle(text, Math.min(perStep, budgetLeft)).text;
      budgetLeft -= Buffer.byteLength(r.shown, 'utf8');
    }

    if (ok) {
      for (const img of capture === 'none' ? [] : stepImages) {
        images.push({ label: `[${i + 1}] ${id}`, img });
        while (images.length > imageCap) dropped.push(images.shift().label);
      }
    }

    if (spec.assign && ok) {
      r.assigned = spec.assign;
      if (delegated) {
        const v = store.get(spec.assign);
        if (v === undefined) storeErrors.push(`${spec.assign}: ${oneLine(text.split('\n').find((l) => /not stored/.test(l)) ?? 'not stored', 160)}`);
        else assigned[spec.assign] = v;
      } else {
        const value = text.trim();
        assigned[spec.assign] = value;
        if (store) {
          try { store.set(spec.assign, value); } catch (err) { storeErrors.push(`${spec.assign}: ${err.message}`); }
        }
      }
    }

    results.push(r);
    byId[id] = r;
    if (ok) okCount++; else failedCount++;

    await sleep(num(spec.delay_after_ms, 0));

    if (!ok) {
      const policy = refused ? 'stop' : spec.on_failure ?? (stop_on_failure ? 'stop' : 'continue');
      if (policy === 'stop' || policy === 'abort') {
        aborted = true;
        abortReason = `step ${id} (${tool}) failed: ${oneLine(String(error).split('\n')[0], 160)}`;
        break;
      }
    }
  }

  return {
    results,
    vars: liveVars(),
    images: images.map((x) => x.img),
    imageLabels: images.map((x) => x.label),
    dropped,
    unresolved,
    storeErrors,
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

function indent(s) {
  return s.split('\n').map((l) => `    ${l}`).join('\n');
}

/** Compact report, in the same shape as shell_bulk's. */
export function renderToolBulk(out) {
  const { stats, results, aborted, abortReason } = out;
  const lines = [
    `TOOL_BULK ${stats.total} steps: ${stats.ok} ok, ${stats.failed} failed, ${stats.skipped} skipped` +
    (stats.notReached ? `, ${stats.notReached} not reached` : '') +
    ` (${ms(stats.durationMs)})` +
    (aborted ? ` ABORTED: ${abortReason}` : ''),
  ];

  for (const r of results) {
    if (r.skipped) {
      lines.push(`[${r.index + 1}] ${r.id} ${r.tool} SKIPPED (${r.reason})`);
      continue;
    }
    const flags = [
      r.ok ? 'ok' : r.refused ? 'REFUSED' : 'FAIL',
      ms(r.ms),
      r.attempts > 1 ? `attempts=${r.attempts}` : null,
    ].filter(Boolean).join(' ');
    lines.push(`[${r.index + 1}] ${r.id} ${r.tool} ${flags}`);
    // A throw has no output, only the error; a failed ok_if/exit has both.
    if (!r.ok && (r.refused || !r.output)) lines.push(`    error: ${r.error}`);
    if (r.shown) lines.push(indent(r.shown));
    else if (r.suppressed && !r.ok) lines.push(`    (output suppressed: ${r.suppressed})`);
  }

  const assigned = results.map((r) => r.assigned).filter(Boolean);
  if (assigned.length) {
    lines.push(`vars: ${assigned.map((k) => `${k}=${oneLine(String(out.vars[k]), 120)}`).join(' ')}`);
  }
  if (out.imageLabels.length) lines.push(`images attached, in order: ${out.imageLabels.join(', ')}`);
  if (out.dropped.length) {
    lines.push(`not attached (max_images reached, older ones dropped first): ${out.dropped.join(', ')}`);
  }
  if (out.unresolved.length) {
    lines.push(`note: ${out.unresolved.map((u) => `\${${u}}`).join(', ')} did not resolve and was passed through literally.`);
  }
  if (out.storeErrors.length) lines.push(`not stored: ${out.storeErrors.join('; ')}`);
  return lines.join('\n');
}
