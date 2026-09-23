// The laya plugin: the worker protocol, decide, and the playtest loop.
//
// Real Laya is torch plus gigabytes of weights, which no test suite should
// download. So the worker runs against a stub `laya` package with the same
// API — Router, predict, predict_batch, route, the *_questions presets — whose
// answers are deterministic. What is under test is everything around the
// model: that the worker keeps it resident and keeps stdout clean, that the
// plugin matches replies to requests, and that playtest reads the game,
// decides, answers, and reports what went wrong. The "game" is a real TCP
// server speaking the bridge protocol.

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { LogTail, expandPath, normaliseActions, parseBridge, preloadSpec, renderAnswer } from '../plugins/laya/plugin.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'bin', 'terminalmcp.js');

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failures.push(`${name} — ${detail}`); console.log(`  FAIL ${name} — ${detail}`); }
}

class Client {
  constructor(cwd, extraArgs = [], env = {}) {
    this.id = 0;
    this.pending = new Map();
    this.buf = '';
    this.proc = spawn(process.execPath, [ENTRY, '--cwd', cwd, ...extraArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => this._onData(d));
    this.stderr = '';
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => { this.stderr += d; });
  }
  _onData(d) {
    this.buf += d;
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const r = this.pending.get(msg.id);
      if (r) { this.pending.delete(msg.id); r(msg); }
    }
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async init() {
    await this.send('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'laya-test' } });
    return this;
  }
  async call(name, args) {
    const msg = await this.send('tools/call', { name, arguments: args });
    const content = msg.result?.content ?? [];
    return {
      text: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') || msg.error?.message || '',
      isError: Boolean(msg.result?.isError || msg.error),
    };
  }
  close() { this.proc.kill('SIGKILL'); }
}

// A stand-in for the real package: same surface, deterministic answers, and a
// print() to stdout on import — which the worker must keep off the protocol.
const STUB = `
import json
__version__ = "0.0-stub"
print("stub laya importing (this must not reach the protocol)")

def _pick(state, criteria):
    text = json.dumps(state) if not isinstance(state, str) else state
    for label in criteria:
        if label in text:
            return label
    return list(criteria)[0]

def _answer(state, q):
    t = q.get("type")
    if t == "choice":
        crit = q.get("criteria") or {}
        c = _pick(state, crit)
        probs = {k: (0.8 if k == c else round(0.2 / max(len(crit) - 1, 1), 3)) for k in crit}
        return {"choice": c, "confidence": 0.8, "probabilities": probs}
    if t == "score":
        return {"score": 1.0, "confidence": 0.6}
    if t == "noul":
        text = json.dumps(state)
        return {"noul": 0.9 if "bug" in text else 0.1}
    raise ValueError("question has no valid type: " + str(t))

class _Route:
    def __init__(self, model, reason):
        self.model = model
        self.repo = "stub/" + model
        self.reason = reason

class Router:
    def __init__(self, preload=False, **kw):
        self.kw = kw
        self._loaded = ["english", "multilingual", "typed-decisions"] if preload else []
    def preload(self, models):
        self._loaded = list(models)
    def route(self, state, questions=None):
        return _Route("english", "stub routes everything to english")
    def predict(self, state, questions, **kw):
        return {"answers": {n: _answer(state, q) for n, q in questions.items()},
                "routing": {"model": kw.get("model") or "english"}}
    def predict_batch(self, requests, **kw):
        return [self.predict(r["state"], r["questions"]) for r in requests]

def triage_questions():
    return {"urgent": {"type": "noul", "instructions": "Is it urgent?"}}
`;

// Just enough of Unreal's Python API for terminalmcp_bridge.py to run.
const UNREAL_FAKE = `
logs = []
callbacks = []
def log(m): logs.append(m)
def register_slate_post_tick_callback(fn):
    callbacks.append(fn); return fn
def unregister_slate_post_tick_callback(h):
    if h in callbacks: callbacks.remove(h)

class Vector:
    def __init__(self, x=0.0, y=0.0, z=0.0): self.x, self.y, self.z = x, y, z
    def __add__(self, o): return Vector(self.x + o.x, self.y + o.y, self.z + o.z)
    def __mul__(self, k): return Vector(self.x * k, self.y * k, self.z * k)
    def length(self): return (self.x ** 2 + self.y ** 2 + self.z ** 2) ** 0.5
class Rotator:
    def __init__(self): self.yaw, self.pitch, self.roll = 0.0, 0.0, 0.0

class Controller:
    def __init__(self): self.rot = Rotator()
    def get_control_rotation(self): return self.rot
    def set_control_rotation(self, r): self.rot = r
class Movement:
    def is_falling(self): return False
class Klass:
    def get_name(self): return "FakeCharacter"
class Pawn:
    def __init__(self):
        self.moves, self.jumped, self.stopped = 0, 0, 0
        self.controller, self.character_movement = Controller(), Movement()
    def get_actor_location(self): return Vector(100, 200, 300)
    def get_actor_rotation(self): return Rotator()
    def get_velocity(self): return Vector(0, 0, 0)
    def get_actor_forward_vector(self): return Vector(1, 0, 0)
    def get_actor_right_vector(self): return Vector(0, 1, 0)
    def add_movement_input(self, d, s, f): self.moves += 1
    def get_controller(self): return self.controller
    def jump(self): self.jumped += 1
    def stop_jumping(self): self.stopped += 1
    def get_class(self): return Klass()
    def get_world(self): return None
class World:
    def get_name(self): return "TestMap"

state = {"world": None, "pawn": Pawn()}
class UnrealEditorSubsystem: pass
class _Sub:
    def get_game_world(self): return state["world"]
def get_editor_subsystem(cls): return _Sub()
class GameplayStatics:
    @staticmethod
    def get_player_pawn(world, i): return state["pawn"]
class HitResult:
    blocking_hit = True
class TraceTypeQuery: TRACE_TYPE_QUERY1 = 0
class DrawDebugTrace: NONE = 0
class SystemLibrary:
    @staticmethod
    def line_trace_single(*a): return HitResult()
    @staticmethod
    def execute_console_command(*a): pass
`;

// Loads the bridge, then plays both sides: the editor's tick and the playtest's socket.
const UNREAL_DRIVE = `
import json, socket, sys, time, builtins
import unreal
path = sys.argv[1]
exec(open(path).read(), {"__name__": "bridge"})
b = builtins._terminalmcp_bridge
port = b.server.getsockname()[1]
print("LISTENING", port)
c = socket.create_connection(("127.0.0.1", port)); c.settimeout(0.05)
buf = b""
def tick(n=1, dt=0.05):
    for _ in range(n):
        for cb in list(unreal.callbacks): cb(dt)
        time.sleep(0.01)
def line():
    global buf
    for _ in range(100):
        if b"\\n" in buf: break
        tick()
        try: buf += c.recv(4096)
        except socket.timeout: pass
    l, _, buf = buf.partition(b"\\n")
    return l.decode()
print("NOTPLAYING", line())
unreal.state["world"] = unreal.World()
c.sendall(b'{"action":"wait"}\\n')
print("STATE", line())
c.sendall(b'{"action":"move_forward"}\\n')
tick(2)
c.setblocking(False)
try: early = c.recv(4096)
except BlockingIOError: early = b""
c.settimeout(0.05)
buf += early
nxt = line()
print("NEXT_AFTER_HOLD", "yes" if not early else "no")
print("MOVES", unreal.state["pawn"].moves)
c.sendall(b'{"action":"turn_left"}\\n'); line()
print("YAW", int(unreal.state["pawn"].controller.rot.yaw))
c.sendall(b'{"action":"jump"}\\n'); line()
print("JUMPED", unreal.state["pawn"].jumped, "STOPPED", unreal.state["pawn"].stopped)
first = builtins._terminalmcp_bridge
exec(open(path).read(), {"__name__": "bridge"})
print("REPLACED", "yes" if builtins._terminalmcp_bridge is not first and len(unreal.callbacks) == 1 else "no")
builtins.terminalmcp_bridge_stop()
`;

function findPython() {
  for (const cmd of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    const r = spawnSync(cmd, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

/**
 * The game side of the bridge: listens, sends a state line per tick, reads the
 * action back. The player walks until tick 12 and then stands still (stuck);
 * tick 5 onwards reports the same exception every frame (one bug, many frames).
 */
function startGame() {
  const got = [];
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let tick = 0;
    let buf = '';
    const sendState = () => {
      tick++;
      const x = Math.min(tick, 12);
      const state = {
        pos: [x, 0, 0],
        has_exception: tick >= 5 && tick <= 7,
        last_log: tick >= 5 && tick <= 7 ? 'NullReferenceException at Door.cs:42' : '',
        hint: tick === 3 ? 'jump' : '',
      };
      sock.write(`${JSON.stringify(state)}\n`);
    };
    sock.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        got.push(JSON.parse(line));
        sendState();
      }
    });
    sock.on('error', () => {});
    sendState();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, got })));
}

async function main() {
  console.log('\n--- pure helpers ---');
  {
    check('a bridge port alone means localhost', JSON.stringify(parseBridge(9000)) === '{"host":"127.0.0.1","port":9000}');
    check('host:port parses', JSON.stringify(parseBridge('10.0.0.2:8080')) === '{"host":"10.0.0.2","port":8080}');
    check('preload defaults to the English checkpoint', preloadSpec(undefined) === 'english' && preloadSpec(true) === 'all' && preloadSpec(false) === '');
    check('a choice renders with its runner-up',
      renderAnswer({ choice: 'billing', confidence: 0.9, probabilities: { billing: 0.94, tech: 0.04, other: 0.002 } }) === 'billing 0.94 (tech 0.04, other <0.01), conf 0.9');
    check('a noul renders as a probability', renderAnswer({ noul: 0.8921 }) === 'P(yes)=0.89');
    check('a score names its nearest level (real Laya shape)',
      renderAnswer({ type: 'score', score: 1.2919, legend: { 0: 'not urgent', 1: 'soon', 2: 'critical' }, confidence: 0.196 }) === '1.29 ~ soon (conf 0.2)');
    const acts = normaliseActions({ move_forward: 'walk ahead', jump: { description: 'jump', input: 'key space' } });
    check('actions take either spelling', acts.move_forward.description === 'walk ahead' && acts.jump.steps[0] === 'key space');
    check('a list of names gets readable descriptions', normaliseActions(['turn_left', 'jump']).turn_left.description === 'turn left');
    let err = null;
    try { normaliseActions({ yes: 'a', no: 'b' }); } catch (e) { err = e.message; }
    check('boolean-looking action names are refused', /reads as a boolean/.test(err ?? ''), String(err));
    err = null;
    try { normaliseActions({ a: { input: 'dance' }, b: 'x' }); } catch (e) { err = e.message; }
    check('a bad input shorthand is refused with the action named', /action "a" input\[0\]/.test(err ?? ''), String(err));
  }

  {
    process.env.TMCP_TEST_DIR = 'X:/games';
    check('%VAR% in a log path is expanded', expandPath('%TMCP_TEST_DIR%/mc/latest.log') === 'X:/games/mc/latest.log');
    const tmp = await mkdtemp(join(tmpdir(), 'tmcp-logtail-'));
    const f = join(tmp, 'latest.log');
    await writeFile(f, 'boot ERROR that happened earlier\n');
    const tail = new LogTail(f);
    check('a log is followed from its end', (await tail.lines()).length === 0);
    await writeFile(f, 'boot ERROR that happened earlier\n[Render thread/ERROR]: Exception in tick\nhalf a li');
    const got = await tail.lines();
    check('...returning only complete new lines', got.length === 1 && /Exception in tick/.test(got[0]), JSON.stringify(got));
    check('...and the default pattern knows an error when it sees one', tail.re.test(got[0]) && !tail.re.test('[Render thread/INFO]: loaded'));
    await writeFile(f, 'fresh\n');
    check('a log that was rotated starts over', (await tail.lines()).join() === 'fresh', 'rotation');
    await rm(tmp, { recursive: true, force: true });
  }

  const python = findPython();
  if (!python) {
    console.log('\n  (worker tests skipped: no python on PATH)');
    return finish();
  }

  console.log('\n--- the Unreal bridge, against a fake `unreal` module ---');
  {
    // The bridge runs inside the editor, which a test suite cannot start. So
    // `unreal` is faked just far enough for its logic to run for real: the
    // socket, the tick, the state it reports and what it does to the pawn.
    const fakeDir = await mkdtemp(join(tmpdir(), 'tmcp-unreal-'));
    await writeFile(join(fakeDir, 'unreal.py'), UNREAL_FAKE);
    await writeFile(join(fakeDir, 'drive.py'), UNREAL_DRIVE);
    const bridgePath = join(ROOT, 'plugins', 'laya', 'bridges', 'unreal', 'terminalmcp_bridge.py');
    const r = spawnSync(python, [join(fakeDir, 'drive.py'), bridgePath], {
      encoding: 'utf8', env: { ...process.env, PYTHONPATH: fakeDir, TERMINALMCP_BRIDGE_PORT: '0' }, timeout: 30000,
    });
    const out = r.stdout ?? '';
    check('the bridge loads and listens', /LISTENING/.test(out), out + r.stderr);
    check('before Play it reports playing:false', /NOTPLAYING {"playing": false}/.test(out), out);
    check('during Play it reports the pawn in metres', /STATE .*"pos": \[1\.0, 2\.0, 3\.0\]/.test(out) && /"playing": true/.test(out), out);
    check('...with a wall probe', /"wall_ahead": true/.test(out), out);
    check('a move is re-applied every tick for the hold', /MOVES [3-9]/.test(out), out);
    check('...and the next state only comes after it', /NEXT_AFTER_HOLD yes/.test(out), out);
    check('turn_left rotates the control rotation', /YAW -30/.test(out), out);
    check('jump jumps and lets go', /JUMPED 1 STOPPED 1/.test(out), out);
    check('running it again replaces the old bridge', /REPLACED yes/.test(out), out);
    await rm(fakeDir, { recursive: true, force: true }).catch(() => {});
  }

  const dir = await mkdtemp(join(tmpdir(), 'tmcp-laya-'));
  const stubDir = join(dir, 'stub');
  await mkdir(join(stubDir, 'laya'), { recursive: true });
  await writeFile(join(stubDir, 'laya', '__init__.py'), STUB);
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ pluginConfig: { laya: { python, preload: ['english'] } } }));
  const env = { TERMINALMCP_CONFIG: configPath, PYTHONPATH: stubDir };

  const c = await new Client(dir, ['--tools', 'minimal', '--plugin', 'laya'], env).init();
  const game = await startGame();
  try {
    console.log('\n--- the worker ---');
    let r = await c.call('laya', { action: 'status' });
    check('status before start says stopped', /state: stopped/.test(r.text), r.text);
    check('...and whether laya is importable there', /laya installed there: yes, 0\.0-stub/.test(r.text), r.text);

    r = await c.call('laya', { action: 'start' });
    check('start brings the worker up', !r.isError && /0\.0-stub ready/.test(r.text), r.text);
    check('...despite the library printing to stdout on import', !/must not reach/.test(r.text), r.text);

    r = await c.call('laya', {
      action: 'decide',
      state: { body: 'billing problem: billed twice, please refund' },
      questions: {
        department: { type: 'choice', instructions: 'Which team?', criteria: { tech: 'bugs', billing: 'refunds, billed charges' } },
        urgency: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'mid', 'high'] },
        bug: { type: 'noul', instructions: 'Is it a bug?' },
      },
    });
    check('decide answers every question', !r.isError && /department\s+billing 0\.8/.test(r.text) && /urgency\s+1 \(conf 0\.6\)/.test(r.text) && /bug\s+P\(yes\)=0\.1/.test(r.text), r.text);
    check('...and says which checkpoint answered', /\(english, /.test(r.text), r.text);

    r = await c.call('laya', { action: 'decide', states: ['a bug here', 'all fine'], questions: { bug: { type: 'noul', instructions: 'Bug?' } } });
    check('a batch answers each state in order', /\[1\] bug=P\(yes\)=0\.9/.test(r.text) && /\[2\] bug=P\(yes\)=0\.1/.test(r.text), r.text);

    r = await c.call('laya', { action: 'decide', state: 'server down!', preset: 'triage' });
    check('a preset supplies the questions', !r.isError && /urgent/.test(r.text), r.text);

    r = await c.call('laya', { action: 'decide', state: 'x', questions: { q: { type: 'essay' } } });
    check('a bad question is Laya\'s error, reported', r.isError && /question has no valid type/.test(r.text), r.text);
    r = await c.call('laya', { action: 'decide', state: 'still alive?', questions: { bug: { type: 'noul' } } });
    check('...and the worker survives it', !r.isError, r.text);

    r = await c.call('laya', { action: 'decide', state: 'x' });
    check('decide without questions says what it needs', r.isError && /needs "questions"/.test(r.text), r.text);

    r = await c.call('laya', { action: 'route', state: 'hello' });
    check('route explains the choice of checkpoint', /english \(stub\/english\): stub routes/.test(r.text), r.text);

    console.log('\n--- playtest over a TCP bridge ---');
    const report = join(dir, 'report.json');
    r = await c.call('laya', {
      action: 'playtest',
      bridge: game.port,
      actions: { move_forward: 'walk ahead', jump: 'jump over things', turn_left: 'turn left' },
      questions: { bug: { type: 'noul', instructions: 'Does this look like a bug?' } },
      max_steps: 25,
      tick_ms: 0,
      epsilon: 0,
      stuck: { ticks: 5 },
      report,
    });
    check('a playtest runs to max_steps', !r.isError && /PLAYTEST 25 decisions/.test(r.text) && /max_steps reached/.test(r.text), r.text);
    check('every decision reached the game', game.got.length === 25, String(game.got.length));
    check('...as {"action": name}', game.got.every((g) => ['move_forward', 'jump', 'turn_left'].includes(g.action)), JSON.stringify(game.got.slice(0, 3)));
    check('Laya\'s pick is what was sent (tick 3 hinted jump)', game.got[2]?.action === 'jump', JSON.stringify(game.got.slice(0, 4)));
    check('the repeated exception is one anomaly, counted', /x3 after/.test(r.text) && /Door\.cs:42/.test(r.text), r.text);
    check('standing still is caught as stuck', /stuck: pos unchanged for 5 ticks/.test(r.text), r.text);
    check('the report path is given', r.text.includes(report), r.text);
    const rep = JSON.parse(await readFile(report, 'utf8'));
    check('the report has the anomalies', rep.anomalies.length === 2, JSON.stringify(rep.anomalies.map((a) => a.reasons)));
    check('...each with the ticks before it', rep.anomalies[0].before.length > 0 && rep.anomalies[0].before[0].state.pos !== undefined, JSON.stringify(rep.anomalies[0].before));
    check('...the answers of that tick', rep.anomalies[0].answers.bug?.noul !== undefined, JSON.stringify(rep.anomalies[0].answers));
    check('...and a summary with the action histogram', rep.summary.steps === 25 && rep.summary.actions.jump >= 1, JSON.stringify(rep.summary));

    r = await c.call('laya', {
      action: 'playtest', bridge: game.port, actions: ['move_forward', 'jump'], max_steps: 50, tick_ms: 0, epsilon: 0,
      anomaly: 'state.has_exception', stop_on_anomaly: true, report: join(dir, 'r2.json'),
    });
    check('stop_on_anomaly ends at the first one', /anomaly at step 5/.test(r.text), r.text);

    console.log('\n--- playtest refuses bad setups before acting ---');
    const before = game.got.length;
    r = await c.call('laya', { action: 'playtest', actions: ['a1', 'b1'] });
    check('no state source', r.isError && /exactly one state source/.test(r.text), r.text);
    r = await c.call('laya', { action: 'playtest', state_file: 'x.json', actions: ['a1', 'b1'] });
    check('no bridge and no input on the actions', r.isError && /every action needs "input"/.test(r.text), r.text);
    r = await c.call('laya', { action: 'playtest', bridge: game.port, actions: ['a1', 'b1'], anomaly: 'state.x ==' });
    check('a broken anomaly rule', r.isError && /anomaly "state\.x =="/.test(r.text), r.text);
    r = await c.call('laya', { action: 'playtest', bridge: 1, actions: ['a1', 'b1'], max_steps: 1 });
    check('nothing listening on the bridge port', r.isError && /nothing is listening/.test(r.text), r.text);
    check('...and none of these sent anything', game.got.length === before, `${game.got.length} vs ${before}`);

    console.log('\n--- playtest from a state file, acting through input_bulk ---');
    const stateFile = join(dir, 'state.json');
    await writeFile(stateFile, JSON.stringify({ pos: [1, 2, 3], hint: 'crouch' }));
    r = await c.call('laya', {
      action: 'playtest', state_file: stateFile, max_steps: 3, tick_ms: 0, epsilon: 0,
      // "wait" steps: exercised through input_bulk without touching the desktop.
      actions: { crouch: { description: 'crouch', input: 'wait 1' }, stand: { description: 'stand', input: ['wait 1', 'wait 1'] } },
      report: join(dir, 'r3.json'),
    });
    check('a file-fed playtest acts through input steps', !r.isError && /PLAYTEST 3 decisions/.test(r.text) && /crouch=3/.test(r.text), r.text);

    console.log('\n--- in the background ---');
    r = await c.call('laya', { action: 'playtest', bridge: game.port, actions: ['move_forward', 'jump'], duration_s: 30, tick_ms: 20, background: true, report: join(dir, 'r4.json') });
    const id = (r.text.match(/^(pt\d+) started/) ?? [])[1];
    check('background returns an id at once', Boolean(id), r.text);
    r = await c.call('laya', { action: 'playtest_status', id });
    check('status reports progress', /RUNNING/.test(r.text), r.text);
    r = await c.call('laya', { action: 'playtest_stop', id });
    check('stop ends it and returns the summary', /STOPPED/.test(r.text) && /PLAYTEST \d+ decisions/.test(r.text), r.text);

    console.log('\n--- an editor bridge before Play, and a game log ---');
    {
      // Reports {"playing": false} twice (the editor is open, Play not pressed),
      // then plays; and writes an error into its log on tick 2 of play.
      const logPath = join(dir, 'game.log');
      await writeFile(logPath, 'old line: ERROR from before the playtest\n');
      let waits = 0;
      const played = [];
      const editor = net.createServer((sock) => {
        sock.setEncoding('utf8');
        let n = 0;
        let b = '';
        const next = () => {
          if (waits < 2) { waits++; sock.write('{"playing":false}\n'); return; }
          n++;
          if (n === 2) writeFile(logPath, 'old line: ERROR from before the playtest\nLogScript: Warning: Accessed None trying to read Door\n');
          sock.write(`${JSON.stringify({ playing: true, pos: [n, 0, 0] })}\n`);
        };
        sock.on('data', (d) => {
          b += d;
          let nl;
          while ((nl = b.indexOf('\n')) !== -1) { played.push(JSON.parse(b.slice(0, nl)).action); b = b.slice(nl + 1); next(); }
        });
        sock.on('error', () => {});
        next();
      });
      await new Promise((res) => editor.listen(0, '127.0.0.1', res));
      r = await c.call('laya', {
        action: 'playtest', bridge: editor.address().port, actions: ['move_forward', 'turn_left'], max_steps: 5, tick_ms: 30, epsilon: 0,
        log_file: logPath, error_pattern: 'Error:|Accessed None', report: join(dir, 'r5.json'),
      });
      editor.close();
      check('waiting for Play is not counted as decisions', /PLAYTEST 5 decisions/.test(r.text), r.text);
      check('...and the editor was told to wait meanwhile', played.slice(0, 2).every((a) => a === 'wait'), JSON.stringify(played));
      check('an error written to the log during play is an anomaly', /Accessed None trying to read Door/.test(r.text), r.text);
      check('...but what was logged before the playtest is not', !/from before the playtest/.test(r.text), r.text);
    }

    console.log('\n--- adaptive exploration ---');
    {
      // A game where the player never moves: the zero-shot pick would repeat
      // for ever; standing still must push towards other actions.
      const still = net.createServer((sock) => {
        sock.setEncoding('utf8');
        let b = '';
        sock.on('data', (d) => { b += d; while (b.includes('\n')) { b = b.slice(b.indexOf('\n') + 1); sock.write('{"pos":[0,0,0]}\n'); } });
        sock.on('error', () => {});
        sock.write('{"pos":[0,0,0]}\n');
      });
      await new Promise((res) => still.listen(0, '127.0.0.1', res));
      r = await c.call('laya', {
        action: 'playtest', bridge: still.address().port, actions: ['move_forward', 'turn_left', 'turn_right'], max_steps: 60, tick_ms: 0,
        epsilon: 0, stuck: { ticks: 10 }, report: join(dir, 'r6.json'),
      });
      still.close();
      const other = Number((r.text.match(/turn_left=(\d+)/) ?? [])[1]) + Number((r.text.match(/turn_right=(\d+)/) ?? [])[1]);
      check('a stuck player gets other actions tried, even at epsilon 0', other >= 5, r.text);
    }

    r = await c.call('laya', { action: 'stop' });
    check('stop releases the worker', /worker stopped \(was ready\)/.test(r.text), r.text);
    r = await c.call('laya', { action: 'decide', state: 'back?', questions: { bug: { type: 'noul', instructions: 'Bug?' } } });
    check('...and decide starts it again on demand', !r.isError && /bug/.test(r.text), r.text);
  } finally {
    c.close();
    game.server.close();
  }

  console.log('\n--- policy and setup failures ---');
  {
    const ro = await new Client(dir, ['--tools', 'minimal', '--plugin', 'laya', '--read-only'], env).init();
    try {
      let r = await ro.call('laya', { action: 'playtest', bridge: 9, actions: ['a1', 'b1'] });
      check('readOnly refuses playtest', r.isError && /readOnly/.test(r.text), r.text);
      r = await ro.call('laya', { action: 'decide', state: 'x', questions: { bug: { type: 'noul', instructions: 'Bug?' } } });
      check('...but decide is inference, and still answers', !r.isError, r.text);
    } finally { ro.close(); }

    const noPyCfg = join(dir, 'nopy.json');
    await writeFile(noPyCfg, JSON.stringify({ pluginConfig: { laya: { python: join(dir, 'no-such-python.exe') } } }));
    const c2 = await new Client(dir, ['--tools', 'minimal', '--plugin', 'laya'], { TERMINALMCP_CONFIG: noPyCfg }).init();
    try {
      const r = await c2.call('laya', { action: 'decide', state: 'x', questions: { bug: { type: 'noul', instructions: 'Bug?' } } });
      check('a missing python says where to point it', r.isError && /Python not found/.test(r.text) && /pluginConfig\.laya\.python/.test(r.text), r.text);
    } finally { c2.close(); }

    const bare = join(dir, 'bare.json');
    await writeFile(bare, JSON.stringify({ pluginConfig: { laya: { python } } }));
    const c3 = await new Client(dir, ['--tools', 'minimal', '--plugin', 'laya'], { TERMINALMCP_CONFIG: bare, PYTHONPATH: '' }).init();
    try {
      const r = await c3.call('laya', { action: 'start' });
      const realLaya = !r.isError;
      check('a python without laya says how to install it', realLaya || (/does not have laya/.test(r.text) && /pip install laya/.test(r.text)), r.text);
    } finally { c3.close(); }
  }

  await rm(dir, { recursive: true, force: true }).catch(() => {});
  return finish();
}

function finish() {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('test harness crashed:', err);
  process.exit(1);
});
