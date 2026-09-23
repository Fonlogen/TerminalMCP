// Plugin: laya — fast typed decisions, and an automated playtester built on them.
//
// Laya (pip install laya) is a non-autoregressive "System 1" model: it answers
// typed questions — choice, score, noul (a calibrated yes/no probability) —
// about a state in one forward pass, tens of milliseconds on a GPU. That is the
// wrong tool for reasoning and the right one for a decision that has to be
// made fifty times a second, where an LLM round-trip is out of the question.
//
// Two ways in:
//
//   decide    one state (or a batch) in, typed answers out. For triage, a
//             guardrail, a cheap classification in the middle of a task.
//   playtest  the loop that runs WITHOUT the model in it: read the game's
//             state, let Laya pick the next action, send it back — through the
//             game's own bridge, or as real keys and clicks via input_bulk —
//             and record every anomaly with the ticks that led to it. The
//             model reads the report afterwards and fixes the code.
//
// Laya is Python and torch; this server is dependency-free Node. So the model
// lives in a long-lived worker process (worker.py) that keeps the checkpoints
// resident, or behind a `laya-serve` HTTP endpoint. Either way the weights are
// loaded once, not per call — which is the whole difference between 30 ms and
// ten seconds.

import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { assertCommandAllowed, resolveSafePath } from '../../src/guards.js';
import { apiFetch } from '../../src/plugins.js';
import { compile, evaluate } from '../../src/expr.js';
import { runCommand } from '../../src/exec.js';
import { ms, truncateMiddle } from '../../src/format.js';
import { capture } from '../../src/screen.js';
import { saveBuffer } from '../../src/browser.js';
import { parseStepShorthand } from '../../src/inputbulk.js';
import { createHandlers as createInputHandlers } from '../../src/tools/input.js';
import { captureFrame, frameDiff } from '../../src/input.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, 'worker.py');

export const LABEL = 'Laya: fast typed decisions (choice/score/noul) and an automated playtester';

/** playtest drives a game — keys, clicks or its bridge — so readOnly refuses it. */
export const MUTATING_ACTIONS = ['playtest'];

export const TOOLS = [
  {
    name: 'laya',
    description:
      'Fast typed decisions with Laya, a local "System 1" model: choice (pick a label), score (a level ' +
      'on a scale) and noul (calibrated probability of yes), answered in one forward pass — about 30 ms ' +
      'on a GPU, no text generated. decide answers questions about one state or a batch; route shows ' +
      'which checkpoint would answer. playtest runs a game autonomously for a while: reads its state ' +
      '(TCP bridge, a file or a command), lets Laya choose the next action, sends it back (to the bridge, ' +
      'or as real keys/clicks via input_bulk steps), and writes a report of every anomaly with the ticks ' +
      'before it — read the report, then fix the code. Laya is a fast base, not a reasoner: use it where ' +
      'a decision must be cheap and frequent, and check its confidence.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'start', 'stop', 'decide', 'route', 'playtest', 'playtest_status', 'playtest_stop'],
          description: 'start loads the model (first use downloads it); decide starts it on demand anyway.',
        },
        state: { description: 'decide/route: the state — an object (a game frame, a ticket, a log line as JSON) or plain text.' },
        states: { type: 'array', description: 'decide: many states, same questions, scored together.' },
        questions: {
          type: 'object',
          description:
            'decide: {name: question}. {type:"choice", instructions, criteria:{label: description}} | ' +
            '{type:"score", instructions, criteria:["low", "mid", "high"]} | {type:"noul", instructions}. ' +
            'playtest: extra questions asked every tick, readable in the anomaly rule as answers.<name>.',
        },
        preset: { type: 'string', enum: ['router', 'guard', 'moderation', 'triage'], description: 'decide: a built-in question set instead of questions.' },
        model: { type: 'string', enum: ['english', 'multilingual', 'typed-decisions'], description: 'Force a checkpoint instead of routing.' },
        raw: { type: 'boolean', description: 'decide: return Laya\'s full JSON instead of the compact summary.' },

        goal: { type: 'string', description: 'playtest: what the tester is trying to do; becomes the action question. Default: explore and find bugs.' },
        actions: {
          description:
            'playtest: the actions Laya chooses between. {name: "what it does"} or {name: {description, send, input}}. ' +
            'send: what goes to the bridge (default {"action": name}). input: input_bulk step(s) for that action — ' +
            '"key w", {action:"key", keys:"w", hold_ms:300}, or a list.',
        },
        bridge: { description: 'playtest: the game\'s TCP bridge, "host:port" or a port. The game listens; each tick it sends one JSON line of state and reads one JSON line back.' },
        state_file: { type: 'string', description: 'playtest: read the state from this JSON file every tick (the game rewrites it).' },
        state_command: { type: 'string', description: 'playtest: run this command every tick; its stdout (JSON or text) is the state. Slow — a shell per tick.' },
        window: { type: 'string', description: 'playtest: raise this window once before starting, so input lands in the game.' },
        duration_s: { type: 'integer', description: 'playtest: how long to run. Default 60.' },
        max_steps: { type: 'integer', description: 'playtest: stop after this many decisions.' },
        tick_ms: { type: 'integer', description: 'playtest: minimum time per decision. Default 50.' },
        epsilon: { type: 'number', description: 'playtest: chance of a random action instead of Laya\'s pick, so it does not loop forever on one idea. Default 0.1; it rises on its own while the player is stuck or the picture is not changing (adaptive:false turns that off).' },
        adaptive: { type: 'boolean', description: 'playtest: explore more while nothing moves. Default true.' },
        desktop: { type: 'boolean', description: 'playtest: a real game with no bridge (Minecraft, anything). The state is built from its window — open, focused, how much the picture changed, brightness, static_ticks — plus log_file. Needs window, and actions with input.' },
        log_file: { type: 'string', description: 'playtest: the game\'s log, followed as it grows (e.g. "%APPDATA%/.minecraft/logs/latest.log"). New lines go into state.log; lines matching error_pattern set state.has_exception and state.last_log. Works with any source.' },
        error_pattern: { type: 'string', description: 'playtest: regex for log lines that are errors. Default: ERROR, FATAL, SEVERE, Exception, Traceback, "Error:".' },
        frozen_ticks: { type: 'integer', description: 'playtest: with a watched window, flag a picture that has not changed for this many ticks. Default 30.' },
        refocus: { type: 'boolean', description: 'playtest: when the game loses focus, take it back (input is never sent to another window either way). Default true.' },
        wait_for_play_s: { type: 'integer', description: 'playtest: a bridge that reports {"playing": false} (an editor before Play is pressed) is waited on this long. Default 120.' },
        anomaly: { type: 'string', description: 'playtest: expression that flags a tick, over state, answers, action, confidence, step. Default "state.has_exception". E.g. \'state.has_exception || answers.bug.noul > 0.8 || state.pos[1] < -50\'.' },
        stuck: {
          type: 'object',
          properties: {
            field: { type: 'string', description: 'State field holding the position. Default "pos".' },
            ticks: { type: 'integer', description: 'Unchanged for this many ticks = stuck. Default 40.' },
            epsilon: { type: 'number', description: 'Movement below this counts as unchanged. Default 0.05.' },
          },
          description: 'playtest: flag the player as stuck when a position stops changing. Deterministic, no model involved.',
        },
        stop_on_anomaly: { type: 'boolean', description: 'playtest: end at the first anomaly. Default false.' },
        shot_on_anomaly: { type: 'boolean', description: 'playtest: save a screenshot at each new anomaly (window if given, else screen). Default false.' },
        report: { type: 'string', description: 'playtest: where to write the JSON report. Default .terminalmcp/playtest/<time>.json.' },
        background: { type: 'boolean', description: 'playtest: return an id at once and keep running; check it with playtest_status.' },
        id: { type: 'string', description: 'playtest_status/playtest_stop: the run id.' },
        wait_s: { type: 'integer', description: 'playtest_status: block up to this long for the run to finish.' },
        timeout_ms: { type: 'integer', description: 'Time limit for one decision (and for start). Default 120000.' },
        max_bytes: { type: 'integer', description: 'Byte cap on returned text.' },
      },
      required: ['action'],
    },
  },
];

// ------------------------------------------------------------ the backends

/** The Python that has laya installed: configured, a venv in the cwd, or PATH. */
export function findPython(settings, cwd) {
  if (settings.python) return settings.python;
  const candidates = process.platform === 'win32'
    ? [join(cwd, '.venv', 'Scripts', 'python.exe'), join(cwd, 'venv', 'Scripts', 'python.exe')]
    : [join(cwd, '.venv', 'bin', 'python'), join(cwd, 'venv', 'bin', 'python')];
  return candidates.find((p) => existsSync(p)) ?? (process.platform === 'win32' ? 'python' : 'python3');
}

/** Normalise `preload` from the config into what the worker reads. */
export function preloadSpec(preload) {
  if (preload === true || preload === 'all') return 'all';
  if (preload === false || preload === null) return '';
  if (Array.isArray(preload)) return preload.join(',');
  if (typeof preload === 'string') return preload;
  return 'english';
}

/**
 * The resident worker. One process, requests matched to replies by id, so
 * several callers can share it; the model itself answers them in turn.
 */
class Worker {
  constructor({ python, env, log }) {
    this.python = python;
    this.env = env;
    this.log = log;
    this.proc = null;
    this.state = 'stopped';
    this.info = null;
    this.error = null;
    this.stderr = '';
    this.pending = new Map();
    this.nextId = 0;
    this.ready = null;
    this.stats = { decisions: 0, totalMs: 0 };
  }

  start(timeoutMs) {
    if (this.ready) return this.ready;
    this.state = 'loading';
    this.error = null;
    this.stderr = '';

    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
      const timer = setTimeout(() => {
        settle(reject, new Error(
          `Laya did not finish loading within ${ms(timeoutMs)}. The first start downloads the checkpoint ` +
          '(about 1.7 GB for the English one); give it longer with timeout_ms, or check status.',
        ));
      }, timeoutMs);

      let proc;
      try {
        proc = spawn(this.python, ['-u', WORKER], {
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_SYMLINKS_WARNING: '1', ...this.env },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err) {
        this.fail(`cannot start ${this.python}: ${err.message}`);
        settle(reject, new Error(this.error));
        return;
      }
      this.proc = proc;

      let buf = '';
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { this.stderr = tail(`${this.stderr}${line}\n`); continue; }
          if (msg.event === 'ready') {
            this.state = 'ready';
            this.info = msg;
            settle(resolve, msg);
          } else if (msg.event === 'fatal') {
            this.fail(msg.error);
            settle(reject, new Error(explainFatal(msg, this.python)));
          } else if (msg.event === 'loading') {
            this.log?.(`laya: loading (preload=${msg.preload ?? 'lazy'})`);
          } else if (msg.id !== undefined) {
            const p = this.pending.get(msg.id);
            if (p) { this.pending.delete(msg.id); p(msg); }
          }
        }
      });
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (d) => { this.stderr = tail(this.stderr + d); });
      proc.on('error', (err) => {
        const msg = err.code === 'ENOENT'
          ? `Python not found at "${this.python}". Set pluginConfig.laya.python to the interpreter where laya is installed ` +
            '(e.g. the .venv\\Scripts\\python.exe of the project).'
          : `worker failed: ${err.message}`;
        this.fail(msg);
        settle(reject, new Error(msg));
      });
      proc.on('exit', (code) => {
        settle(reject, new Error(this.error ?? 'worker exited'));
        // A stopped worker's exit can land after a new one started: it must
        // not tear down its successor.
        if (this.proc !== proc) return;
        if (this.state !== 'stopped') this.fail(`worker exited (code ${code})${this.stderr ? `: ${lastLines(this.stderr, 6)}` : ''}`);
        for (const p of this.pending.values()) p({ ok: false, error: this.error ?? 'worker exited' });
        this.pending.clear();
        this.proc = null;
        this.ready = null;
      });
    });
    // A rejected start must not stay cached: the next call should try again.
    this.ready.catch(() => { this.ready = null; });
    return this.ready;
  }

  fail(message) {
    this.state = 'failed';
    this.error = message;
  }

  async request(op, payload, timeoutMs) {
    await this.start(timeoutMs);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error(this.error ?? 'the Laya worker is not running'));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Laya did not answer within ${ms(timeoutMs)} (op ${op}). A first question on a checkpoint that is not loaded yet loads it.`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (!msg.ok) return reject(new Error(`Laya: ${msg.error}`));
        if (op === 'predict' || op === 'predict_batch') {
          this.stats.decisions += op === 'predict' ? 1 : (payload.states?.length ?? 1);
          this.stats.totalMs += msg.ms ?? 0;
        }
        resolve({ result: msg.result, ms: msg.ms });
      });
      this.proc.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`);
    });
  }

  stop() {
    const was = this.state;
    this.state = 'stopped';
    if (this.proc) {
      try { this.proc.stdin.end(); } catch { /* gone */ }
      try { this.proc.kill(); } catch { /* gone */ }
    }
    this.proc = null;
    this.ready = null;
    return was;
  }
}

/** A `laya-serve` endpoint: the same questions over HTTP, nothing to spawn. */
class HttpBackend {
  constructor({ url, apiKey, redactor }) {
    this.url = url.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.redactor = redactor;
    this.state = 'remote';
    this.stats = { decisions: 0, totalMs: 0 };
  }

  async request(op, payload, timeoutMs) {
    if (op === 'route') throw new Error('route is not available over laya-serve; it answers decisions only.');
    if (op === 'status') {
      const r = await apiFetch(`${this.url}/health`, { timeoutMs: Math.min(timeoutMs, 10000), redactor: this.redactor }).catch((e) => ({ ok: false, raw: e.message }));
      return { result: { url: this.url, health: r.ok ? (r.json ?? r.raw) : `unreachable: ${r.raw}` } };
    }
    if (payload.preset) throw new Error('presets need the local worker; pass the questions explicitly to laya-serve.');
    const one = async (state) => {
      const t0 = Date.now();
      const r = await apiFetch(`${this.url}/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({ state, questions: payload.questions, ...(payload.model ? { model: payload.model } : {}) }),
        timeoutMs,
        redactor: this.redactor,
        label: 'laya-serve /v1/systemone',
      });
      if (!r.ok) throw new Error(`laya-serve answered ${r.status}: ${truncateMiddle(r.raw, 400).text}`);
      this.stats.decisions++;
      this.stats.totalMs += Date.now() - t0;
      return r.json;
    };
    const t0 = Date.now();
    if (op === 'predict_batch') {
      const out = [];
      for (const s of payload.states) out.push(await one(s));
      return { result: out, ms: Date.now() - t0 };
    }
    return { result: await one(payload.state), ms: Date.now() - t0 };
  }

  stop() { return 'remote'; }
}

function explainFatal(msg, python) {
  if (/cannot import laya/.test(msg.error)) {
    return `${msg.error}\nThe Python at "${msg.python ?? python}" does not have laya. Either install it there ` +
      '(python -m pip install laya; for an NVIDIA GPU install the CUDA build of torch first), or point ' +
      'pluginConfig.laya.python at the venv that has it.';
  }
  return msg.error + (msg.trace ? `\n${lastLines(msg.trace, 8)}` : '');
}

const tail = (s, n = 8000) => (s.length > n ? s.slice(-n) : s);
const lastLines = (s, n) => s.trim().split('\n').slice(-n).join('\n');

// -------------------------------------------------------------- rendering

const round = (n, d = 2) => (typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(d)) : n);

/** The label → probability map a choice answer carries, whatever it is called. */
function distribution(a) {
  for (const k of ['probabilities', 'probs', 'distribution', 'scores']) {
    const v = a?.[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  }
  return null;
}

/** One answer as a short phrase: "billing 0.94 (technical 0.04)", "1.8 (conf 0.61)", "0.89". */
export function renderAnswer(a) {
  if (a === null || a === undefined) return '—';
  if (typeof a !== 'object') return String(a);
  if ('choice' in a) {
    // The pick's own probability first, then the runners-up on the same scale.
    // Laya's `confidence` is a separate, calibrated number — it can be low while
    // the pick still leads — so it is shown as that, not as the pick's share.
    const dist = distribution(a);
    const p = (v) => (v < 0.01 ? '<0.01' : String(round(v)));
    const own = dist?.[a.choice];
    const runnersUp = dist
      ? Object.entries(dist).filter(([k]) => k !== a.choice).sort((x, y) => y[1] - x[1]).slice(0, 2)
        .map(([k, v]) => `${k} ${p(v)}`).join(', ')
      : '';
    return `${a.choice}${own !== undefined ? ` ${p(own)}` : ''}${runnersUp ? ` (${runnersUp})` : ''}` +
      `${a.confidence !== undefined ? `, conf ${round(a.confidence)}` : ''}`;
  }
  if ('score' in a) {
    // The legend names the levels; the nearest one says what the number means.
    const level = a.legend?.[String(Math.round(a.score))];
    return `${round(a.score)}${level ? ` ~ ${level}` : ''}${a.confidence !== undefined ? ` (conf ${round(a.confidence)})` : ''}`;
  }
  if ('noul' in a) return `P(yes)=${round(a.noul)}`;
  return JSON.stringify(a);
}

export function renderResult(result) {
  const answers = result?.answers ?? {};
  const names = Object.keys(answers);
  if (!names.length) return '(no answers)';
  const width = Math.min(24, Math.max(...names.map((n) => n.length)));
  return names.map((n) => `${n.padEnd(width)}  ${renderAnswer(answers[n])}`).join('\n');
}

// ---------------------------------------------------------------- playtest

/** "host:port", a port number, or {host, port}. */
export function parseBridge(b) {
  if (b === undefined || b === null || b === '') return null;
  if (typeof b === 'number') return { host: '127.0.0.1', port: b };
  if (typeof b === 'object') return { host: b.host ?? '127.0.0.1', port: Number(b.port) };
  const s = String(b).trim();
  const m = s.match(/^(?:\[?([^\]]*?)\]?:)?(\d+)$/);
  if (!m) throw new Error(`bridge "${s}" is not "host:port" or a port`);
  return { host: m[1] || '127.0.0.1', port: Number(m[2]) };
}

/** Actions in either spelling, as {name: {description, send, steps}}. */
export function normaliseActions(actions) {
  if (!actions) throw new Error('playtest needs "actions": the moves Laya chooses between');
  const entries = Array.isArray(actions)
    ? actions.map((n) => [String(n), {}])
    : Object.entries(actions).map(([n, v]) => [n, typeof v === 'string' ? { description: v } : (v ?? {})]);
  if (entries.length < 2) throw new Error('playtest needs at least two actions to choose between');
  const out = {};
  for (const [name, spec] of entries) {
    // Laya reads the label as text, and yes/no-like labels pull a choice
    // towards themselves regardless of the state (its documented limit).
    if (/^(true|false|yes|no)$/i.test(name)) {
      throw new Error(`action "${name}" reads as a boolean to Laya and biases its choice; name it for what it does`);
    }
    let steps = null;
    if (spec.input !== undefined) {
      steps = Array.isArray(spec.input) ? spec.input : [spec.input];
      steps.forEach((s, i) => {
        if (typeof s === 'string') {
          try { parseStepShorthand(s); } catch (err) { throw new Error(`action "${name}" input[${i}]: ${err.message}`); }
        }
      });
    }
    out[name] = {
      description: spec.description ?? name.replace(/[_-]+/g, ' '),
      send: spec.send ?? null,
      steps,
    };
  }
  return out;
}

/** A line-oriented TCP client: the game listens, we read state and answer. */
class BridgeConnection {
  constructor({ host, port }) {
    this.host = host;
    this.port = port;
    this.buf = '';
    this.lines = [];
    this.waiter = null;
    this.closed = false;
  }

  connect(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      const timer = setTimeout(() => { sock.destroy(); reject(new Error(`no answer from the game bridge at ${this.host}:${this.port} within ${ms(timeoutMs)}`)); }, timeoutMs);
      sock.once('connect', () => { clearTimeout(timer); this.sock = sock; resolve(); });
      sock.once('error', (err) => {
        clearTimeout(timer);
        reject(new Error(
          err.code === 'ECONNREFUSED'
            ? `nothing is listening on ${this.host}:${this.port}. Start the game in play mode with its bridge first.`
            : `bridge ${this.host}:${this.port}: ${err.message}`,
        ));
      });
      sock.setEncoding('utf8');
      sock.setNoDelay(true);
      sock.on('data', (d) => {
        this.buf += d;
        let nl;
        while ((nl = this.buf.indexOf('\n')) !== -1) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (line) this.lines.push(line);
        }
        this.wake();
      });
      sock.on('close', () => { this.closed = true; this.wake(); });
      sock.on('error', () => { this.closed = true; this.wake(); });
    });
  }

  wake() {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  /** The newest state line; older ones queued behind it are stale by now. */
  async next(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (!this.lines.length) {
      if (this.closed) return null;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`the game sent no state for ${ms(timeoutMs)}`);
      await new Promise((r) => { this.waiter = r; setTimeout(r, Math.min(left, 250)); });
    }
    const line = this.lines.pop();
    const skipped = this.lines.length;
    this.lines.length = 0;
    return { line, skipped };
  }

  send(obj) {
    if (!this.closed) this.sock.write(`${JSON.stringify(obj)}\n`);
  }

  close() { try { this.sock?.destroy(); } catch { /* gone */ } }
}

/** Expand %APPDATA% and ~, since a game's log almost always lives under one. */
export function expandPath(p) {
  return String(p)
    .replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m)
    .replace(/^~(?=[\\/]|$)/, process.env.USERPROFILE ?? process.env.HOME ?? '~');
}

/**
 * Following a log as it grows: only what was written since the last tick.
 * The game's log is where an engine or a JVM reports what went wrong, and it
 * is there whether or not the game has a bridge — so for a real game it is
 * the one source of "this is a bug" that needs no cooperation from the game.
 */
export class LogTail {
  constructor(path, pattern) {
    this.path = path;
    this.re = new RegExp(pattern ?? '\\b(ERROR|FATAL|SEVERE)\\b|Exception|Traceback|\\bError:', 'i');
    this.offset = null;
    this.partial = '';
  }

  async lines() {
    let size;
    try { size = (await stat(this.path)).size; } catch { return []; }
    // Start at the end: what was logged before the playtest is not its doing.
    if (this.offset === null) { this.offset = size; return []; }
    if (size < this.offset) { this.offset = 0; this.partial = ''; }   // rotated or truncated
    if (size === this.offset) return [];
    const len = Math.min(size - this.offset, 256 * 1024);
    const fh = await open(this.path, 'r');
    try {
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      this.offset = size;
      const text = this.partial + buf.toString('utf8');
      const parts = text.split(/\r?\n/);
      this.partial = parts.pop() ?? '';
      return parts.filter((l) => l.trim());
    } finally {
      await fh.close();
    }
  }
}

function parseState(text) {
  const t = String(text ?? '').trim();
  if (/^[[{]/.test(t)) {
    try { return JSON.parse(t); } catch { /* fall through: text is a state too */ }
  }
  return t;
}

function distance(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b);
  const va = Array.isArray(a) ? a : a && typeof a === 'object' ? Object.values(a) : null;
  const vb = Array.isArray(b) ? b : b && typeof b === 'object' ? Object.values(b) : null;
  if (!va || !vb || va.length !== vb.length) return Infinity;
  return Math.sqrt(va.reduce((s, v, i) => s + (Number(v) - Number(vb[i])) ** 2, 0));
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

const sleep = (n) => (n > 0 ? new Promise((r) => setTimeout(r, n)) : Promise.resolve());

/**
 * The loop. Everything that can be wrong with the arguments is checked before
 * the first action is sent — a playtest that dies on tick 1 of a 90 s run is
 * worse than one refused up front.
 */
async function runPlaytest(p, { backend, cfg, inputHandlers, run }) {
  const actions = normaliseActions(p.actions);
  const names = Object.keys(actions);
  const sources = ['bridge', 'state_file', 'state_command', 'desktop'].filter((k) => p[k] !== undefined && p[k] !== null && p[k] !== '' && p[k] !== false);
  if (sources.length !== 1) {
    throw new Error(
      'playtest needs exactly one state source: bridge ("host:port") for a game with a bridge, desktop: true for a ' +
      'real game seen through its window and log, state_file, or state_command',
    );
  }
  if (p.desktop && !p.window) {
    throw new Error('desktop needs "window": part of the game window\'s title, so its picture can be watched and input kept inside it');
  }
  const bridgeAddr = p.bridge !== undefined ? parseBridge(p.bridge) : null;
  if (!bridgeAddr) {
    const missing = names.filter((n) => !actions[n].steps);
    if (missing.length) {
      throw new Error(
        `without a bridge nothing carries the action to the game, so every action needs "input" ` +
        `(input_bulk steps like "key w"). Missing on: ${missing.join(', ')}`,
      );
    }
  }
  if (p.state_command) assertCommandAllowed(cfg, p.state_command);

  const anomalyExpr = p.anomaly ?? 'state.has_exception';
  try { compile(anomalyExpr); } catch (err) { throw new Error(`anomaly "${anomalyExpr}": ${err.message}`); }

  const questions = {
    action: {
      type: 'choice',
      instructions: p.goal ?? 'You are playtesting this game. Pick the next action that explores the level and is most likely to expose a bug.',
      criteria: Object.fromEntries(names.map((n) => [n, actions[n].description])),
    },
    ...(p.questions ?? {}),
  };
  if (p.questions?.action) throw new Error('"action" is the name of the built-in action question; call yours something else');

  const durationMs = Math.max(1, Number(p.duration_s ?? 60)) * 1000;
  const maxSteps = p.max_steps ?? Infinity;
  const tickMs = Math.max(0, Number(p.tick_ms ?? 50));
  const epsilon = Math.min(1, Math.max(0, Number(p.epsilon ?? 0.1)));
  const timeoutMs = p.timeout_ms ?? 120000;
  const stuck = p.stuck ? { field: p.stuck.field ?? 'pos', ticks: p.stuck.ticks ?? 40, epsilon: p.stuck.epsilon ?? 0.05 } : null;
  const reportPath = resolveSafePath(cfg, p.report ?? join(cfg.cwd, '.terminalmcp', 'playtest', `${stamp()}.json`), { forWrite: true });

  // Make sure the model is up before the clock starts: loading is not playing.
  if (backend.start) await backend.start(p.timeout_ms ?? 600000);

  let bridge = null;
  if (bridgeAddr) {
    bridge = new BridgeConnection(bridgeAddr);
    await bridge.connect();
  }
  if (p.window) await inputHandlers.input({ action: 'focus', window: p.window });

  const usesInput = names.some((n) => actions[n].steps);
  // Watch the window whenever input goes into it: that is how a keystroke is
  // kept from landing in whatever the user switched to.
  const watchFrames = Boolean(p.desktop || (p.window && usesInput));
  const frozenTicks = Math.max(2, Number(p.frozen_ticks ?? 30));
  const logTail = p.log_file ? new LogTail(resolveSafePath(cfg, expandPath(p.log_file)), p.error_pattern) : null;
  if (p.error_pattern) {
    try { new RegExp(p.error_pattern); } catch (err) { throw new Error(`error_pattern: ${err.message}`); }
  }
  if (logTail) await logTail.lines();
  let lastFrame = null;
  let staticFor = 0;
  let lastAction = null;
  let lastRefocus = 0;

  /** What the window and the log say, merged into the tick's state. */
  const enrich = async (base) => {
    if (!watchFrames && !logTail) return base;
    const state = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : base === '' || base === undefined ? {} : { text: base };
    if (watchFrames) {
      const f = await captureFrame(cfg, { window: p.window ?? null });
      if (f.missing) {
        state.window_open = f.missing !== 'nowindow';
        state.window_minimized = f.missing === 'minimized';
      } else {
        const change = frameDiff(lastFrame, f.luma);
        staticFor = change !== null && change < 0.004 ? staticFor + 1 : 0;
        lastFrame = f.luma;
        state.window_open = true;
        state.focused = p.window ? f.foreground.toLowerCase().includes(String(p.window).toLowerCase()) : true;
        state.frame_change = change === null ? null : round(change, 4);
        state.brightness = round(f.luma.reduce((a, b) => a + b, 0) / f.luma.length / 255, 3);
        state.static_ticks = staticFor;
      }
      if (p.desktop) state.last_action = lastAction;
    }
    if (logTail) {
      const lines = await logTail.lines();
      const errors = lines.filter((l) => logTail.re.test(l));
      state.log = lines.slice(-5).map((l) => l.slice(0, 240));
      if (errors.length) {
        state.has_exception = true;
        state.last_log = errors.slice(-3).join('\n').slice(0, 1200);
      } else if (state.has_exception === undefined) {
        state.has_exception = false;
      }
    }
    return state;
  };

  const readState = async () => {
    if (p.desktop) return enrich({});
    if (bridge) {
      const r = await bridge.next(Math.max(5000, tickMs * 20));
      if (!r) return null;
      run.skippedFrames += r.skipped;
      return enrich(parseState(r.line));
    }
    if (p.state_file) return enrich(parseState(await readFile(resolveSafePath(cfg, p.state_file), 'utf8')));
    const out = await runCommand(cfg, { command: p.state_command, timeoutMs: 15000, name: 'laya-state' });
    if (out.exitCode !== 0) throw new Error(`state_command exited ${out.exitCode}: ${truncateMiddle(out.stderr || out.stdout, 300).text}`);
    return enrich(parseState(out.stdout));
  };

  const histogram = Object.fromEntries(names.map((n) => [n, 0]));
  const trace = [];
  const anomalies = [];
  const seen = new Map();
  let prevState = null;
  let stillFor = 0;
  let lastPos;
  const started = Date.now();
  let endReason = 'duration reached';
  const latencies = [];
  let waitedMs = 0;

  try {
    while (!run.stopRequested) {
      if (Date.now() - started >= durationMs) break;
      if (run.steps >= maxSteps) { endReason = 'max_steps reached'; break; }
      const tickStart = Date.now();

      const state = await readState();
      if (state === null) { endReason = 'the game closed the bridge'; break; }
      // A bridge that is up while the game is not (an editor with no Play
      // session yet) says so; that is waiting, not a decision.
      if (bridge && state && typeof state === 'object' && state.playing === false) {
        waitedMs += Date.now() - tickStart + 500;
        if (waitedMs > (p.wait_for_play_s ?? 120) * 1000) { endReason = 'the game never started playing (press Play)'; break; }
        await sleep(500);
        bridge.send({ action: 'wait' });
        continue;
      }

      const { result, ms: laMs } = await backend.request('predict', { state, questions, ...(p.model ? { model: p.model } : {}) }, timeoutMs);
      latencies.push(laMs ?? 0);
      const answers = result?.answers ?? {};
      let action = answers.action?.choice;
      const confidence = answers.action?.confidence ?? null;
      let explored = false;
      // A zero-shot pick on a state that is not changing is the same pick
      // again: walking into the wall it just walked into. The longer nothing
      // moves, the likelier a random different action, up to a coin flip.
      const standing = Math.max(stuck ? stillFor / stuck.ticks : 0, watchFrames ? staticFor / frozenTicks : 0);
      const explore = Math.min(0.5, epsilon + (p.adaptive === false ? 0 : standing * 0.5));
      if (!actions[action] || Math.random() < explore) {
        explored = Boolean(actions[action]);
        const others = actions[action] && names.length > 1 ? names.filter((n) => n !== action) : names;
        action = others[Math.floor(Math.random() * others.length)];
      }
      run.steps++;
      histogram[action]++;

      // --- is this tick an anomaly? --------------------------------------
      const reasons = [];
      let hit = false;
      try {
        hit = evaluate(anomalyExpr, { state, answers, action, confidence, step: run.steps, prev: prevState });
      } catch (err) {
        throw new Error(`anomaly "${anomalyExpr}" failed on step ${run.steps}: ${err.message}`);
      }
      if (hit) reasons.push(`anomaly: ${anomalyExpr}`);
      if (stuck && state && typeof state === 'object') {
        const pos = state[stuck.field];
        if (pos !== undefined && lastPos !== undefined && distance(pos, lastPos) < stuck.epsilon) stillFor++;
        else stillFor = 0;
        lastPos = pos;
        if (stillFor === stuck.ticks) reasons.push(`stuck: ${stuck.field} unchanged for ${stuck.ticks} ticks`);
      }
      let windowGone = false;
      if (watchFrames && state && typeof state === 'object') {
        if (state.window_open === false) {
          windowGone = true;
          reasons.push(`window "${p.window}" is gone: the game crashed or quit`);
        } else if (state.static_ticks === frozenTicks) {
          reasons.push(`picture unchanged for ${frozenTicks} ticks while acting: frozen, or stuck against something`);
        }
      }

      const tick = { step: run.steps, t_ms: Date.now() - started, action, confidence: round(confidence, 3), explored, state };
      trace.push(tick);
      if (trace.length > 50) trace.shift();

      if (reasons.length) {
        // The same exception every frame is one bug, not four hundred.
        const log = state && typeof state === 'object' ? (state.last_log ?? state.error ?? '') : '';
        const key = `${reasons.join('|')}::${String(log).slice(0, 200)}`;
        if (seen.has(key)) {
          seen.get(key).count++;
        } else if (anomalies.length < 200) {
          const entry = {
            step: run.steps,
            t_ms: tick.t_ms,
            reasons,
            count: 1,
            action,
            answers,
            state,
            before: trace.slice(-6, -1).map(({ step, action: a, confidence: c, state: s }) => ({ step, action: a, confidence: c, state: s })),
          };
          if (p.shot_on_anomaly) {
            try {
              const shot = await capture(cfg, { mode: p.window ? 'window' : 'screen', window: p.window ?? null, timeoutMs: 20000 });
              entry.screenshot = await saveBuffer(reportPath.replace(/\.json$/i, '') + `_step${run.steps}.png`, shot.buf);
            } catch (err) {
              entry.screenshot_error = err.message;
            }
          }
          seen.set(key, entry);
          anomalies.push(entry);
          run.anomalies = anomalies.length;
        }
        if (p.stop_on_anomaly) { endReason = `anomaly at step ${run.steps}`; break; }
      }
      if (windowGone) { endReason = 'the game window closed'; break; }

      // --- act -------------------------------------------------------------
      if (bridge) bridge.send(actions[action].send ?? { action });
      if (actions[action].steps) {
        // Keys meant for the game must not land in whatever the user switched
        // to. Out of focus: take it back (at most every 2 s) and skip this act.
        if (watchFrames && p.window && state && state.focused === false) {
          run.unfocused++;
          if (Date.now() - lastRefocus > 2000 && p.refocus !== false) {
            lastRefocus = Date.now();
            await inputHandlers.input({ action: 'focus', window: p.window }).catch(() => {});
          }
        } else {
          const out = await inputHandlers.input_bulk({ steps: actions[action].steps, delay_ms: 0, max_shots: 0 });
          if (/^INPUT_BULK .* ABORTED/.test(out.text)) {
            throw new Error(`action "${action}" failed: ${out.text.split(/\r?\n/).slice(0, 3).join(' ')}`);
          }
        }
      }
      lastAction = action;

      prevState = state;
      await sleep(tickMs - (Date.now() - tickStart));
    }
    if (run.stopRequested) endReason = 'stopped';
  } finally {
    bridge?.close();
  }

  const elapsed = Date.now() - started;
  const sorted = [...latencies].sort((a, b) => a - b);
  const summary = {
    steps: run.steps,
    elapsed_ms: elapsed,
    decisions_per_s: round(run.steps / Math.max(elapsed / 1000, 0.001), 1),
    laya_ms_p50: round(sorted[Math.floor(sorted.length * 0.5)] ?? 0, 1),
    laya_ms_p95: round(sorted[Math.floor(sorted.length * 0.95)] ?? 0, 1),
    end_reason: endReason,
    actions: histogram,
    anomalies: anomalies.length,
    stale_frames_skipped: run.skippedFrames,
    unfocused_ticks: run.unfocused,
  };
  const report = {
    created: new Date(started).toISOString(),
    config: {
      source: bridgeAddr ? `bridge ${bridgeAddr.host}:${bridgeAddr.port}` : p.desktop ? `desktop window "${p.window}"` : p.state_file ? `file ${p.state_file}` : `command ${p.state_command}`,
      log_file: logTail?.path ?? null,
      goal: questions.action.instructions,
      actions: Object.fromEntries(names.map((n) => [n, actions[n].description])),
      anomaly: anomalyExpr,
      stuck,
      epsilon,
      model: p.model ?? 'routed',
    },
    summary,
    anomalies,
    last_ticks: trace,
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  return { summary, anomalies, reportPath };
}

export function renderPlaytest({ summary, anomalies, reportPath }) {
  const s = summary;
  const lines = [
    `PLAYTEST ${s.steps} decisions in ${ms(s.elapsed_ms)} (${s.decisions_per_s}/s, Laya p50 ${s.laya_ms_p50}ms p95 ${s.laya_ms_p95}ms) — ${s.end_reason}`,
    `actions: ${Object.entries(s.actions).map(([k, v]) => `${k}=${v}`).join(' ')}`,
  ];
  if (s.stale_frames_skipped) lines.push(`skipped ${s.stale_frames_skipped} stale frame(s): the game sends faster than Laya decides`);
  if (!anomalies.length) {
    lines.push('no anomalies');
  } else {
    lines.push(`${anomalies.length} distinct anomal${anomalies.length === 1 ? 'y' : 'ies'}:`);
    for (const a of anomalies.slice(0, 10)) {
      const log = a.state && typeof a.state === 'object' ? (a.state.last_log ?? a.state.error ?? '') : '';
      lines.push(
        `  step ${a.step} (${ms(a.t_ms)})${a.count > 1 ? ` x${a.count}` : ''} after ${a.action}: ${a.reasons.join('; ')}` +
        `${log ? `\n    log: ${truncateMiddle(String(log).replace(/\s*\n\s*/g, ' | '), 300).text}` : ''}` +
        `${a.screenshot ? `\n    screenshot: ${a.screenshot}` : ''}`,
      );
    }
    if (anomalies.length > 10) lines.push(`  ... ${anomalies.length - 10} more in the report`);
  }
  lines.push(`report: ${reportPath}`);
  lines.push('Read the report\'s anomalies[].state and .before to see what led to each one; view screenshots with screen view.');
  return lines.join('\n');
}

// ----------------------------------------------------------------- plugin

export function describe({ settings, cfg }) {
  if (settings.url) return `laya-serve at ${settings.url}`;
  return `worker on ${findPython(settings, cfg?.cwd ?? process.cwd())}, preload ${preloadSpec(settings.preload) || 'lazy'}${settings.device ? `, device ${settings.device}` : ''}`;
}

export function createHandlers({ cfg, settings, redactor, secret }) {
  const python = findPython(settings, cfg.cwd);
  const backend = settings.url
    ? new HttpBackend({ url: settings.url, apiKey: secret(settings.apiKey ?? 'env:LAYA_API_KEY'), redactor })
    : new Worker({
      python,
      env: {
        LAYA_PRELOAD: preloadSpec(settings.preload),
        ...(settings.device ? { LAYA_DEVICE: settings.device } : {}),
        ...(settings.threads ? { LAYA_THREADS: String(settings.threads) } : {}),
      },
      log: (m) => process.stderr.write(`[terminalmcp] ${m}\n`),
    });
  // The worker holds gigabytes of weights; it must not outlive the server.
  process.once('exit', () => backend.stop());

  const inputHandlers = createInputHandlers({ cfg });
  const runs = new Map();
  let runSeq = 0;

  const questionsOf = (a) => {
    if (a.preset) return { preset: a.preset };
    if (!a.questions || typeof a.questions !== 'object' || !Object.keys(a.questions).length) {
      throw new Error('decide needs "questions" ({name: {type, instructions, criteria}}) or a "preset"');
    }
    return { questions: a.questions };
  };

  const renderRun = (run) => {
    if (run.status === 'running') {
      return `${run.id} RUNNING ${ms(Date.now() - run.started)}: ${run.steps} decisions, ${run.anomalies} anomalies so far`;
    }
    if (run.status === 'failed') return `${run.id} FAILED: ${run.error}`;
    return `${run.id} ${run.status.toUpperCase()}\n${renderPlaytest(run.result)}`;
  };

  return {
    async laya(a) {
      const action = a.action;
      const timeoutMs = a.timeout_ms ?? 120000;
      const cap = a.max_bytes ?? cfg.maxOutputBytes;

      switch (action) {
        case 'status': {
          const lines = [];
          if (settings.url) {
            const { result } = await backend.request('status', {}, timeoutMs);
            lines.push(`backend: laya-serve at ${result.url}`, `health: ${typeof result.health === 'string' ? result.health : JSON.stringify(result.health)}`);
          } else {
            lines.push(`backend: local worker, python ${python}`, `state: ${backend.state}${backend.error ? ` — ${backend.error}` : ''}`);
            if (backend.info) {
              lines.push(`laya ${backend.info.version ?? '?'} on ${backend.info.device ?? '?'}, loaded in ${ms(backend.info.load_ms ?? 0)}`);
            }
            lines.push(`preload: ${preloadSpec(settings.preload) || 'lazy'}`);
            if (backend.state === 'stopped' || backend.state === 'failed') {
              lines.push(`laya installed there: ${await probeInstalled(python)}`);
            }
          }
          if (backend.stats.decisions) {
            lines.push(`${backend.stats.decisions} decision(s), mean ${round(backend.stats.totalMs / backend.stats.decisions, 1)}ms in the model`);
          }
          const live = [...runs.values()].filter((r) => r.status === 'running');
          if (live.length) lines.push(`playtests running: ${live.map((r) => r.id).join(', ')}`);
          return lines.join('\n');
        }

        case 'start': {
          if (settings.url) return `nothing to start: decisions go to laya-serve at ${settings.url}`;
          const t0 = Date.now();
          const info = await backend.start(a.timeout_ms ?? 600000);
          return `Laya ${info.version ?? ''} ready on ${info.device ?? '?'} (${ms(Date.now() - t0)}; preload ${preloadSpec(settings.preload) || 'lazy'})`;
        }

        case 'stop': {
          for (const r of runs.values()) if (r.status === 'running') r.stopRequested = true;
          const was = backend.stop();
          return was === 'remote' ? 'laya-serve is remote; nothing to stop' : `worker stopped (was ${was}); memory released`;
        }

        case 'route': {
          if (a.state === undefined) throw new Error('route needs "state"');
          const { result } = await backend.request('route', { state: a.state, ...(a.questions || a.preset ? questionsOf(a) : {}) }, timeoutMs);
          return `${result.model}${result.repo ? ` (${result.repo})` : ''}: ${result.reason ?? ''}`;
        }

        case 'decide': {
          const q = questionsOf(a);
          const extra = a.model ? { model: a.model } : {};
          if (Array.isArray(a.states)) {
            if (!a.states.length) throw new Error('states is empty');
            const { result, ms: took } = await backend.request('predict_batch', { states: a.states, ...q, ...extra }, timeoutMs);
            if (a.raw) return truncateMiddle(JSON.stringify(result, null, 2), cap).text;
            const rows = result.map((r, i) =>
              `[${i + 1}] ${Object.entries(r?.answers ?? {}).map(([n, v]) => `${n}=${renderAnswer(v)}`).join(' | ')}`);
            return truncateMiddle(`${a.states.length} states in ${ms(took ?? 0)}\n${rows.join('\n')}`, cap).text;
          }
          if (a.state === undefined) throw new Error('decide needs "state" (or "states" for a batch)');
          const { result, ms: took } = await backend.request('predict', { state: a.state, ...q, ...extra }, timeoutMs);
          if (a.raw) return truncateMiddle(JSON.stringify(result, null, 2), cap).text;
          const via = result?.routing?.model ? `${result.routing.model}, ` : '';
          return `${renderResult(result)}\n(${via}${ms(took ?? 0)})`;
        }

        case 'playtest': {
          const run = {
            id: `pt${++runSeq}`, status: 'running', started: Date.now(), steps: 0, anomalies: 0,
            skippedFrames: 0, unfocused: 0, stopRequested: false, result: null, error: null,
          };
          const job = runPlaytest(a, { backend, cfg, inputHandlers, run })
            .then((res) => { run.result = res; run.status = run.stopRequested ? 'stopped' : 'done'; return res; })
            .catch((err) => { run.status = 'failed'; run.error = err.message; throw err; });
          run.done = job.catch(() => {});
          runs.set(run.id, run);
          if (a.background) {
            // Argument errors surface now, not on the first status call.
            await Promise.race([job, sleep(300)]).catch((err) => { throw err; });
            return `${run.id} started in the background. Check it with playtest_status { id: "${run.id}", wait_s: 60 }.`;
          }
          return renderPlaytest(await job);
        }

        case 'playtest_status': {
          const list = a.id ? [runs.get(a.id)] : [...runs.values()];
          if (a.id && !list[0]) throw new Error(`no playtest "${a.id}". Runs: ${[...runs.keys()].join(', ') || 'none'}`);
          if (!list.length) return 'no playtests in this session';
          if (a.wait_s && a.id) await Promise.race([list[0].done, sleep(Math.min(a.wait_s, 600) * 1000)]);
          return list.map(renderRun).join('\n\n');
        }

        case 'playtest_stop': {
          const run = runs.get(a.id);
          if (!run) throw new Error(`no playtest "${a.id}"`);
          run.stopRequested = true;
          await Promise.race([run.done, sleep(15000)]);
          return renderRun(run);
        }

        default:
          throw new Error(`Unknown laya action "${action}": status | start | stop | decide | route | playtest | playtest_status | playtest_stop`);
      }
    },
  };
}

/** Whether `python` can import laya, without loading any model. */
function probeInstalled(python) {
  return new Promise((resolve) => {
    execFile(python, ['-c', 'import laya; print(getattr(laya, "__version__", "?"))'], { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      // The last line: the package may print on import before the version.
      if (!err) return resolve(`yes, ${lastLines(stdout, 1)}`);
      if (err.code === 'ENOENT') return resolve(`no — "${python}" not found`);
      resolve(`no — ${lastLines(stderr || err.message, 1)}. Install: ${python} -m pip install laya`);
    });
  });
}

