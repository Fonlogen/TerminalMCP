// The `input` tool: the key table, the guards, and — where there is an X
// display to be had — real injected input, checked at the protocol level.
//
// The oracle is `xev -root`. With no window manager and nothing else on the
// display, X delivers pointer and key events to the root window, so xev prints
// exactly what was injected: which button, at which coordinates, which keysym,
// with which modifiers held. That is a much better witness than an application
// that might have swallowed the event for its own reasons.

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import process from 'node:process';
import {
  KEYS,
  MODIFIERS,
  appleScriptChord,
  describeChord,
  parseChord,
  parseChords,
  jxaPointerScript,
  xdotoolChord,
  WINDOWS_INPUT_SCRIPT,
} from '../src/input.js';
import { explainWindowsFailure, sessionType } from '../src/screen.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'bin', 'terminalmcp.js');

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failures.push(`${name} — ${detail}`); console.log(`  FAIL ${name} — ${detail}`); }
}

class Client {
  constructor(cwd, extraArgs = [], extraEnv = {}) {
    this.id = 0;
    this.pending = new Map();
    this.buf = '';
    this.proc = spawn(process.execPath, [ENTRY, '--cwd', cwd, ...extraArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERMINALMCP_CONFIG: join(cwd, 'no-such-config.json'), ...extraEnv },
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => this._onData(d));
    this.stderr = '';
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => { this.stderr += d; });
  }

  _onData(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const resolve = this.pending.get(msg.id);
      if (resolve) { this.pending.delete(msg.id); resolve(msg); }
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
    await this.send('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'input-test' } });
    return this;
  }

  async call(name, args) {
    const msg = await this.send('tools/call', { name, arguments: args });
    const content = msg.result?.content ?? [];
    return {
      text: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
      images: content.filter((c) => c.type === 'image'),
      isError: Boolean(msg.result?.isError),
      error: msg.error,
    };
  }

  close() { this.proc.kill('SIGKILL'); }
}

function onPathSync(name) {
  return (process.env.PATH || '').split(':').some((d) => d && existsSync(join(d, name)));
}

/** A display with nothing on it, so the root window receives everything. */
async function startX() {
  if (process.platform !== 'linux' || !onPathSync('Xvfb') || !onPathSync('xdpyinfo')) return null;
  if (!onPathSync('xdotool') || !onPathSync('xev')) return null;
  for (let n = 90; n <= 99; n++) {
    const display = `:${n}`;
    if (existsSync(`/tmp/.X${n}-lock`) || existsSync(`/tmp/.X11-unix/X${n}`)) continue;
    const proc = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], {
      stdio: 'ignore',
      detached: true,
    });
    proc.unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const probe = spawnSync('xdpyinfo', [], { env: { ...process.env, DISPLAY: display }, stdio: 'ignore' });
      if (probe.status === 0) return { display, proc };
      if (proc.exitCode !== null) break;
    }
    try { proc.kill('SIGTERM'); } catch { /* gone */ }
  }
  return null;
}

/** Watch what actually arrives at the X server. */
class Witness {
  constructor(display) {
    this.log = '';
    this.proc = spawn('xev', ['-root'], { env: { ...process.env, DISPLAY: display }, stdio: ['ignore', 'pipe', 'ignore'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => { this.log += d; });
  }

  /** Forget everything so far; the next read sees only what follows. */
  reset() { this.log = ''; }

  /** Events since the last reset, parsed into something assertable. */
  async events() {
    // xev writes a line at a time; give the last event a moment to arrive.
    await new Promise((r) => setTimeout(r, 400));
    const out = [];
    let cur = null;
    for (const line of this.log.split('\n')) {
      const head = line.match(/^(\w+) event,/);
      if (head) {
        if (cur) out.push(cur);
        cur = { type: head[1], raw: line };
        continue;
      }
      if (!cur) continue;
      cur.raw += `\n${line}`;
      const root = line.match(/root:\((-?\d+),(-?\d+)\)/);
      if (root) { cur.x = Number(root[1]); cur.y = Number(root[2]); }
      const button = line.match(/state (0x[0-9a-f]+), button (\d+)/);
      if (button) { cur.state = Number(button[1]); cur.button = Number(button[2]); }
      const key = line.match(/state (0x[0-9a-f]+), keycode (\d+) \(keysym (0x[0-9a-f]+), ([^)]+)\)/);
      if (key) { cur.state = Number(key[1]); cur.keysym = key[4]; }
    }
    if (cur) out.push(cur);
    return out;
  }

  close() { try { this.proc.kill('SIGKILL'); } catch { /* gone */ } }
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'tmcp-input-'));
  const session = sessionType();
  console.log(`\nGraphical session: ${session ?? 'none (headless)'}`);

  const c = await new Client(dir, ['--tools', 'core,input']).init();
  try {
    console.log('\n--- the key table and the chord parser ---');
    {
      check('a named key resolves', parseChord('enter').vk === 0x0d && parseChord('enter').keysym === 'Return');
      check('case does not matter', parseChord('F5').key === 'f5' && parseChord('f5').vk === 0x74);
      check('an alias resolves to the real name', parseChord('esc').key === 'escape' && parseChord('pgup').key === 'pageup');
      check('a modifier chord keeps its order', describeChord(parseChord('ctrl+shift+p')) === 'ctrl+shift+p');
      check('modifier aliases are accepted', describeChord(parseChord('control+opt+a')) === 'ctrl+alt+a');
      check('cmd and super mean the same key', parseChord('cmd+c').mods[0] === 'win' && parseChord('super+c').mods[0] === 'win');
      check('a duplicate modifier is not sent twice', parseChord('ctrl+ctrl+a').mods.length === 1);
      check('a single character is a key', parseChord('a').char === 'a' && parseChord('7').char === '7');
      check('plus is a key, not a separator', parseChord('+').char === '+', JSON.stringify(parseChord('+')));
      check('...even with a modifier', describeChord(parseChord('ctrl++')) === 'ctrl++', describeChord(parseChord('ctrl++')));
      check('a modifier alone can be pressed', parseChord('ctrl').vk === 0x11 && parseChord('ctrl').mods.length === 0);
      check('an extended key is marked as one', parseChord('left').ext === true && parseChord('delete').ext === true);
      check('a normal key is not', parseChord('a').ext === false && parseChord('enter').ext === false);

      let err = null;
      try { parseChord('escp'); } catch (e) { err = e.message; }
      check('a misspelled key is refused', Boolean(err), String(err));
      check('...with a suggestion', /did you mean escape/i.test(err ?? ''), String(err));
      err = null;
      try { parseChord('hello'); } catch (e) { err = e.message; }
      check('a word is refused, pointing at type instead', /action "type"/.test(err ?? ''), String(err));
      err = null;
      try { parseChord('hyper+a'); } catch (e) { err = e.message; }
      check('an unknown modifier names the real ones', /is not a modifier/.test(err ?? '') && /ctrl, shift, alt, win/.test(err ?? ''), String(err));
      err = null;
      try { parseChord(''); } catch (e) { err = e.message; }
      check('an empty chord is refused', /cannot be empty/.test(err ?? ''), String(err));

      check('a sequence is several chords', parseChords('ctrl+a ctrl+c').map(describeChord).join('|') === 'ctrl+a|ctrl+c');
      check('commas separate a sequence too', parseChords('f1, f2').length === 2);

      const gaps = Object.entries(KEYS).filter(([, k]) => typeof k.vk !== 'number' || typeof k.keysym !== 'string');
      check('every named key has a VK and a keysym', gaps.length === 0, gaps.map(([n]) => n).join(','));
      const dupes = Object.entries(KEYS).filter(([n, k], i, all) => all.findIndex(([, o]) => o.vk === k.vk) !== i);
      check('no two named keys share a virtual-key code', dupes.length === 0, dupes.map(([n]) => n).join(','));
    }

    console.log('\n--- the same chord, spelled for each platform ---');
    {
      check('xdotool gets keysym names', xdotoolChord(parseChord('ctrl+pgup')) === 'ctrl+Prior');
      check('...and punctuation becomes a keysym name', xdotoolChord(parseChord('ctrl++')) === 'ctrl+plus');
      check('...and a letter stays a letter', xdotoolChord(parseChord('ctrl+shift+s')) === 'ctrl+shift+s');
      check('AppleScript gets keystroke for characters', appleScriptChord(parseChord('cmd+s')) === 'keystroke "s" using {command down}');
      check('...and a key code for named keys', appleScriptChord(parseChord('f5')) === 'key code 96');
      check('...quoting what needs quoting', appleScriptChord(parseChord('"')) === 'keystroke "\\""', appleScriptChord(parseChord('"')));
      let err = null;
      try { appleScriptChord(parseChord('f24')); } catch (e) { err = e.message; }
      check('a key macOS has no code for says so', /no key code/.test(err ?? ''), String(err));
      check('every modifier has all three spellings',
        Object.values(MODIFIERS).every((m) => typeof m.vk === 'number' && m.keysym && m.mac));
    }

    console.log('\n--- the Windows script ---');
    {
      const bad = WINDOWS_INPUT_SCRIPT.split('\n').filter((l) => l.trim() === "'@" && l !== "'@");
      check('every here-string terminator is at column 0', bad.length === 0, JSON.stringify(bad));
      check('it uses SendInput, not the legacy wrappers', /SendInput/.test(WINDOWS_INPUT_SCRIPT) && !/keybd_event|mouse_event/.test(WINDOWS_INPUT_SCRIPT));
      check('keys carry a scan code as well as a virtual key', /MapVirtualKey/.test(WINDOWS_INPUT_SCRIPT));
      check('text is typed as unicode, not as keystrokes', /UNICODE/.test(WINDOWS_INPUT_SCRIPT) && /TypeUnicode/.test(WINDOWS_INPUT_SCRIPT));
      check('absolute moves span the whole virtual desktop', /VIRTUALDESK/.test(WINDOWS_INPUT_SCRIPT));
      check('no parameter is short enough to be ambiguous',
        !/\[(string|int)\]\$(Out|W|H|D|T|A|C)\b/.test(WINDOWS_INPUT_SCRIPT),
        (WINDOWS_INPUT_SCRIPT.match(/\[(string|int)\]\$\w+/g) || []).join(' '));
      const stages = [...new Set([...WINDOWS_INPUT_SCRIPT.matchAll(/Fail '([a-z]+)'/g)].map((m) => m[1]))];
      check('it reports distinct failure stages', stages.length >= 3, stages.join(','));
      const vague = stages.filter((stage) => /failed at stage/.test(explainWindowsFailure({ stage, type: 'T', message: 'm' }, { what: 'Input' })));
      check('every stage it can report is explained', vague.length === 0, vague.join(','));
      check('the explainer speaks for input, not capture',
        /^Input failed/.test(explainWindowsFailure({ stage: 'zzz', message: 'x' }, { what: 'Input' })),
        explainWindowsFailure({ stage: 'zzz', message: 'x' }, { what: 'Input' }));
    }

    console.log('\n--- macOS: the pointer goes through CoreGraphics, not System Events ---');
    {
      // `tell application "System Events" to click at {x, y}` asks the target
      // application to click for itself, and when the point resolves to no UI
      // element it can simply never answer — no error, no refusal, just an
      // Apple event that hangs until something kills it. It must not come back.
      const source = await readFile(new URL('../src/input.js', import.meta.url), 'utf8');
      // Comments may name the old call — explaining it is the point. Code may not.
      const code = source
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n');
      check('nothing clicks through System Events any more', !/click at \{/.test(code),
        (code.match(/.*click at \{.*/) ?? [''])[0]);

      const click = jxaPointerScript({ op: 'click', absolute: true, x: 470, y: 930, button: 'right', count: 2 });
      check('a click posts a CGEvent', /CGEventPost/.test(click) && /CGEventCreateMouseEvent/.test(click), click.slice(0, 120));
      check('...to the HID event tap, where a real mouse posts', /kCGHIDEventTap/.test(click));
      check('...with the coordinates asked for', /"x":470/.test(click) && /"y":930/.test(click), click.slice(0, 300));
      check('...the button asked for', /"button":"right"/.test(click));
      check('...and the click count, so a double click is one', /"count":2/.test(click) && /kCGMouseEventClickState/.test(click));
      check('it imports CoreGraphics itself', /ObjC\.import\('CoreGraphics'\)/.test(click));
      check('it answers in JSON rather than by exit code', /JSON\.stringify\(out\)/.test(click));
      check('...and reports a failure instead of throwing at osascript', /ok: false, error/.test(click));

      const move = jxaPointerScript({ op: 'move', absolute: false, dx: 10, dy: -5 });
      check('a relative move carries its offsets', /"dx":10/.test(move) && /"dy":-5/.test(move));
      check('...and moves rather than clicks', /kCGEventMouseMoved/.test(move));

      const drag = jxaPointerScript({ op: 'drag', absolute: true, x: 1, y: 2, toX: 30, toY: 40, button: 'left', steps: 12 });
      check('a drag presses, moves and releases', /kCGEventLeftMouseDown/.test(drag) && /drag/.test(drag) && /kCGEventLeftMouseUp/.test(drag));
      check('...in steps, so it is not a teleport', /o\.steps/.test(drag) && /"steps":12/.test(drag));

      const scroll = jxaPointerScript({ op: 'scroll', absolute: false, amount: 3, horizontal: false });
      check('scrolling is a real wheel event', /CGEventCreateScrollWheelEvent/.test(scroll));
      check('...in lines, the unit a wheel click is', /kCGScrollEventUnitLine/.test(scroll));

      check('every op the code sends is handled by the script',
        ['position', 'move', 'click', 'drag', 'scroll'].every((op) => jxaPointerScript({ op }).includes(`o.op === '${op}'`)));

      // Anything still going through System Events must carry a deadline: an
      // Apple event waits two minutes by default, which reads as a hang.
      check('System Events calls are given a timeout of their own', /with timeout of \$\{seconds\} seconds/.test(source), 'no with-timeout guard');
      check('...and a hang is explained as such', /never answered/.test(source));
      check('...pointing at the one-liner that settles it', /UI elements enabled/.test(source));
    }

    console.log('\n--- arguments and guards ---');
    {
      let r = await c.call('input', {});
      check('a missing action is reported', r.isError && /needs "action"/.test(r.text), r.text);

      r = await c.call('input', { action: 'wiggle' });
      check('an unknown action lists the real ones', r.isError && /move \| click \| drag/.test(r.text), r.text);

      r = await c.call('input', { action: 'key' });
      check('key without keys says what it needs', r.isError && /needs "keys"/.test(r.text), r.text);

      r = await c.call('input', { action: 'type' });
      check('type without text says what it needs', r.isError && /needs "text"/.test(r.text), r.text);

      r = await c.call('input', { action: 'key', keys: 'ctrl+nope' });
      check('a bad chord is refused before anything is sent', r.isError && /not a key/.test(r.text), r.text);

      r = await c.call('input', { action: 'click', button: 'thumb' });
      check('an unknown button is refused', r.isError && /left, middle or right/.test(r.text), r.text);

      r = await c.call('input', { action: 'drag', x: 1, y: 1 });
      check('a drag with no destination is refused', r.isError && /to_x and to_y/.test(r.text), r.text);
    }

    console.log('\n--- readOnly may look, but not touch ---');
    {
      const ro = await new Client(dir, ['--tools', 'core,input', '--read-only']).init();
      try {
        for (const action of ['move', 'click', 'drag', 'scroll', 'type', 'key', 'focus']) {
          const r = await ro.call('input', { action, x: 10, y: 10, text: 'x', keys: 'a', window: 'w', to_x: 1, to_y: 1 });
          check(`readOnly refuses ${action}`, r.isError && /readOnly/.test(r.text), r.text.slice(0, 120));
        }
        const r = await ro.call('input', { action: 'probe' });
        check('...but probe still answers', !r.isError, r.text.slice(0, 120));
      } finally {
        ro.close();
      }
    }

    if (!session) {
      console.log('\n--- no desktop here: input must refuse clearly ---');
      for (const args of [{ action: 'move', x: 1, y: 1 }, { action: 'click' }, { action: 'type', text: 'x' }, { action: 'key', keys: 'a' }, { action: 'position' }]) {
        const r = await c.call('input', args);
        check(`${args.action} explains that there is no graphical session`, r.isError && /No graphical session/.test(r.text), r.text.slice(0, 140));
        check(`${args.action} points at the browser tool instead`, /browser tool/.test(r.text), r.text.slice(0, 140));
      }
      const r = await c.call('input', { action: 'probe' });
      check('probe answers even with no desktop', !r.isError && /session type: none/.test(r.text), r.text);
    }

    console.log('\n--- against a real X display, with xev as the witness ---');
    {
      const x = await startX();
      if (!x) {
        console.log('  (skipped: needs Xvfb, xdotool and xev)');
      } else {
        const env = { DISPLAY: x.display, WAYLAND_DISPLAY: '' };
        const c2 = await new Client(dir, ['--tools', 'core,input,screen'], env).init();
        const witness = new Witness(x.display);
        await new Promise((r) => setTimeout(r, 600));
        try {
          let r = await c2.call('input', { action: 'probe' });
          check('probe finds xdotool', /xdotool: installed/.test(r.text), r.text);
          check('probe reports where the pointer is', /pointer now at: \d+,\d+/.test(r.text), r.text);

          witness.reset();
          r = await c2.call('input', { action: 'move', x: 300, y: 200 });
          check('move succeeds', !r.isError && /300,200/.test(r.text), r.text);
          let ev = await witness.events();
          const motion = ev.filter((e) => e.type === 'MotionNotify');
          check('X really saw the pointer move', motion.length > 0, JSON.stringify(ev.map((e) => e.type)));
          check('...to exactly where it was sent', motion.some((e) => e.x === 300 && e.y === 200), JSON.stringify(motion.map((e) => [e.x, e.y])));

          r = await c2.call('input', { action: 'position' });
          check('position agrees with where it was put', /pointer at 300,200/.test(r.text), r.text);

          witness.reset();
          r = await c2.call('input', { action: 'move', dx: 40, dy: 15 });
          check('a relative move reports the destination', /340,215/.test(r.text), r.text);
          ev = await witness.events();
          check('...and X saw it land there', ev.some((e) => e.type === 'MotionNotify' && e.x === 340 && e.y === 215), JSON.stringify(ev.filter((e) => e.type === 'MotionNotify').map((e) => [e.x, e.y])));

          witness.reset();
          r = await c2.call('input', { action: 'click', x: 500, y: 300 });
          check('a click succeeds', !r.isError && /left click at 500,300/.test(r.text), r.text);
          ev = await witness.events();
          const press = ev.find((e) => e.type === 'ButtonPress');
          const release = ev.find((e) => e.type === 'ButtonRelease');
          check('X saw a button press', Boolean(press), JSON.stringify(ev.map((e) => e.type)));
          check('...the left button', press?.button === 1, JSON.stringify(press?.button));
          check('...at the coordinates asked for', press?.x === 500 && press?.y === 300, `${press?.x},${press?.y}`);
          check('...and a release to match', Boolean(release) && release.button === 1);

          witness.reset();
          r = await c2.call('input', { action: 'click', x: 400, y: 250, button: 'right', count: 2 });
          check('a double right click succeeds', !r.isError && /2x right click/.test(r.text), r.text);
          ev = await witness.events();
          const rights = ev.filter((e) => e.type === 'ButtonPress' && e.button === 3);
          check('X saw two presses of button 3', rights.length === 2, String(rights.length));

          witness.reset();
          r = await c2.call('input', { action: 'scroll', amount: 2 });
          check('scrolling down succeeds', !r.isError && /scrolled 2 click\(s\) down/.test(r.text), r.text);
          ev = await witness.events();
          check('X saw button 5 twice (wheel down)', ev.filter((e) => e.type === 'ButtonPress' && e.button === 5).length === 2,
            JSON.stringify(ev.filter((e) => e.type === 'ButtonPress').map((e) => e.button)));

          witness.reset();
          r = await c2.call('input', { action: 'scroll', amount: -1 });
          ev = await witness.events();
          check('scrolling up is button 4', ev.some((e) => e.type === 'ButtonPress' && e.button === 4),
            JSON.stringify(ev.filter((e) => e.type === 'ButtonPress').map((e) => e.button)));

          witness.reset();
          r = await c2.call('input', { action: 'type', text: 'hi' });
          check('typing succeeds', !r.isError && /typed 2 character/.test(r.text), r.text);
          ev = await witness.events();
          const keys = ev.filter((e) => e.type === 'KeyPress').map((e) => e.keysym);
          check('X saw the characters, in order', keys.join(',') === 'h,i', keys.join(','));

          witness.reset();
          r = await c2.call('input', { action: 'type', text: 'à€' });
          check('typing a non-ASCII character succeeds', !r.isError, r.text);
          ev = await witness.events();
          const accents = ev.filter((e) => e.type === 'KeyPress').map((e) => e.keysym);
          check('...and it arrives as itself, not mangled', accents.includes('agrave'), accents.join(','));

          witness.reset();
          r = await c2.call('input', { action: 'key', keys: 'ctrl+s' });
          check('a chord succeeds', !r.isError && /pressed ctrl\+s/.test(r.text), r.text);
          ev = await witness.events();
          const held = ev.find((e) => e.type === 'KeyPress' && e.keysym === 's');
          check('X saw the modifier down first', ev.some((e) => e.type === 'KeyPress' && /Control/.test(e.keysym ?? '')), JSON.stringify(ev.filter((e) => e.type === 'KeyPress').map((e) => e.keysym)));
          check('...and the key arriving with ctrl held', (held?.state & 0x4) === 0x4, `state ${held?.state}`);
          check('...and the modifier released afterwards', ev.some((e) => e.type === 'KeyRelease' && /Control/.test(e.keysym ?? '')));

          witness.reset();
          r = await c2.call('input', { action: 'key', keys: 'f5 enter' });
          check('a sequence succeeds', !r.isError && /pressed f5 then enter/.test(r.text), r.text);
          ev = await witness.events();
          const seq = ev.filter((e) => e.type === 'KeyPress').map((e) => e.keysym);
          check('X saw both keys, in order', seq.join(',') === 'F5,Return', seq.join(','));

          witness.reset();
          r = await c2.call('input', { action: 'key', keys: 'a', hold_ms: 150 });
          check('holding a key succeeds', !r.isError && /held 150ms/.test(r.text), r.text);
          ev = await witness.events();
          check('X saw it pressed and released', ev.some((e) => e.type === 'KeyPress' && e.keysym === 'a') && ev.some((e) => e.type === 'KeyRelease' && e.keysym === 'a'),
            JSON.stringify(ev.map((e) => `${e.type}:${e.keysym}`)));

          witness.reset();
          r = await c2.call('input', { action: 'drag', x: 100, y: 100, to_x: 400, to_y: 300 });
          check('a drag succeeds', !r.isError && /from 100,100 to 400,300/.test(r.text), r.text);
          ev = await witness.events();
          const dragMotion = ev.filter((e) => e.type === 'MotionNotify');
          check('X saw the button go down', ev.some((e) => e.type === 'ButtonPress' && e.button === 1));
          check('...moving while held, not teleporting', dragMotion.length >= 5, String(dragMotion.length));
          check('...and coming back up at the end', ev.some((e) => e.type === 'ButtonRelease' && e.button === 1));
          const last = dragMotion[dragMotion.length - 1];
          check('...having arrived where it was going', last?.x === 400 && last?.y === 300, `${last?.x},${last?.y}`);

          r = await c2.call('input', { action: 'click', x: 200, y: 200, shot: true, max_width: 320 });
          check('shot:true returns an image of the result', !r.isError && r.images.length === 1, r.text);
          check('...and says what it cost', /viewing:.*image tokens/.test(r.text), r.text);

          check('nothing crashed the server', !/handler crash|uncaught/.test(c2.stderr), c2.stderr.slice(-300));
        } finally {
          witness.close();
          c2.close();
          try { x.proc.kill('SIGTERM'); } catch { /* gone */ }
        }
      }
    }

    check('the server logged no crashes', !/handler crash|uncaught/.test(c.stderr), c.stderr.slice(-300));
  } finally {
    c.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

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
