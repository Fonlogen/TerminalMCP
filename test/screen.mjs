// The `screen` tool, over the real protocol.
//
// Real capture needs a desktop, which CI does not have, so this suite splits
// in two: everything that must work anywhere (viewing images, guards, honest
// failure) always runs, and the actual capture runs only when there is a
// graphical session to capture.

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { encodePng, pngInfo } from '../src/image.js';
import { describeRunFailure, runFailed } from '../src/exec.js';
import {
  WINDOWS_SCRIPT,
  explainWindowsFailure,
  findWindowsError,
  parseWindowsOk,
  sessionType,
  shotTempDir,
} from '../src/screen.js';

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
  _onData(d) {
    this.buf += d;
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); p(msg); }
    }
  }
  send(method, params) {
    const id = ++this.id;
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout on ${method}`)), 60000);
      this.pending.set(id, (m) => { clearTimeout(t); res(m); });
    });
  }
  async call(name, args) {
    const res = await this.send('tools/call', { name, arguments: args });
    if (res.error) return { isError: true, text: res.error.message, images: [] };
    const content = res.result?.content ?? [];
    return {
      isError: Boolean(res.result?.isError),
      text: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
      images: content.filter((c) => c.type === 'image'),
    };
  }
  async init() {
    await this.send('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'screen-test', version: '1' },
    });
    return this;
  }
  close() { this.proc.stdin.end(); this.proc.kill(); }
}

/** A gradient with a solid block, so scaling is visibly verifiable. */
function fixtureImage(w, h) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = (x * 255) / w;
      rgba[o + 1] = (y * 255) / h;
      rgba[o + 2] = 128;
      rgba[o + 3] = 255;
    }
  }
  return encodePng({ width: w, height: h, rgba });
}

function onPathSync(name) {
  return (process.env.PATH || '').split(':').some((d) => d && existsSync(join(d, name)));
}

/**
 * A throwaway X display, so the capture commands themselves can be exercised
 * rather than only the logic around them. Returns null when the machine has no
 * Xvfb — a missing tool is a missing tool, not a failing test.
 */
async function startXvfb() {
  if (process.platform !== 'linux' || !onPathSync('Xvfb') || !onPathSync('xdpyinfo')) return null;
  for (let n = 90; n <= 99; n++) {
    const display = `:${n}`;
    // Xvfb refuses to start on a display whose lock file exists, even a stale
    // one left behind by a server that was killed rather than asked to stop.
    if (existsSync(`/tmp/.X${n}-lock`) || existsSync(`/tmp/.X11-unix/X${n}`)) continue;
    const proc = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], {
      stdio: 'ignore',
      detached: true,
    });
    proc.unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const probe = spawnSync('xdpyinfo', [], { env: { ...process.env, DISPLAY: display }, stdio: 'ignore' });
      if (probe.status === 0) return { display, proc, width: 1280, height: 800 };
      if (proc.exitCode !== null) break;
    }
    try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  }
  return null;
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'tmcp-screen-'));
  const session = sessionType();
  console.log(`\nGraphical session: ${session ?? 'none (headless)'}`);

  const c = await new Client(dir, ['--tools', 'core,screen']).init();
  try {
    console.log('\n--- view: any image on disk becomes something the model can see ---');
    {
      const big = join(dir, 'big.png');
      await writeFile(big, fixtureImage(1600, 1000));

      let r = await c.call('screen', { action: 'view', path: big, max_width: 400 });
      check('view returns an image block', r.images.length === 1 && !r.isError, r.text);
      check('the block is a png', r.images[0]?.mimeType === 'image/png');
      const shown = Buffer.from(r.images[0].data, 'base64');
      check('the image was scaled to the requested width', pngInfo(shown).width === 400, JSON.stringify(pngInfo(shown)));
      check('the reply says what it scaled', /1600x1000 scaled to 400x250/.test(r.text), r.text);
      check('the reply gives a token estimate', /~\d+ image tokens/.test(r.text), r.text);
      check('the reply gives the size on disk', /bytes on disk/.test(r.text), r.text);

      r = await c.call('screen', { action: 'view', path: big, max_width: 5000 });
      check('an image already small enough is not scaled', /1600x1000, ~/.test(r.text) && !/scaled to/.test(r.text), r.text);

      const small = join(dir, 'small.png');
      await writeFile(small, fixtureImage(32, 24));
      r = await c.call('screen', { action: 'view', path: small });
      check('a small image passes through', /32x24/.test(r.text), r.text);
    }

    console.log('\n--- view: things that are not images ---');
    {
      let r = await c.call('screen', { action: 'view', path: join(dir, 'nope.png') });
      check('a missing file is reported as missing', r.isError && /Not found/.test(r.text), r.text);

      const txt = join(dir, 'notes.txt');
      await writeFile(txt, 'just words');
      r = await c.call('screen', { action: 'view', path: txt });
      check('a text file is refused', r.isError && /not an image/.test(r.text), r.text);
      check('...and points at file_read instead', /file_read/.test(r.text), r.text);

      const svg = join(dir, 'logo.svg');
      await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
      r = await c.call('screen', { action: 'view', path: svg });
      check('svg is refused with the reason that it is markup', r.isError && /markup/.test(r.text), r.text);

      r = await c.call('screen', { action: 'view', path: dir });
      check('a directory is refused', r.isError && /directory/.test(r.text), r.text);

      r = await c.call('screen', { action: 'view' });
      check('view with no path says so', r.isError && /needs "path"/.test(r.text), r.text);
    }

    console.log('\n--- a real jpeg is passed through unresized ---');
    {
      // Minimal JPEG header: enough for the size sniffer, and it must not be
      // claimed as resizable.
      const jpeg = Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x07, 0x08, 0x0a, 0x00]),
        Buffer.from([0xff, 0xd9]),
      ]);
      const p = join(dir, 'photo.jpg');
      await writeFile(p, jpeg);
      const r = await c.call('screen', { action: 'view', path: p, max_width: 100 });
      check('a jpeg is returned as a jpeg', r.images[0]?.mimeType === 'image/jpeg', r.text);
      check('and it says why it was not resized', /only PNG can be resized/.test(r.text), r.text);
    }

    console.log('\n--- bad arguments ---');
    {
      let r = await c.call('screen', { action: 'shot', mode: 'region', x: 10, y: 10 });
      check('region without a size is refused before anything is launched', r.isError && /needs x, y, width and height/.test(r.text), r.text);

      r = await c.call('screen', { action: 'shot', mode: 'region', x: 0, y: 0, width: 0, height: 10 });
      check('a zero-size region is refused', r.isError && /at least 1|graphical session/.test(r.text), r.text);

      r = await c.call('screen', { action: 'zoom' });
      check('an unknown action lists the real ones', r.isError && /shot \| view \| displays \| windows/.test(r.text), r.text);

      r = await c.call('screen', {});
      check('a missing action is reported', r.isError && /needs "action"/.test(r.text), r.text);
    }

    console.log('\n--- probe: the tool that says whether capture can work here ---');
    {
      const r = await c.call('screen', { action: 'probe' });
      check('probe answers instead of failing', !r.isError, r.text);
      check('probe names the session type', /session type:/.test(r.text), r.text);
      if (session) {
        check(
          'probe ends in a verdict either way',
          /Screenshots work on this machine\.|FAILED/.test(r.text),
          r.text,
        );
      } else {
        check('probe on a headless box points at the browser tool', /browser tool/.test(r.text), r.text);
      }
    }

    if (process.platform === 'linux') {
      console.log('\n--- probe on a Linux session, with no capture tool to be found ---');
      // DISPLAY is enough to make the server believe there is an X11 session,
      // which is what exercises the back-end selection inside probe on CI.
      const x11 = await new Client(dir, ['--tools', 'core,screen'], { DISPLAY: ':99', WAYLAND_DISPLAY: '' }).init();
      try {
        const r = await x11.call('screen', { action: 'probe' });
        check('probe reports the session it believes it is in', /session type: x11/.test(r.text), r.text);
        check('probe lists the capture tools it found', /capture tools installed:/.test(r.text), r.text);
        check('probe names the temp dir a capture goes through', /temp dir for captures:/.test(r.text), r.text);
        check('probe still tries the real thing end to end', /end-to-end capture:/.test(r.text), r.text);
        if (!/capture tools installed: (grim|maim|import|scrot|spectacle|gnome-screenshot|xfce4-screenshooter)/.test(r.text)) {
          check('with nothing installed, probe says what to install', /install one of:/.test(r.text), r.text);
        }
        check('probe answers rather than erroring, even when capture cannot work', !r.isError, r.text);
      } finally {
        x11.close();
      }
    }

    console.log('\n--- the Windows script reports failures the caller can act on ---');
    {
      // Here-strings only close on a terminator at column 0. Indent it while
      // tidying the script and PowerShell swallows the rest of the file.
      const badTerminator = WINDOWS_SCRIPT.split('\n').filter((l) => l.trim() === "'@" && l !== "'@");
      check('every here-string terminator is at column 0', badTerminator.length === 0, JSON.stringify(badTerminator));

      check('the output path parameter is spelled out', /\[string\]\$OutFile/.test(WINDOWS_SCRIPT));
      check(
        'no parameter is short enough to be ambiguous',
        !/\[(string|int)\]\$(Out|W|H|X|Y|D|T)\b/.test(WINDOWS_SCRIPT),
        (WINDOWS_SCRIPT.match(/\[(string|int)\]\$\w+/g) || []).join(' '),
      );
      check('the script has a probe mode', /'probe' \{/.test(WINDOWS_SCRIPT));
      check('capture failures are caught around CopyFromScreen', /Fail 'copyfromscreen'/.test(WINDOWS_SCRIPT));

      const stages = [...new Set([...WINDOWS_SCRIPT.matchAll(/Fail '([a-z]+)'/g)].map((m) => m[1]))];
      check('the script reports several distinct failure stages', stages.length >= 7, stages.join(','));
      const unexplained = stages.filter((stage) =>
        /failed at stage/.test(explainWindowsFailure({ stage, type: 'Some.Type', message: 'something' })),
      );
      check('every stage the script can report has an explanation', unexplained.length === 0, unexplained.join(','));
    }

    console.log('\n--- reading that report back ---');
    {
      check('normal output carries no error', findWindowsError('OK\t0\t0\t8\t8\tC:\\Temp\\a.png\t120') === null);
      check('a probe listing carries no error', findWindowsError('station\tWinSta0\ncopyfromscreen\tok') === null);

      const err = findWindowsError(
        'something noisy first\nERR\tcopyfromscreen\tSystem.ComponentModel.Win32Exception\t0x80004005\tThe handle is invalid',
      );
      check('the ERR line is found among other output', err !== null && err.stage === 'copyfromscreen', JSON.stringify(err));
      check('the exception type is kept', err?.type === 'System.ComponentModel.Win32Exception', JSON.stringify(err));
      check('the hresult is kept', err?.hresult === '0x80004005', JSON.stringify(err));
      check('the message is kept', err?.message === 'The handle is invalid', JSON.stringify(err));

      const denied = explainWindowsFailure(err);
      check('an invalid handle is explained as the desktop, not as a bug', /interactive desktop/.test(denied), denied);
      check('...naming the causes that produce it', /service|session 0|SSH/.test(denied), denied);
      check('...telling the reader to run probe', /action: "probe"/.test(denied), denied);
      check('...and offering the browser as the way out', /browser tool/.test(denied), denied);
      check('...while still quoting what Windows said', /The handle is invalid/.test(denied), denied);

      const odd = explainWindowsFailure({
        stage: 'copyfromscreen',
        type: 'System.OutOfMemoryException',
        message: 'Out of memory',
      });
      check('an unrelated capture failure does not claim the desktop story', !/interactive desktop/.test(odd), odd);
      check('...but still points at probe', /probe/.test(odd), odd);

      const save = explainWindowsFailure({
        stage: 'save',
        type: 'System.Runtime.InteropServices.ExternalException',
        message: 'A generic error occurred in GDI+.',
      });
      check('a failed save blames the destination, not the capture', /could not be written/.test(save), save);
      check('...and names the thing to check', /TEMP/.test(save), save);

      const assemblies = explainWindowsFailure({ stage: 'assemblies', type: 'System.IO.FileNotFoundException', message: 'System.Drawing' });
      check('a missing assembly points at Windows PowerShell 5.1', /powershell\.exe/.test(assemblies), assemblies);

      const min = explainWindowsFailure({ stage: 'minimized', message: "the window 'Git Bash' is minimized" });
      check('a minimized window suggests activate', /activate: true/.test(min), min);

      check('an unknown stage still says something', explainWindowsFailure({ stage: 'zzz' }).length > 20);
    }

    console.log('\n--- and reading a successful capture back ---');
    {
      const ok = parseWindowsOk('OK\t-1920\t0\t3840\t1080\tC:\\Users\\me\\AppData\\Local\\Temp\\a b.png\t482910');
      check('the geometry is read back', ok?.width === 3840 && ok?.height === 1080 && ok?.x === -1920, JSON.stringify(ok));
      check('the path the script resolved is read back, spaces and all', ok?.path === 'C:\\Users\\me\\AppData\\Local\\Temp\\a b.png', JSON.stringify(ok));
      check('so is the size it wrote', ok?.bytes === 482910, JSON.stringify(ok));
      check('an ERR line is not mistaken for success', parseWindowsOk('ERR\tsave\tX\t\tno') === null);
      check('empty output is not mistaken for success', parseWindowsOk('') === null);
    }

    console.log('\n--- the capture temp dir is one .NET and Node agree on ---');
    {
      const win = (tmp, env = {}) => shotTempDir({ tmp, env, platform: 'win32' });
      check('a drive-qualified TEMP is used as it is', win('C:\\Users\\me\\AppData\\Local\\Temp') === 'C:\\Users\\me\\AppData\\Local\\Temp');
      check('a UNC TEMP is used as it is', win('\\\\nas\\share\\tmp') === '\\\\nas\\share\\tmp');
      check(
        'Git Bash\u2019s /tmp is replaced with LOCALAPPDATA',
        win('/tmp', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }) === 'C:\\Users\\me\\AppData\\Local\\Temp',
        win('/tmp', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }),
      );
      check(
        '...or the profile, when LOCALAPPDATA is not set',
        win('/tmp', { USERPROFILE: 'D:\\Users\\me' }) === 'D:\\Users\\me\\AppData\\Local\\Temp',
        win('/tmp', { USERPROFILE: 'D:\\Users\\me' }),
      );
      check('...or the Windows directory as a last resort', /Temp$/.test(win('/tmp', {})), win('/tmp', {}));
      check('other platforms are left alone', shotTempDir({ tmp: '/tmp', env: {}, platform: 'linux' }) === '/tmp');
    }

    console.log('\n--- allowedRoots applies to images too ---');
    {
      const jailed = await new Client(dir, ['--tools', 'core,screen', '--allowed-root', dir]).init();
      try {
        let r = await jailed.call('screen', { action: 'view', path: join(dir, 'big.png') });
        check('a file inside the root can be viewed', !r.isError && r.images.length === 1, r.text);

        r = await jailed.call('screen', { action: 'view', path: '/etc/hostname' });
        check('a file outside the root is refused', r.isError, r.text);

        r = await jailed.call('screen', { action: 'shot', path: '/tmp/outside-the-root.png' });
        check('saving a capture outside the root is refused', r.isError && !/saved/.test(r.text), r.text);
      } finally {
        jailed.close();
      }
    }

    console.log('\n--- against a real X display: the capture commands themselves ---');
    {
      const x = await startXvfb();
      if (!x) {
        console.log('  (skipped: no Xvfb on this machine)');
      } else {
        const env = { DISPLAY: x.display, WAYLAND_DISPLAY: '' };
        const shots = join(dir, 'xvfb-shots');
        const c2 = await new Client(dir, ['--tools', 'core,screen', '--shots-dir', shots], env).init();
        // A window to aim at, if the machine has one to give.
        const win = onPathSync('xmessage')
          ? spawn('xmessage', ['-geometry', '400x200+100+80', 'TerminalMCP capture test'], {
              env: { ...process.env, DISPLAY: x.display },
              stdio: 'ignore',
              detached: true,
            })
          : null;
        if (win) await new Promise((r) => setTimeout(r, 1200));
        try {
          let r = await c2.call('screen', { action: 'displays' });
          check('displays succeeds against a real display', !r.isError, r.text);
          check('...and reports its size', /1280x800/.test(r.text), r.text);

          r = await c2.call('screen', { action: 'shot', save: false });
          check('a whole-screen shot succeeds', !r.isError, r.text.slice(0, 300));
          check('...and comes back as an image, not a description', r.images?.length === 1, r.text);
          check('...of the whole screen', /1280x800/.test(r.text), r.text);

          r = await c2.call('screen', { action: 'shot', mode: 'region', x: 10, y: 10, width: 200, height: 120, save: false });
          check('a region shot succeeds', !r.isError, r.text.slice(0, 300));
          const region = r.images?.[0] ? pngInfo(Buffer.from(r.images[0].data, 'base64')) : null;
          check('...and is exactly the rectangle asked for', region?.width === 200 && region?.height === 120, JSON.stringify(region));

          r = await c2.call('screen', { action: 'shot', mode: 'display', display: '1', save: false });
          check('capturing one display succeeds', !r.isError, r.text.slice(0, 300));

          r = await c2.call('screen', { action: 'shot', mode: 'region', x: 0, y: 0, width: 64, height: 48 });
          check('a shot saves where the config says', !r.isError && r.text.includes(shots), r.text);
          const savedPath = (r.text.match(/saved (\S+\.png)/) || [])[1];
          check('...and the file is really there', savedPath ? (await stat(savedPath).catch(() => null))?.size > 0 : false, String(savedPath));
          const onDisk = savedPath ? pngInfo(await readFile(savedPath)) : null;
          check('...at full resolution, not the scaled copy', onDisk?.width === 64 && onDisk?.height === 48, JSON.stringify(onDisk));

          r = await c2.call('screen', { action: 'view', path: savedPath });
          check('and the saved capture can be viewed back', !r.isError && r.images?.length === 1, r.text);

          r = await c2.call('screen', { action: 'probe' });
          check('probe confirms capture works here', /8x8 end-to-end capture: ok/.test(r.text), r.text);

          if (win) {
            r = await c2.call('screen', { action: 'windows' });
            check('a window on a bare X session is still found', /xmessage/.test(r.text), r.text);

            r = await c2.call('screen', { action: 'shot', mode: 'window', window: 'xmessage', save: false });
            check('capturing that window succeeds', !r.isError, r.text.slice(0, 300));
            const shot = r.images?.[0] ? pngInfo(Buffer.from(r.images[0].data, 'base64')) : null;
            check('...and is the size of the window', shot?.width === 400 && shot?.height === 200, JSON.stringify(shot));
          }

          check('nothing crashed the server', !/handler crash|uncaught/.test(c2.stderr), c2.stderr.slice(-300));
        } finally {
          c2.close();
          if (win) { try { process.kill(-win.pid, 'SIGKILL'); } catch { try { win.kill('SIGKILL'); } catch { /* gone */ } } }
          // SIGTERM, not SIGKILL: Xvfb removes its own lock file on a clean
          // exit, and a stale lock makes the next run skip this display.
          try { x.proc.kill('SIGTERM'); } catch { /* gone */ }
        }
      }
    }

    console.log('\n--- a run is judged by exitCode, which is the property that exists ---');
    {
      // This is the shape that broke every capture path: `r.code` is undefined
      // on a run, so `r.code !== 0` was always true and every success was
      // reported as a failure carrying the output it should have returned.
      const cfg = { cwd: process.cwd(), env: {}, timeoutMs: 10000, maxBufferBytes: 1 << 20, allowedRoots: [] };
      const { runArgv } = await import('../src/exec.js');

      const ok = await runArgv(cfg, { file: process.execPath, args: ['-e', 'console.log("out")'] });
      check('a run carries exitCode', ok.exitCode === 0, JSON.stringify(Object.keys(ok).slice(0, 20)));
      check('a run has no "code" to read by mistake', ok.code === undefined);
      check('a successful run is not a failure', runFailed(ok) === false);

      const bad = await runArgv(cfg, { file: process.execPath, args: ['-e', 'console.error("boom"); process.exit(3)'] });
      check('a non-zero exit is a failure', runFailed(bad) === true);
      const why = describeRunFailure(bad, 'node');
      check('...and says which code it exited with', /exited with code 3/.test(why), why);
      check('...with stderr labelled, not pasted in raw', /stderr: boom/.test(why), why);

      const missing = await runArgv(cfg, { file: 'definitely-not-a-real-program-xyz', args: [] });
      check('a program that does not exist is a failure', runFailed(missing) === true);
      check('...and says so', /could not be started|not found/.test(describeRunFailure(missing)), describeRunFailure(missing));
    }

    if (!session) {
      console.log('\n--- no desktop here: capture must fail clearly, not mysteriously ---');
      for (const action of [{ action: 'shot' }, { action: 'displays' }, { action: 'windows' }]) {
        const r = await c.call('screen', action);
        check(`${action.action} explains that there is no graphical session`, r.isError && /No graphical session/.test(r.text), r.text.slice(0, 120));
        check(`${action.action} points at the browser tool as the way to screenshot a page`, /browser tool/.test(r.text), r.text.slice(0, 200));
      }
    } else {
      console.log(`\n--- real capture on a ${session} session ---`);
      {
        let r = await c.call('screen', { action: 'displays' });
        check('displays are listed', !r.isError && /display\(s\)/.test(r.text), r.text);

        r = await c.call('screen', { action: 'windows' });
        // Wayland legitimately refuses this, which is a valid outcome.
        check('windows are listed, or the refusal is explained', !r.isError || /Wayland|not installed|Accessibility/.test(r.text), r.text.slice(0, 200));

        r = await c.call('screen', { action: 'shot', max_width: 600 });
        check('a full-screen capture returns an image', !r.isError && r.images.length === 1, r.text.slice(0, 300));
        if (r.images.length) {
          check('the capture is a png', r.images[0].mimeType === 'image/png');
          check('and is scaled to the requested width', pngInfo(Buffer.from(r.images[0].data, 'base64')).width <= 600);
          const saved = r.text.match(/^saved (.+?) \(/m)?.[1];
          check('the capture was saved', Boolean(saved) && (await stat(saved).catch(() => null)) !== null, String(saved));
          check('the reply names the tool that took it', /with \S+/.test(r.text), r.text);
        }

        r = await c.call('screen', { action: 'shot', mode: 'region', x: 0, y: 0, width: 200, height: 120, save: false });
        check('a region capture works, or says which tool is missing', !r.isError || /Install one of|cannot capture/.test(r.text), r.text.slice(0, 200));
        if (!r.isError && r.images.length) {
          check('the region is the size asked for', pngInfo(Buffer.from(r.images[0].data, 'base64')).width <= 200);
        }

        r = await c.call('screen', { action: 'shot', mode: 'window', window: 'definitely-no-such-window-xyz', save: false });
        check('an unmatched window title lists what is open', r.isError && /No window title contains|No visible windows|Wayland|not installed/.test(r.text), r.text.slice(0, 200));
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
