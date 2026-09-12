// Sequential multi-command runner with delays, conditions, retries and
// variable capture — so the model can plan a whole pipeline and spend ONE
// MCP round-trip on it instead of one per command.

import { runCommand } from './exec.js';
import { assertCommandAllowed } from './guards.js';
import { evaluate, interpolate } from './expr.js';
import { shapeOutput, ms } from './format.js';

const WHEN_ALIASES = {
  always: 'true',
  never: 'false',
  prev_success: 'prev.ok',
  prev_ok: 'prev.ok',
  prev_failure: '!prev.ok',
  prev_failed: '!prev.ok',
  all_success: 'failed_count == 0',
  any_failure: 'failed_count > 0',
  no_failure: 'failed_count == 0',
};

const sleep = (n) => (n > 0 ? new Promise((r) => setTimeout(r, n)) : Promise.resolve());

function whenToExpr(when) {
  if (when === undefined || when === null || when === '') return null;
  if (typeof when === 'boolean') return when ? 'true' : 'false';
  const key = String(when).trim();
  return WHEN_ALIASES[key] ?? key;
}

function okForStep(exitCode, expect) {
  if (expect === 'any' || expect === '*') return true;
  if (expect === undefined || expect === null) return exitCode === 0;
  if (Array.isArray(expect)) return expect.map(Number).includes(Number(exitCode));
  return Number(exitCode) === Number(expect);
}

/**
 * Run `steps` in order. Returns { results, stats, aborted, abortReason }.
 * Each result is the object visible to later steps as prev / step.<id> /
 * steps[i], so keep its shape stable.
 */
export async function runBulk(cfg, params) {
  const {
    steps,
    cwd: baseCwd,
    shell: baseShell,
    env: baseEnv = {},
    timeout_ms: baseTimeout,
    login: baseLogin,
    stop_on_failure = true,
    capture: baseCapture = 'full',
    max_output_bytes: baseMaxBytes,
    max_total_bytes = 40000,
    vars: initialVars = {},
  } = params;

  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('steps must be a non-empty array');
  }

  const results = [];
  const byId = {};
  const vars = { ...initialVars };
  let failedCount = 0;
  let okCount = 0;
  let skippedCount = 0;
  let aborted = false;
  let abortReason = null;
  let budgetLeft = max_total_bytes;
  const startedAt = Date.now();

  const ctx = () => ({
    prev: results.length ? results[results.length - 1] : { exit: null, ok: true, stdout: '', stderr: '', skipped: false },
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

  for (let i = 0; i < steps.length; i++) {
    const raw = steps[i];
    const spec = typeof raw === 'string' ? { command: raw } : raw;
    if (!spec || typeof spec.command !== 'string' || spec.command.trim() === '') {
      throw new Error(`steps[${i}] needs a non-empty "command" string`);
    }
    const id = spec.id || `s${i + 1}`;

    // --- condition ------------------------------------------------------
    const whenExpr = whenToExpr(spec.when);
    if (whenExpr) {
      let pass;
      try {
        pass = evaluate(whenExpr, ctx());
      } catch (err) {
        throw new Error(`steps[${i}] (${id}) bad "when" condition: ${err.message}`);
      }
      if (!pass) {
        const r = {
          index: i, id, command: spec.command, skipped: true, reason: `when: ${whenExpr}`,
          exit: null, ok: true, stdout: '', stderr: '', ms: 0, timedOut: false,
        };
        results.push(r);
        byId[id] = r;
        skippedCount++;
        continue;
      }
    }

    await sleep(num(spec.delay_before_ms ?? spec.delay_ms, 0));

    // --- interpolation --------------------------------------------------
    let command;
    let stepCwd;
    let stdin;
    try {
      const c = ctx();
      command = interpolate(spec.command, c);
      stepCwd = spec.cwd !== undefined ? interpolate(spec.cwd, c) : baseCwd;
      stdin = spec.stdin !== undefined ? interpolate(spec.stdin, c) : undefined;
    } catch (err) {
      throw new Error(`steps[${i}] (${id}) interpolation failed: ${err.message}`);
    }

    try {
      assertCommandAllowed(cfg, command);
    } catch (err) {
      // Label policy refusals the same way single-tool errors are, so the
      // caller recognises "the operator forbade this" in either place.
      const msg = err.name === 'PolicyError' ? `Policy: ${err.message}` : err.message;
      const r = {
        index: i, id, command, skipped: false, refused: true, reason: msg,
        exit: null, ok: false, stdout: '', stderr: '', ms: 0, timedOut: false,
      };
      results.push(r);
      byId[id] = r;
      failedCount++;
      if (stop_on_failure && (spec.on_failure ?? 'stop') !== 'continue') {
        aborted = true;
        abortReason = msg;
        break;
      }
      continue;
    }

    // --- run, with optional retries -------------------------------------
    const retry = spec.retry || {};
    const maxAttempts = Math.max(1, num(retry.count, 0) + 1);
    let run = null;
    let attempt = 0;
    let ok = false;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        run = await runCommand(cfg, {
          command,
          cwd: stepCwd,
          shell: spec.shell ?? baseShell,
          env: { ...baseEnv, ...(spec.env || {}) },
          timeoutMs: spec.timeout_ms ?? baseTimeout,
          login: spec.login ?? baseLogin,
          stdin,
          name: id,
        });
      } catch (err) {
        // A bad shell name or a missing cwd throws before anything spawns.
        // Record it as this step's failure rather than discarding the results
        // of every step that already ran.
        run = launchFailure(command, stepCwd, err.message);
      }
      ok = !run.error && okForStep(run.exitCode, spec.expect_exit);
      if (ok || attempt >= maxAttempts) break;
      await sleep(num(retry.delay_ms, 500));
    }

    const capture = spec.capture ?? baseCapture;
    const perStepBytes = num(
      spec.max_output_bytes ?? baseMaxBytes,
      Math.min(cfg.maxOutputBytes, 6000),
    );
    const shaped = captureOutput(run, { capture, ok, maxBytes: Math.min(perStepBytes, Math.max(budgetLeft, 0)), cfg });
    budgetLeft -= (shaped.stdout.length + shaped.stderr.length);

    const r = {
      index: i,
      id,
      command,
      cwd: run.cwd,
      shell: run.shellName,
      skipped: false,
      exit: run.exitCode,
      ok,
      stdout: shaped.stdout,
      stderr: shaped.stderr,
      ms: run.durationMs,
      timedOut: run.timedOut,
      attempts: attempt,
      error: run.error || null,
      suppressed: shaped.suppressed,
    };
    results.push(r);
    byId[id] = r;
    if (ok) okCount++; else failedCount++;

    // --- assign ---------------------------------------------------------
    if (spec.assign) {
      const src = spec.assign_from || 'stdout';
      const value =
        src === 'exit' ? run.exitCode
        : src === 'stderr' ? run.stderr.trim()
        : src === 'combined' ? run.combined.trim()
        : run.stdout.trim();
      vars[spec.assign] = value;
    }

    await sleep(num(spec.delay_after_ms, 0));

    // --- failure handling ------------------------------------------------
    if (!ok) {
      const policy = spec.on_failure ?? (stop_on_failure ? 'stop' : 'continue');
      if (policy === 'abort' || policy === 'stop') {
        aborted = true;
        abortReason = `step ${id} failed (exit=${run.exitCode}${run.timedOut ? ', timed out' : ''})`;
        break;
      }
    }
  }

  return {
    results,
    vars,
    aborted,
    abortReason,
    stats: {
      total: steps.length,
      executed: results.filter((r) => !r.skipped).length,
      ok: okCount,
      failed: failedCount,
      skipped: skippedCount,
      notReached: steps.length - results.length,
      durationMs: Date.now() - startedAt,
    },
  };
}

function captureOutput(run, { capture, ok, maxBytes, cfg }) {
  const opts = { maxBytes, ansi: cfg.keepAnsi };
  if (capture === 'none' || capture === 'exit') {
    return { stdout: '', stderr: '', suppressed: 'capture=' + capture };
  }
  if (capture === 'on_failure' && ok) {
    return { stdout: '', stderr: '', suppressed: 'capture=on_failure (step passed)' };
  }
  if (maxBytes <= 0) {
    return { stdout: '', stderr: '', suppressed: 'max_total_bytes budget exhausted' };
  }
  const shape = (s) => shapeOutput(s, opts).text;
  if (capture === 'tail') {
    return { stdout: tailBytes(shape(run.stdout), maxBytes), stderr: tailBytes(shape(run.stderr), maxBytes), suppressed: null };
  }
  if (capture === 'head') {
    return { stdout: headBytes(shape(run.stdout), maxBytes), stderr: headBytes(shape(run.stderr), maxBytes), suppressed: null };
  }
  return { stdout: shape(run.stdout), stderr: shape(run.stderr), suppressed: null };
}

function tailBytes(s, maxBytes) {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const cut = Buffer.from(s, 'utf8').subarray(Buffer.byteLength(s, 'utf8') - maxBytes).toString('utf8');
  const nl = cut.indexOf('\n');
  return `... [head omitted] ...\n${nl >= 0 ? cut.slice(nl + 1) : cut}`;
}

function headBytes(s, maxBytes) {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const cut = Buffer.from(s, 'utf8').subarray(0, maxBytes).toString('utf8');
  const nl = cut.lastIndexOf('\n');
  return `${nl > 0 ? cut.slice(0, nl) : cut}\n... [tail omitted] ...`;
}

/** Stand-in result for a step that could not even be launched. */
function launchFailure(command, cwd, message) {
  return {
    command,
    cwd: cwd ?? null,
    shellName: null,
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    combined: '',
    durationMs: 0,
    timedOut: false,
    error: message,
  };
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** Compact human/model-readable bulk report. */
export function renderBulk(out) {
  const { stats, results, vars, aborted, abortReason } = out;
  const head =
    `BULK ${stats.total} steps: ${stats.ok} ok, ${stats.failed} failed, ` +
    `${stats.skipped} skipped` +
    (stats.notReached ? `, ${stats.notReached} not reached` : '') +
    ` (${ms(stats.durationMs)})` +
    (aborted ? ` ABORTED: ${abortReason}` : '');

  const lines = [head];
  for (const r of results) {
    if (r.skipped) {
      lines.push(`[${r.index + 1}] ${r.id} SKIPPED (${r.reason})`);
      continue;
    }
    if (r.refused) {
      lines.push(`[${r.index + 1}] ${r.id} REFUSED ${r.reason}`);
      continue;
    }
    const flags = [
      `exit=${r.exit === null ? 'killed' : r.exit}`,
      r.ok ? 'ok' : 'FAIL',
      ms(r.ms),
      r.timedOut ? 'TIMED_OUT' : null,
      r.attempts > 1 ? `attempts=${r.attempts}` : null,
    ].filter(Boolean);
    lines.push(`[${r.index + 1}] ${r.id} ${flags.join(' ')} $ ${oneLine(r.command)}`);
    if (r.error) lines.push(`    error: ${r.error}`);
    if (r.stdout) lines.push(indent(r.stdout));
    if (r.stderr) lines.push(indent(`[stderr] ${r.stderr}`));
    if (r.suppressed && !r.ok) lines.push(`    (output suppressed: ${r.suppressed})`);
  }

  const varKeys = Object.keys(vars);
  if (varKeys.length) {
    lines.push(`vars: ${varKeys.map((k) => `${k}=${oneLine(String(vars[k]), 120)}`).join(' ')}`);
  }
  return lines.join('\n');
}

function oneLine(s, max = 200) {
  const flat = String(s).replace(/\s*\n\s*/g, ' ; ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function indent(s) {
  return s.split('\n').map((l) => `    ${l}`).join('\n');
}
