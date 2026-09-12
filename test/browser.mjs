// Browser control, end to end, against a real Chromium over the real protocol.
//
// Pages are served over HTTP rather than file:// because cookies, referrers
// and network logging only behave properly on a real origin.
//
// If there is no Chromium-family browser on the machine, this suite says so
// and exits 0: that is a missing browser, not a broken server.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { findBrowser } from '../src/cdp.js';
import { pngInfo } from '../src/image.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'bin', 'terminalmcp.js');

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failures.push(`${name} — ${detail}`); console.log(`  FAIL ${name} — ${detail}`); }
}

const PAGE = `<!doctype html><html><head><title>Fixture</title></head>
<body style="font:15px system-ui;padding:1rem">
<h1 id="h">Sign in</h1>
<nav><a href="/second">Second page</a> <a id="ext" href="/api/slow">Slow</a></nav>
<form id="f" onsubmit="event.preventDefault();out.textContent='ok:'+u.value+':'+plan.value+':'+rm.checked;return false">
  <p><label for="u">Email</label> <input id="u" name="user" type="email" placeholder="you@example.com" required></p>
  <p><label for="p">Password</label> <input id="p" name="pass" type="password"></p>
  <p><select id="plan" name="plan"><option value="free">Free</option><option value="pro">Pro plan</option></select></p>
  <p><label><input type="checkbox" id="rm" name="remember"> Remember me</label></p>
  <p><textarea id="notes" name="notes" rows="2"></textarea></p>
  <button type="submit">Sign in</button>
</form>
<p id="out"></p>
<div style="display:none"><button id="ghost">invisible</button></div>
<div style="height:1800px">tall filler</div>
<p id="foot">bottom of page</p>
<script>
console.log('hello from the page');
console.error('a page error');
setTimeout(function () {
  document.body.insertAdjacentHTML('beforeend', '<p id="late">arrived late</p>');
}, 400);
</script>
</body></html>`;

const SECOND = '<!doctype html><title>Second</title><h1>Second page</h1><p>You navigated here.</p>';

class Client {
  constructor(cwd, extraArgs = []) {
    this.id = 0;
    this.pending = new Map();
    this.buf = '';
    this.proc = spawn(process.execPath, [ENTRY, '--cwd', cwd, ...extraArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERMINALMCP_CONFIG: join(cwd, 'no-such-config.json') },
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
      const t = setTimeout(() => rej(new Error(`timeout on ${method}`)), 90000);
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
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'browser-test', version: '1' },
    });
    return this;
  }
  close() { this.proc.stdin.end(); this.proc.kill(); }
}

async function main() {
  let found;
  try {
    found = findBrowser(null);
  } catch (err) {
    console.log('\nSKIPPED: no Chromium-family browser on this machine.');
    console.log(`  ${err.message.split('\n')[0]}`);
    console.log('\n0 passed, 0 failed (skipped)');
    return;
  }
  console.log(`\nUsing ${found.path} (${found.kind}, via ${found.source})`);

  const dir = await mkdtemp(join(tmpdir(), 'tmcp-browser-'));
  let requests = 0;
  const srv = createServer((req, res) => {
    requests++;
    if (req.url === '/second') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(SECOND);
    }
    if (req.url === '/api/slow') {
      return setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"slow":true}');
      }, 300);
    }
    if (req.url === '/api/missing') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('nope');
    }
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Set-Cookie': 'fixture=abc123; Path=/',
    });
    res.end(PAGE);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const c = await new Client(dir, ['--tools', 'core,browser,screen']).init();

  try {
    console.log('\n--- lifecycle ---');
    {
      let r = await c.call('browser', { action: 'status' });
      check('status with nothing running explains how to start', /No browser running/.test(r.text), r.text);

      r = await c.call('browser', { action: 'snapshot' });
      check('acting before launching is a clear error', r.isError && /No browser is running/.test(r.text), r.text);

      r = await c.call('browser', { action: 'launch', url: base });
      check('launch reports the browser it found', !r.isError && /Chrom|Edge|Brave/i.test(r.text), r.text.slice(0, 200));
      check('launch navigates when given a url', /Fixture/.test(r.text), r.text);
      check('launch does not sit out the load timeout', !/did not fire/.test(r.text), r.text);

      r = await c.call('browser', { action: 'launch' });
      check('launching twice reuses the browser instead of leaking one', /already running/.test(r.text), r.text);

      r = await c.call('browser', { action: 'status' });
      check('status lists tabs', /tab\(s\)/.test(r.text), r.text);
    }

    console.log('\n--- snapshot and refs ---');
    let refs = {};
    {
      const r = await c.call('browser', { action: 'snapshot' });
      check('snapshot succeeds', !r.isError, r.text);
      check('snapshot shows the url and title', r.text.includes(base) && /Fixture/.test(r.text), r.text.slice(0, 120));

      for (const line of r.text.split('\n')) {
        const m = line.match(/^(e\d+)\s+(\S+)\s+(.*)$/);
        if (m) refs[`${m[2]}:${m[3].split('"')[1] ?? ''}`] = m[1];
      }
      const names = Object.keys(refs).join(' | ');
      check('email input is listed with its placeholder', /placeholder="you@example.com"/.test(r.text), r.text);
      check('the select lists its options', /options=\["free","pro"\]/.test(r.text), r.text);
      check('the checkbox reports its state', /checkbox.*unchecked/.test(r.text), r.text);
      check('the link shows where it goes', /-> \/second/.test(r.text), r.text);
      check('a hidden element is not offered', !/invisible/.test(r.text), r.text);
      check('a label duplicating its field is not repeated', (r.text.match(/"Email"/g) ?? []).length === 1, r.text);
      check('refs were parsed out of the snapshot', Object.keys(refs).length >= 6, names);
      check('snapshot is far smaller than the html', r.text.length < 1200, `${r.text.length} chars`);

      const html = await c.call('browser', { action: 'html' });
      check('...and the html really is bigger', html.text.length > r.text.length, `${html.text.length} vs ${r.text.length}`);
    }

    console.log('\n--- interaction ---');
    {
      let r = await c.call('browser', { action: 'fill', selector: '#u', text: 'ada@example.com' });
      check('fill sets a value', !r.isError && /ada@example\.com/.test(r.text), r.text);

      r = await c.call('browser', { action: 'fill', selector: '#u', text: 'grace@example.com' });
      check('fill replaces rather than appends', /"grace@example\.com"/.test(r.text), r.text);

      r = await c.call('browser', { action: 'type', selector: '#notes', text: 'one' });
      r = await c.call('browser', { action: 'type', selector: '#notes', text: ' two' });
      check('type appends', /one two/.test(r.text), r.text);

      r = await c.call('browser', { action: 'fill', selector: '#h', text: 'nope' });
      check('typing into a heading is refused with a reason', r.isError && /does not accept typing/.test(r.text), r.text);

      r = await c.call('browser', { action: 'fill', selector: '#plan', text: 'pro' });
      check('a select points you at the right action', r.isError && /action "select"/.test(r.text), r.text);

      r = await c.call('browser', { action: 'select', selector: '#plan', label: 'Pro plan' });
      check('select by label works', !r.isError && /"pro"/.test(r.text), r.text);

      r = await c.call('browser', { action: 'select', selector: '#plan', value: 'free' });
      check('select by value works', /"free"/.test(r.text), r.text);

      r = await c.call('browser', { action: 'select', selector: '#plan', value: 'enterprise' });
      check('an unknown option lists the real ones', r.isError && /Available:/.test(r.text), r.text);

      r = await c.call('browser', { action: 'click', text: 'Remember me' });
      check('click by visible text works', !r.isError, r.text);
      check('...and picks the control, not the <p> wrapping it', /<input>/.test(r.text), r.text);

      r = await c.call('browser', { action: 'click', text: 'Sign in' });
      check('an ambiguous text prefers the button over the heading', /<button>/.test(r.text), r.text);

      const ref = refs['button:Sign in'];
      check('the submit button had a ref', Boolean(ref), JSON.stringify(refs));
      r = await c.call('browser', { action: 'click', ref });
      check('click by ref works', !r.isError && /clicked <button>/.test(r.text), r.text);

      r = await c.call('browser', { action: 'text', selector: '#out' });
      check('the form actually submitted with our values', /ok:grace@example\.com:free:true/.test(r.text), r.text);

      r = await c.call('browser', { action: 'click', selector: '#nothing-here' });
      check('a selector that matches nothing says which one', r.isError && /#nothing-here/.test(r.text), r.text);

      r = await c.call('browser', { action: 'click', selector: '#ghost' });
      check('clicking an invisible element is refused', r.isError && /no size/.test(r.text), r.text);

      r = await c.call('browser', { action: 'click' });
      check('click with no target explains the three ways', r.isError && /ref.*selector.*text/s.test(r.text), r.text);
    }

    console.log('\n--- keyboard ---');
    {
      let r = await c.call('browser', { action: 'fill', selector: '#u', text: 'k@example.com', press_enter: true });
      check('press_enter submits in one call', !r.isError && /pressed Enter/.test(r.text), r.text);
      r = await c.call('browser', { action: 'text', selector: '#out' });
      check('...and the form saw it', /ok:k@example\.com/.test(r.text), r.text);

      r = await c.call('browser', { action: 'press', key: 'Control+A', selector: '#notes' });
      check('a modifier combination is accepted', !r.isError, r.text);

      r = await c.call('browser', { action: 'press', key: 'Meta+Shift+F5' });
      check('several modifiers are accepted', !r.isError, r.text);

      r = await c.call('browser', { action: 'press', key: 'Wingding' });
      check('an unknown key lists the known ones', r.isError && /Unknown key/.test(r.text), r.text);

      r = await c.call('browser', { action: 'press', key: 'Hyper+A' });
      check('an unknown modifier is named', r.isError && /Unknown modifier/.test(r.text), r.text);
    }

    console.log('\n--- waiting ---');
    {
      let r = await c.call('browser', { action: 'navigate', url: base });
      check('navigate reports where it ended up', !r.isError && r.text.includes(base), r.text);

      r = await c.call('browser', { action: 'wait', selector: '#late', timeout_ms: 4000 });
      check('wait finds an element that appears later', !r.isError && /present/.test(r.text), r.text);

      r = await c.call('browser', { action: 'wait', selector: '#never', timeout_ms: 600 });
      check('wait times out with advice', r.isError && /snapshot/.test(r.text), r.text);

      r = await c.call('browser', { action: 'wait', text: 'bottom of page', timeout_ms: 3000 });
      check('wait can look for text', !r.isError, r.text);

      r = await c.call('browser', { action: 'wait', until: 'networkidle', timeout_ms: 5000 });
      check('wait for network idle works', !r.isError && /idle/.test(r.text), r.text);

      r = await c.call('browser', { action: 'wait', ms: 50 });
      check('wait can just sleep', !r.isError && /elapsed/.test(r.text), r.text);

      r = await c.call('browser', { action: 'wait' });
      check('wait with no criterion says what it accepts', r.isError && /selector, text, until, ms/.test(r.text), r.text);
    }

    console.log('\n--- reading the page ---');
    {
      let r = await c.call('browser', { action: 'text' });
      check('text returns visible text', /Sign in/.test(r.text) && /bottom of page/.test(r.text), r.text.slice(0, 200));
      check('text does not include script source', !/insertAdjacentHTML/.test(r.text), r.text.slice(0, 300));

      const dirty = await c.call('browser', { action: 'html' });
      const clean = await c.call('browser', { action: 'html', clean: true });
      check('clean html drops the script tags', !/<script/.test(clean.text), clean.text.slice(0, 200));
      check('clean html is smaller than raw', clean.text.length < dirty.text.length, `${clean.text.length} vs ${dirty.text.length}`);

      r = await c.call('browser', { action: 'html', selector: '#f' });
      check('html can be scoped to one element', /^\d+ bytes of HTML/m.test(r.text) && /<form/.test(r.text), r.text.slice(0, 120));

      r = await c.call('browser', { action: 'eval', expression: 'document.querySelectorAll("input").length' });
      check('eval returns a number', r.text.trim() === '3', r.text);

      r = await c.call('browser', { action: 'eval', expression: '({ t: document.title, n: 1 + 1 })' });
      check('eval handles an object literal', /"t": "Fixture"/.test(r.text) && /"n": 2/.test(r.text), r.text);

      r = await c.call('browser', { action: 'eval', expression: 'const xs = [1,2,3]; return xs.map(x => x * 2);' });
      check('eval handles a statement body with return', /\[\s*2,\s*4,\s*6\s*\]/.test(r.text), r.text);

      r = await c.call('browser', { action: 'eval', expression: 'new Promise(r => setTimeout(() => r("resolved"), 80))' });
      check('eval awaits a promise', /resolved/.test(r.text), r.text);

      r = await c.call('browser', { action: 'eval', expression: 'missingThing.x' });
      check('a page-side error comes back as the error', r.isError && /not defined/.test(r.text), r.text);

      r = await c.call('browser', { action: 'eval', expression: 'const = ;' });
      check('a syntax error is reported as a syntax error', r.isError && /SyntaxError/.test(r.text), r.text);
    }

    console.log('\n--- console and network ---');
    {
      let r = await c.call('browser', { action: 'console' });
      check('console captures page logs', /hello from the page/.test(r.text), r.text);
      check('console captures page errors', /a page error/.test(r.text), r.text);

      r = await c.call('browser', { action: 'console', level: 'error' });
      check('console filters by level', /a page error/.test(r.text) && !/hello from the page/.test(r.text), r.text);

      r = await c.call('browser', { action: 'console', clear: true });
      r = await c.call('browser', { action: 'console' });
      check('console can be cleared', /No console output/.test(r.text), r.text);

      await c.call('browser', { action: 'eval', expression: `fetch('/api/missing').catch(() => {})` });
      await c.call('browser', { action: 'wait', ms: 400 });

      r = await c.call('browser', { action: 'network' });
      check('network logs requests', /GET/.test(r.text), r.text);
      r = await c.call('browser', { action: 'network', failed: true });
      check('network can show only failures and 4xx', /404/.test(r.text), r.text);
      r = await c.call('browser', { action: 'network', filter: 'no-such-path' });
      check('network filters by url', /No matching requests/.test(r.text), r.text);
    }

    console.log('\n--- cookies ---');
    {
      let r = await c.call('browser', { action: 'cookies' });
      check('the server cookie is visible', /fixture=abc123/.test(r.text), r.text);

      r = await c.call('browser', { action: 'cookie_set', cookie: { name: 'mine', value: 'v1', domain: '127.0.0.1', path: '/' } });
      check('a cookie can be set', !r.isError && /mine/.test(r.text), r.text);

      r = await c.call('browser', { action: 'cookies' });
      check('...and read back', /mine=v1/.test(r.text), r.text);

      r = await c.call('browser', { action: 'cookie_set', cookie: {} });
      check('a nameless cookie is refused', r.isError && /name/.test(r.text), r.text);

      await c.call('browser', { action: 'cookies_clear' });
      r = await c.call('browser', { action: 'cookies' });
      check('cookies can be cleared', !/mine=v1/.test(r.text), r.text);
    }

    console.log('\n--- navigation history and tabs ---');
    {
      let r = await c.call('browser', { action: 'click', text: 'Second page' });
      check('clicking a link navigates', /navigated to/.test(r.text) && /second/.test(r.text), r.text);

      r = await c.call('browser', { action: 'back' });
      check('back returns to the previous page', /Fixture/.test(r.text), r.text);

      r = await c.call('browser', { action: 'forward' });
      check('forward goes again', /Second/.test(r.text), r.text);

      r = await c.call('browser', { action: 'reload' });
      check('reload works', !r.isError && /reloaded/.test(r.text), r.text);

      r = await c.call('browser', { action: 'tab_new', url: `${base}/second` });
      check('a new tab opens and navigates', !r.isError && /new tab/.test(r.text), r.text);

      r = await c.call('browser', { action: 'tabs' });
      check('both tabs are listed', (r.text.match(/http:\/\/127\.0\.0\.1/g) ?? []).length >= 2, r.text);
      check('the active tab is marked', /^\*/m.test(r.text), r.text);

      const id = r.text.split('\n').find((l) => l.startsWith('*'))?.trim().split(/\s+/)[1];
      r = await c.call('browser', { action: 'tab_select', tab: id });
      check('a tab can be selected by id', !r.isError && /active tab is now/.test(r.text), r.text);

      r = await c.call('browser', { action: 'tab_select', tab: 'not-a-tab' });
      check('an unknown tab lists the real ones', r.isError && /Known tabs/.test(r.text), r.text);

      r = await c.call('browser', { action: 'tab_close' });
      check('a tab can be closed', !r.isError && /closed tab/.test(r.text), r.text);

      r = await c.call('browser', { action: 'resize', width: 900, height: 600 });
      check('the viewport can be resized', !r.isError && /900x600/.test(r.text), r.text);
    }

    console.log('\n--- screenshots ---');
    {
      await c.call('browser', { action: 'navigate', url: base });

      let r = await c.call('browser', { action: 'screenshot', max_width: 400, save: false });
      check('a screenshot comes back as an image block', r.images.length === 1, JSON.stringify(r.images.length));
      check('the image is a png', r.images[0]?.mimeType === 'image/png');
      const shot = Buffer.from(r.images[0].data, 'base64');
      check('the image data is a real png', pngInfo(shot).width === 400, JSON.stringify(pngInfo(shot)));
      check('the text says how big it is and what it costs', /400x\d+, ~\d+ image tokens/.test(r.text), r.text);

      r = await c.call('browser', { action: 'screenshot', max_width: 300, selector: '#f', save: false });
      check('one element can be captured', r.images.length === 1 && pngInfo(Buffer.from(r.images[0].data, 'base64')).width <= 300, r.text);
      check('and is labelled as an element', /^element of/m.test(r.text), r.text);

      r = await c.call('browser', { action: 'screenshot', full_page: true, max_width: 300, save: false });
      const full = pngInfo(Buffer.from(r.images[0].data, 'base64'));
      check('a full-page shot is taller than the viewport', full.height > full.width * 2, JSON.stringify(full));
      check('and is labelled as a full page', /^full page of/m.test(r.text), r.text);

      r = await c.call('browser', { action: 'screenshot', format: 'jpeg', max_width: 320, save: false });
      check('jpeg is supported', r.images[0]?.mimeType === 'image/jpeg', r.text);
      check('and the renderer scaled it, since we cannot resize jpeg', /320x/.test(r.text), r.text);

      r = await c.call('browser', { action: 'screenshot', max_width: 200 });
      check('by default a screenshot is also saved', /^saved /m.test(r.text), r.text);
      const path = r.text.match(/^saved (.+?) \(/m)?.[1];
      check('the saved path exists', Boolean(path) && (await stat(path).catch(() => null)) !== null, String(path));
      check('the saved png is full resolution, not the scaled view copy', pngInfo(await readFile(path)).width > 200, String(path));
      check('and the reply states the saved size', /saved .*, \d+x\d+\)/.test(r.text), r.text);

      r = await c.call('browser', { action: 'screenshot', format: 'jpeg', max_width: 240 });
      check('a saved jpeg says it is scaled too', /cannot be resized in-process/.test(r.text), r.text);

      r = await c.call('browser', { action: 'screenshot', save: false, view: false });
      check('view:false returns no image', r.images.length === 0, r.text);

      r = await c.call('screen', { action: 'view', path, max_width: 150 });
      check('the screen tool can view a saved screenshot', r.images.length === 1 && !r.isError, r.text);
      check('and reports the scaling it applied', /scaled to 150x/.test(r.text), r.text);

      r = await c.call('browser', { action: 'pdf' });
      check('a pdf can be printed', !r.isError && /saved .*\.pdf/.test(r.text), r.text);
      const pdfPath = r.text.match(/saved (.+?\.pdf)/)?.[1];
      const pdfHead = pdfPath ? (await readFile(pdfPath)).subarray(0, 5).toString('latin1') : '';
      check('and really is a pdf', pdfHead === '%PDF-', pdfHead);
    }

    console.log('\n--- ${vars} reach the browser ---');
    {
      await c.call('vars', { action: 'set', name: 'site', value: base });
      const r = await c.call('browser', { action: 'navigate', url: '${vars.site}/second' });
      check('a variable expands in a url', !r.isError && /Second/.test(r.text), r.text);

      const t = await c.call('browser', { action: 'eval', expression: 'document.title' });
      check('...and the browser really went there', /Second/.test(t.text), t.text);
    }

    console.log('\n--- shutting down ---');
    {
      let r = await c.call('browser', { action: 'close' });
      check('close reports success', /closed/.test(r.text), r.text);

      r = await c.call('browser', { action: 'close' });
      check('closing twice is not an error', !r.isError && /No browser was running/.test(r.text), r.text);

      r = await c.call('browser', { action: 'navigate', url: base });
      check('after closing, actions explain how to start again', r.isError && /launch/.test(r.text), r.text);

      r = await c.call('browser', { action: 'not-a-real-action' });
      check('an unknown action is refused helpfully', r.isError && /launch or attach/.test(r.text), r.text);

      r = await c.call('browser', { action: 'attach', port: 59999 });
      check('attaching to nothing explains the flag to use', r.isError && /--remote-debugging-port/.test(r.text), r.text);
    }

    console.log('\n--- read-only refuses to start a browser ---');
    {
      const ro = await new Client(dir, ['--tools', 'core,browser,screen', '--read-only']).init();
      try {
        let r = await ro.call('browser', { action: 'launch' });
        check('readOnly blocks launching a process', r.isError && /readOnly/.test(r.text), r.text);
        check('and points at attach instead', /attach/.test(r.text), r.text);

        r = await ro.call('screen', { action: 'shot', path: '/tmp/nope.png' });
        check('readOnly blocks saving a screenshot to a named path', r.isError && /readOnly|graphical session/.test(r.text), r.text);
      } finally {
        ro.close();
      }
    }

    check('the server logged no crashes', !/handler crash|uncaught/.test(c.stderr), c.stderr.slice(-400));
    check('the fixture server was actually used', requests > 0, String(requests));
  } finally {
    c.close();
    srv.close();
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
