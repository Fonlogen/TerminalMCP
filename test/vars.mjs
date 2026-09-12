// Server-side variables and ${...} interpolation, end to end.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'bin', 'terminalmcp.js');

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failures.push(`${name} — ${detail}`); console.log(`  FAIL ${name} — ${detail}`); }
}

class Client {
  constructor(cwd, extraArgs = []) {
    this.id = 0;
    this.pending = new Map();
    this.buf = '';
    this.proc = spawn(process.execPath, [ENTRY, '--cwd', cwd, ...extraArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERMINALMCP_CONFIG: join(cwd, 'no-such-config.json'), TMCP_FROM_ENV: 'env-value' },
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
    if (res.error) return { isError: true, text: res.error.message };
    return { isError: Boolean(res.result?.isError), text: res.result?.content?.[0]?.text ?? '' };
  }
  async init() {
    await this.send('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vars-test', version: '1' },
    });
    return this;
  }
  close() { this.proc.stdin.end(); this.proc.kill(); }
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'tmcp-vars-'));
  const c = await new Client(dir).init();

  const httpSrv = createServer((req, res) => {
    if (req.url.startsWith('/whoami')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ auth: req.headers.authorization ?? null, url: req.url }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: 'tok-from-api', id: 42 }));
  });
  const port = await new Promise((r) => httpSrv.listen(0, '127.0.0.1', () => r(httpSrv.address().port)));

  try {
    // ============================================================ basics
    let r = await c.call('vars', { action: 'list' });
    check('list is empty to start', r.text.includes('No variables set'), r.text.slice(0, 150));

    r = await c.call('vars', { action: 'set', name: 'sha', value: 'deadbeef' });
    check('set stores a value', r.text.includes('sha = deadbeef'), r.text.slice(0, 200));
    check('set tells you how to use it', r.text.includes('${vars.sha}'), r.text.slice(0, 200));

    r = await c.call('vars', { action: 'get', name: 'sha' });
    check('get returns the value', r.text.trim() === 'deadbeef', JSON.stringify(r.text));

    r = await c.call('vars', { action: 'set', name: 'cfg', value: { port: 8080, hosts: ['a', 'b'] } });
    check('set stores an object', !r.isError && r.text.includes('object'), r.text.slice(0, 200));
    r = await c.call('vars', { action: 'get', name: 'cfg' });
    check('get returns JSON for an object', JSON.parse(r.text).port === 8080, r.text.slice(0, 200));

    r = await c.call('vars', { action: 'list' });
    check('list shows names and types', r.text.includes('sha') && r.text.includes('cfg') && r.text.includes('string'), r.text.slice(0, 300));
    check('list does not dump full values', r.text.includes('values are not shown'), r.text.slice(0, 200));

    r = await c.call('vars', { action: 'get', name: 'nope' });
    check('get on a missing name lists what exists', r.text.includes('not set') && r.text.includes('sha'), r.text.slice(0, 200));

    r = await c.call('vars', { action: 'incr', name: 'counter' });
    check('incr starts from zero', r.text.includes('counter = 1'), r.text.slice(0, 150));
    r = await c.call('vars', { action: 'incr', name: 'counter', delta: 9 });
    check('incr applies a delta', r.text.includes('counter = 10'), r.text.slice(0, 150));

    r = await c.call('vars', { action: 'append', name: 'notes', text: 'first ' });
    r = await c.call('vars', { action: 'append', name: 'notes', text: 'second' });
    r = await c.call('vars', { action: 'get', name: 'notes' });
    check('append accumulates', r.text.trim() === 'first second', JSON.stringify(r.text));

    r = await c.call('vars', { action: 'set', name: 'bad name', value: 1 });
    check('an invalid name is refused', r.isError && r.text.includes('Invalid variable name'), r.text.slice(0, 200));

    r = await c.call('vars', { action: 'set', name: 'x' });
    check('set without a value is an error', r.isError, r.text.slice(0, 150));

    // =========================================== interpolation into tools
    r = await c.call('shell_exec', { command: 'echo commit-${vars.sha}' });
    check('shell_exec expands ${vars.x}', r.text.includes('commit-deadbeef'), r.text.slice(0, 250));

    r = await c.call('shell_exec', { command: 'echo ${vars.cfg.port} and ${vars.cfg.hosts[1]}' });
    check('nested paths and indexes expand', r.text.includes('8080 and b'), r.text.slice(0, 250));

    // The important one: ${...} is also shell syntax and must survive.
    r = await c.call('shell_exec', { command: 'X=shellvar; echo "[${X}]"' });
    check('bash ${VAR} is left for the shell', r.text.includes('[shellvar]'), r.text.slice(0, 250));

    r = await c.call('shell_exec', { command: 'P=a:b:c; echo "${P%%:*}"' });
    check('bash parameter expansion survives', r.text.includes('a') && !r.isError, r.text.slice(0, 250));

    r = await c.call('shell_exec', { command: 'S=abcd; echo ${#S}' });
    check('bash ${#len} survives', r.text.includes('4'), r.text.slice(0, 250));

    r = await c.call('shell_exec', { command: 'echo "tag ${{ matrix.node }}"' });
    check('GitHub Actions syntax does not break the call', !r.isError && r.text.includes('matrix.node'), r.text.slice(0, 250));

    r = await c.call('shell_exec', { command: 'echo ${vars.typo_here}' });
    check('an unknown vars.* reference is reported', r.text.includes('did not resolve'), r.text.slice(0, 300));
    check('the unresolved note lists defined variables', r.text.includes('sha'), r.text.slice(0, 400));

    r = await c.call('shell_exec', { command: 'echo lit $${vars.sha}' });
    check('$${...} escapes to a literal', r.text.includes('${vars.sha}'), r.text.slice(0, 250));

    r = await c.call('shell_exec', { command: 'echo ${env.TMCP_FROM_ENV}' });
    check('${env.X} expands too', r.text.includes('env-value'), r.text.slice(0, 250));

    // cwd, env values and stdin
    await c.call('vars', { action: 'set', name: 'dir', value: dir });
    r = await c.call('shell_exec', { command: 'pwd', cwd: '${vars.dir}' });
    check('cwd expands', r.text.includes(dir.slice(-12)), r.text.slice(0, 250));

    r = await c.call('shell_exec', { command: 'echo "$INJECTED"', env: { INJECTED: '${vars.sha}' } });
    check('env values expand', r.text.includes('deadbeef'), r.text.slice(0, 250));

    // ============================================== capture without echo
    r = await c.call('shell_exec', { command: 'echo captured-value', assign: 'grabbed' });
    check('shell_exec assign stores the output', r.text.includes('stored') && r.text.includes('grabbed'), r.text.slice(0, 300));
    r = await c.call('shell_exec', { command: 'echo using-${vars.grabbed}' });
    check('a captured value is usable next call', r.text.includes('using-captured-value'), r.text.slice(0, 250));

    // ======================================================= file paths
    await writeFile(join(dir, 'target.txt'), 'file contents here\n');
    await c.call('vars', { action: 'set', name: 'fname', value: 'target.txt' });
    r = await c.call('file_read', { path: '${vars.fname}' });
    check('file_read path expands', r.text.includes('file contents here'), r.text.slice(0, 250));

    r = await c.call('fs_op', { action: 'stat', path: '${vars.fname}' });
    check('fs_op path expands', r.text.includes('target.txt') && r.text.includes('type      file'), r.text.slice(0, 250));

    // file CONTENT must NOT be expanded — it may legitimately hold ${...}
    await c.call('file_write', { path: 'tpl.js', content: 'const s = `v=${vars.sha}`;\n' });
    check('file_write content is left alone',
      (await readFile(join(dir, 'tpl.js'), 'utf8')).includes('${vars.sha}'),
      await readFile(join(dir, 'tpl.js'), 'utf8'));

    // ==================================================== bulk integration
    r = await c.call('shell_bulk', {
      steps: [
        { id: 'one', command: 'echo from-the-store-${vars.sha}' },
        { id: 'two', command: 'echo v2', assign: 'second' },
      ],
    });
    check('bulk reads the persistent store', r.text.includes('from-the-store-deadbeef'), r.text.slice(0, 400));
    check('bulk reports only what it assigned', r.text.includes('second=v2') && !r.text.includes('sha=deadbeef'), r.text.slice(0, 500));

    r = await c.call('vars', { action: 'get', name: 'second' });
    check('a bulk assign persists to the store', r.text.trim() === 'v2', JSON.stringify(r.text));

    r = await c.call('shell_exec', { command: 'echo after-bulk-${vars.second}' });
    check('a bulk assign is usable in a later call', r.text.includes('after-bulk-v2'), r.text.slice(0, 250));

    r = await c.call('shell_bulk', { steps: [{ command: 'X=1; echo "${X}-${vars.sha}"' }] });
    check('bulk leaves shell syntax alone too', r.text.includes('1-deadbeef'), r.text.slice(0, 300));

    // ========================================================== secrets
    r = await c.call('vars', { action: 'set', name: 'token', value: 'super-secret-abc', secret: true });
    check('a secret is not echoed when set', !r.text.includes('super-secret-abc') && r.text.includes('(secret)'), r.text.slice(0, 200));

    r = await c.call('vars', { action: 'list' });
    check('a secret is masked in list', !r.text.includes('super-secret-abc') && r.text.includes('(secret)'), r.text.slice(0, 300));

    r = await c.call('vars', { action: 'get', name: 'token' });
    check('get masks a secret by default', !r.text.includes('super-secret-abc'), r.text.slice(0, 200));

    r = await c.call('vars', { action: 'get', name: 'token', reveal: true });
    check('reveal:true returns the secret', r.text.includes('super-secret-abc'), r.text.slice(0, 200));

    r = await c.call('http_request', {
      url: `http://127.0.0.1:${port}/whoami`,
      headers: { Authorization: 'Bearer ${vars.token}' },
    });
    check('a secret works in a request header', r.text.includes('Bearer super-secret-abc'), r.text.slice(0, 300));

    r = await c.call('vars', { action: 'set', name: 'token', value: 'rotated-secret' });
    r = await c.call('vars', { action: 'list' });
    check('re-setting a secret keeps it secret', !r.text.includes('rotated-secret'), r.text.slice(0, 300));

    // ================================================= http integration
    r = await c.call('http_request', { url: `http://127.0.0.1:${port}/data`, assign: 'body' });
    check('http_request assign stores the body', r.text.includes('stored') && r.text.includes('body'), r.text.slice(0, 300));
    r = await c.call('json_tool', { action: 'get', content: '${vars.body}', json_path: 'token' });
    check('a stored body feeds another tool', r.text.includes('tok-from-api'), r.text.slice(0, 250));

    await c.call('vars', { action: 'set', name: 'q', value: 'search-term' });
    r = await c.call('http_request', { url: `http://127.0.0.1:${port}/whoami`, query: { term: '${vars.q}' } });
    check('query params expand', r.text.includes('term=search-term'), r.text.slice(0, 300));

    // =========================================== composing and load/save
    r = await c.call('vars', { action: 'set', name: 'composed', value: 'prefix-${vars.sha}-suffix' });
    check('a string value is itself expanded', r.text.includes('prefix-deadbeef-suffix'), r.text.slice(0, 200));

    r = await c.call('vars', { action: 'load', name: 'loaded', path: 'target.txt' });
    check('load reads a file into a variable', r.text.includes('loaded'), r.text.slice(0, 200));
    r = await c.call('vars', { action: 'get', name: 'loaded' });
    check('the loaded value is the file content', r.text.includes('file contents here'), r.text.slice(0, 200));

    await writeFile(join(dir, 'obj.json'), JSON.stringify({ deep: { n: 7 } }));
    await c.call('vars', { action: 'load', name: 'objvar', path: 'obj.json', json: true });
    r = await c.call('shell_exec', { command: 'echo n=${vars.objvar.deep.n}' });
    check('load json:true parses structure', r.text.includes('n=7'), r.text.slice(0, 250));

    r = await c.call('vars', { action: 'save', name: 'sha', path: 'out.txt' });
    check('save writes a variable to a file', r.text.includes('wrote sha'), r.text.slice(0, 200));
    check('the saved file has the value', (await readFile(join(dir, 'out.txt'), 'utf8')).includes('deadbeef'));

    // ============================================================ delete
    r = await c.call('vars', { action: 'delete', name: 'counter' });
    check('delete removes a variable', r.text.includes('deleted 1'), r.text.slice(0, 200));
    r = await c.call('vars', { action: 'delete', names: ['notes', 'never-existed'] });
    check('delete reports what was not set', r.text.includes('not set: never-existed'), r.text.slice(0, 200));

    r = await c.call('vars', { action: 'clear' });
    check('clear without confirm only previews', r.text.includes('Would delete') && r.text.includes('confirm:true'), r.text.slice(0, 250));
    r = await c.call('vars', { action: 'list' });
    check('the preview really did not clear', r.text.includes('sha'), r.text.slice(0, 200));

    // ======================================================= shell_info
    r = await c.call('shell_info', {});
    check('shell_info reports the variable count', /variables: \d+ set/.test(r.text), r.text.slice(0, 500));

    r = await c.call('vars', { action: 'clear', confirm: true });
    check('clear with confirm empties the store', r.text.includes('cleared'), r.text.slice(0, 200));
    r = await c.call('vars', { action: 'list' });
    check('the store is empty after clear', r.text.includes('No variables set'), r.text.slice(0, 200));

    c.close();

    // ====================================== persistence across restarts
    {
      const varsFile = join(dir, 'store.json');
      const a = await new Client(dir, ['--vars-file', varsFile]).init();
      await a.call('vars', { action: 'set', name: 'kept', value: 'survives-restart' });
      await a.call('vars', { action: 'set', name: 'hidden', value: 'not-on-disk', secret: true });
      let res = await a.call('vars', { action: 'list' });
      check('the mirrored store works in memory', res.text.includes('kept'), res.text.slice(0, 200));
      a.close();
      await new Promise((r2) => setTimeout(r2, 700));

      const onDisk = await readFile(varsFile, 'utf8').catch(() => '');
      check('the store file was written', onDisk.includes('survives-restart'), onDisk.slice(0, 200));
      check('secrets are not written to disk by default', !onDisk.includes('not-on-disk'), onDisk.slice(0, 300));

      const b = await new Client(dir, ['--vars-file', varsFile]).init();
      res = await b.call('vars', { action: 'get', name: 'kept' });
      check('a variable survives a restart', res.text.trim() === 'survives-restart', JSON.stringify(res.text));
      res = await b.call('vars', { action: 'get', name: 'hidden' });
      check('a secret does not survive a restart', res.text.includes('not set'), res.text.slice(0, 200));
      b.close();

      // A corrupt store must not stop the server. Wait for b's shutdown flush
      // first: kill() returns before the child has written the file, and that
      // write would otherwise land on top of the corruption.
      await new Promise((r2) => setTimeout(r2, 700));
      await writeFile(varsFile, '{ this is not json');
      const d = await new Client(dir, ['--vars-file', varsFile]).init();
      res = await d.call('vars', { action: 'list' });
      check('a corrupt store file is reported, not fatal', res.text.includes('store warning'), res.text.slice(0, 300));
      res = await d.call('vars', { action: 'set', name: 'again', value: 'ok' });
      check('the store still works after a corrupt load', !res.isError, res.text.slice(0, 200));
      d.close();
    }

    // ============================================================= caps
    {
      const e = await new Client(dir, ['--max-var-bytes', '40']).init();
      let res = await e.call('vars', { action: 'set', name: 'toobig', value: 'x'.repeat(200) });
      check('an oversized value is refused with a hint', res.isError && res.text.includes('byte limit'), res.text.slice(0, 250));
      res = await e.call('vars', { action: 'set', name: 'fits', value: 'small' });
      check('a value within the cap is accepted', !res.isError, res.text.slice(0, 200));
      e.close();
    }
  } finally {
    httpSrv.close();
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
