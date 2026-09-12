// End-to-end test: spawns the real server and talks MCP over stdio.
// Run with: npm test   (or: node test/smoke.mjs)

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'bin', 'terminalmcp.js');
const IS_WIN = process.platform === 'win32';

let passed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

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
      try { msg = JSON.parse(line); } catch { console.log('  !! non-JSON on stdout:', line); continue; }
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); p(msg); }
    }
  }

  send(method, params) {
    const id = ++this.id;
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout waiting for ${method}`)), 60000);
      this.pending.set(id, (msg) => { clearTimeout(t); res(msg); });
    });
  }

  notify(method, params) {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async call(name, args) {
    const res = await this.send('tools/call', { name, arguments: args });
    if (res.error) return { isError: true, text: res.error.message };
    return { isError: Boolean(res.result?.isError), text: res.result?.content?.[0]?.text ?? '' };
  }

  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

const nodeCmd = (script) => `"${process.execPath}" -e "${script.replace(/"/g, '\\"')}"`;

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'terminalmcp-test-'));
  const c = new Client(dir);

  try {
    // ---------------------------------------------------------- handshake
    const init = await c.send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '1.0' },
    });
    check('initialize returns serverInfo', init.result?.serverInfo?.name === 'terminalmcp', JSON.stringify(init).slice(0, 200));
    check('initialize echoes protocol version', init.result?.protocolVersion === '2025-06-18');
    check('initialize advertises tools capability', Boolean(init.result?.capabilities?.tools));
    c.notify('notifications/initialized', {});

    const ping = await c.send('ping', {});
    check('ping replies', ping.result !== undefined && !ping.error);

    const list = await c.send('tools/list', {});
    const names = (list.result?.tools ?? []).map((t) => t.name);
    // The default profile is "all"; the core-only profile is checked below.
    check('tools/list exposes the full profile', names.length === 28, `${names.length}: ${names.join(',')}`);
    check('core tools are present', ['shell_exec', 'shell_bulk', 'file_edit'].every((n) => names.includes(n)), names.join(','));
    check('extended groups are present', ['search_text', 'git', 'fs_op', 'archive', 'sys_info', 'proc', 'http_request', 'net', 'pkg', 'project_info', 'code', 'json_tool', 'diff', 'encode', 'watch', 'vars'].every((n) => names.includes(n)), names.join(','));
    check('every tool has an inputSchema', (list.result?.tools ?? []).every((t) => t.inputSchema?.type === 'object'));

    const bogus = await c.send('does/not/exist', {});
    check('unknown method -> -32601', bogus.error?.code === -32601);

    // ------------------------------------------------------------ exec
    let r = await c.call('shell_exec', { command: 'echo hello-terminalmcp' });
    check('shell_exec echoes', !r.isError && r.text.includes('hello-terminalmcp') && r.text.includes('exit=0'), r.text);

    r = await c.call('shell_exec', { command: nodeCmd('process.exit(3)') });
    check('shell_exec reports exit=3', r.text.includes('exit=3'), r.text);

    r = await c.call('shell_exec', { command: nodeCmd('console.error("to-stderr")') });
    check('shell_exec separates stderr', r.text.includes('--- stderr ---') && r.text.includes('to-stderr'), r.text);

    r = await c.call('shell_exec', { command: nodeCmd('console.error("merged-err")'), merge_streams: true });
    check('merge_streams folds stderr in', r.text.includes('merged-err') && !r.text.includes('--- stderr ---'), r.text);

    r = await c.call('shell_exec', { command: nodeCmd('console.log("x".repeat(50000))'), max_output_bytes: 2000 });
    check('max_output_bytes truncates', r.text.includes('omitted') && r.text.length < 6000, `len=${r.text.length}`);

    r = await c.call('shell_exec', { command: nodeCmd('console.log("quiet-body")'), quiet: true });
    check('quiet returns only the exit line', !r.text.includes('quiet-body') && r.text.includes('exit=0'), r.text);

    r = await c.call('shell_exec', { command: nodeCmd('setTimeout(()=>{},60000)'), timeout_ms: 1200 });
    check('timeout_ms kills the command', r.text.includes('TIMED_OUT'), r.text);

    if (!IS_WIN) {
      // A timeout must take down grandchildren too, not leave orphans behind.
      // The [7] character class keeps the checking command from matching its
      // own command line, which contains the pattern verbatim.
      r = await c.call('shell_exec', {
        command: "bash -c 'sleep 31337' & sleep 31337",
        timeout_ms: 900,
      });
      check('timeout on a tree reports TIMED_OUT', r.text.includes('TIMED_OUT'), r.text);
      // Signal delivery and reaping are asynchronous, so poll for a few
      // seconds rather than counting once and racing the kernel.
      r = await c.call('shell_exec', {
        command:
          "for i in $(seq 1 25); do n=$(pgrep -fc 'sleep 3133[7]'); " +
          '[ "$n" = "0" ] && break; sleep 0.2; done; echo "COUNT=$n"',
        timeout_ms: 15000,
      });
      const orphans = Number((r.text.match(/COUNT=(\d+)/) || [])[1]);
      check('timeout kills the whole process tree', orphans === 0, `orphans=${orphans} :: ${r.text}`);
    }

    r = await c.call('shell_exec', { command: IS_WIN ? 'cd' : 'pwd', cwd: dir });
    check('cwd param applies', r.text.toLowerCase().includes(dir.toLowerCase().slice(-12)), r.text);

    r = await c.call('shell_exec', { command: IS_WIN ? 'echo %TMCP_X%' : 'echo $TMCP_X', env: { TMCP_X: 'envworks' } });
    check('env param applies', r.text.includes('envworks'), r.text);

    r = await c.call('shell_exec', { command: nodeCmd('process.stdin.on("data",d=>console.log("got:"+d.toString().trim()))'), stdin: 'piped-in' });
    check('stdin is piped', r.text.includes('got:piped-in'), r.text);

    r = await c.call('shell_exec', { command: '' });
    check('empty command is an error', r.isError, r.text);

    r = await c.call('shell_exec', { command: 'echo x', cwd: join(dir, 'definitely-missing') });
    check('missing cwd is an error', r.isError && /does not exist/.test(r.text), r.text);

    // ------------------------------------------------------------ async
    r = await c.call('shell_exec_async', {
      command: nodeCmd('let i=0;const t=setInterval(()=>{console.log("tick"+(++i));if(i>=3){clearInterval(t)}},250)'),
      name: 'ticker',
    });
    const jobId = (r.text.match(/job_id=(\S+)/) || [])[1];
    check('shell_exec_async returns a job_id', Boolean(jobId), r.text);

    r = await c.call('shell_job', { action: 'list' });
    check('shell_job list shows the job', r.text.includes(jobId) && r.text.includes('ticker'), r.text);

    r = await c.call('shell_job', { action: 'output', job_id: jobId, wait_ms: 4000 });
    check('shell_job output streams', r.text.includes('tick1'), r.text);
    const off = Number((r.text.match(/next_offset=(\d+)/) || [])[1]);
    check('output reports next_offset', Number.isFinite(off) && off > 0);

    r = await c.call('shell_job', { action: 'wait', job_id: jobId, wait_ms: 8000 });
    check('shell_job wait sees exit', r.text.includes('EXITED') && r.text.includes('exit=0'), r.text);

    r = await c.call('shell_job', { action: 'output', job_id: jobId, offset: off });
    check('incremental read skips seen bytes', !r.text.includes('tick1'), r.text);

    r = await c.call('shell_exec_async', { command: nodeCmd('setTimeout(()=>{},60000)') });
    const killId = (r.text.match(/job_id=(\S+)/) || [])[1];
    r = await c.call('shell_job', { action: 'kill', job_id: killId });
    check('shell_job kill terminates', /terminated|kill signal/.test(r.text), r.text);

    r = await c.call('shell_job', { action: 'status', job_id: 'job-nope' });
    check('unknown job_id is an error', r.isError && r.text.includes('Unknown job_id'), r.text);

    r = await c.call('shell_exec_async', {
      command: nodeCmd('process.stdin.on("data",d=>{console.log("echo:"+d.toString().trim());process.exit(0)})'),
      interactive: true,
    });
    const interId = (r.text.match(/job_id=(\S+)/) || [])[1];
    await c.call('shell_job', { action: 'write', job_id: interId, data: 'ping\n' });
    r = await c.call('shell_job', { action: 'output', job_id: interId, wait_ms: 4000 });
    check('interactive stdin round-trips', r.text.includes('echo:ping'), r.text);

    // ------------------------------------------------------------- bulk
    r = await c.call('shell_bulk', {
      steps: [
        { id: 'one', command: 'echo first' },
        { id: 'two', command: 'echo second' },
      ],
    });
    check('bulk runs steps in order', r.text.includes('first') && r.text.includes('second') && r.text.includes('2 ok'), r.text);
    check('bulk reports step ids', r.text.includes('[1] one') && r.text.includes('[2] two'), r.text);

    r = await c.call('shell_bulk', {
      steps: [
        { id: 'fail', command: nodeCmd('process.exit(1)') },
        { id: 'after', command: 'echo should-not-run' },
      ],
    });
    check('bulk stops on failure by default', r.text.includes('ABORTED') && !r.text.includes('should-not-run'), r.text);

    r = await c.call('shell_bulk', {
      stop_on_failure: false,
      steps: [
        { id: 'fail', command: nodeCmd('process.exit(1)'), on_failure: 'continue' },
        { id: 'after', command: 'echo ran-anyway' },
      ],
    });
    check('on_failure=continue keeps going', r.text.includes('ran-anyway'), r.text);

    r = await c.call('shell_bulk', {
      steps: [
        { id: 'a', command: 'echo yes' },
        { id: 'b', command: 'echo conditional-ran', when: 'prev.ok && contains(prev.stdout, "yes")' },
        { id: 'c', command: 'echo skipped-me', when: 'prev_failure' },
      ],
    });
    check('when condition runs matching step', r.text.includes('conditional-ran'), r.text);
    check('when condition skips non-matching step', r.text.includes('[3] c SKIPPED'), r.text);

    r = await c.call('shell_bulk', {
      steps: [
        { id: 'get', command: 'echo v9.9.9', assign: 'ver' },
        { id: 'use', command: 'echo using-${vars.ver}' },
      ],
    });
    check('assign + interpolation work', r.text.includes('using-v9.9.9'), r.text);

    r = await c.call('shell_bulk', {
      steps: [{ id: 'tolerant', command: nodeCmd('process.exit(2)'), expect_exit: [0, 2] }],
    });
    check('expect_exit accepts listed codes', r.text.includes('1 ok') && !r.text.includes('ABORTED'), r.text);

    const t0 = Date.now();
    r = await c.call('shell_bulk', { steps: [{ command: 'echo delayed', delay_before_ms: 700 }] });
    check('delay_before_ms delays the step', Date.now() - t0 >= 650, `elapsed=${Date.now() - t0}`);

    r = await c.call('shell_bulk', {
      steps: [{ id: 'flaky', command: nodeCmd('process.exit(1)'), retry: { count: 2, delay_ms: 10 } }],
    });
    check('retry re-attempts the step', r.text.includes('attempts=3'), r.text);

    r = await c.call('shell_bulk', {
      capture: 'on_failure',
      stop_on_failure: false,
      steps: [
        // Output must differ from the command text: bulk always echoes the command.
        { id: 'quiet', command: nodeCmd('console.log("h"+"idden-output")') },
        { id: 'loud', command: nodeCmd('console.log("shown-output");process.exit(1)'), on_failure: 'continue' },
      ],
    });
    check('capture=on_failure hides passing output', !r.text.includes('hidden-output'), r.text);
    check('capture=on_failure shows failing output', r.text.includes('shown-output'), r.text);

    r = await c.call('shell_bulk', { steps: [{ command: 'echo x', when: 'this is (not valid' }] });
    check('bad when expression is an error', r.isError, r.text);

    r = await c.call('shell_bulk', {
      stop_on_failure: false,
      steps: [
        { id: 'good', command: 'echo ran-before-the-bad-step' },
        { id: 'badshell', command: 'echo x', shell: 'no-such-shell-xyz', on_failure: 'continue' },
        { id: 'badcwd', command: 'echo x', cwd: '/definitely/not/here', on_failure: 'continue' },
        { id: 'after', command: 'echo ran-after-too' },
      ],
    });
    check('unlaunchable step does not discard earlier results', r.text.includes('ran-before-the-bad-step') && r.text.includes('ran-after-too'), r.text);
    check('unlaunchable step is reported as a failure', r.text.includes('2 failed'), r.text);

    r = await c.call('shell_bulk', { steps: [] });
    check('empty steps is an error', r.isError, r.text);

    // ------------------------------------------------------------ files
    const target = join(dir, 'sub', 'demo.txt');
    r = await c.call('file_write', { path: target, content: 'line1\nline2\nline3\nline4\nline5\n' });
    check('file_write creates dirs and file', !r.isError && r.text.includes('created'), r.text);
    check('file_write reports line count', r.text.includes('5 lines'), r.text);

    r = await c.call('file_read', { path: target });
    check('file_read returns whole file numbered', r.text.includes('1│line1') && r.text.includes('5│line5'), r.text);

    r = await c.call('file_read', { path: target, start_line: 2, end_line: 3 });
    check('file_read honours a line range', r.text.includes('line2') && r.text.includes('line3') && !r.text.includes('line5'), r.text);

    r = await c.call('file_read', { path: target, tail_lines: 2 });
    check('tail_lines works', r.text.includes('line4') && !r.text.includes('line1'), r.text);

    r = await c.call('file_read', { path: target, head_lines: 1 });
    check('head_lines works', r.text.includes('line1') && !r.text.includes('line2'), r.text);

    r = await c.call('file_read', { path: target, start_line: -2 });
    check('negative start_line counts from the end', r.text.includes('line4') && !r.text.includes('line2'), r.text);

    r = await c.call('file_read', { path: target, match: 'line[24]' });
    check('match returns only matching lines', r.text.includes('line2') && r.text.includes('line4') && !r.text.includes('line3'), r.text);

    r = await c.call('file_read', { path: target, match: 'line3', context: 1 });
    check('match context includes neighbours', r.text.includes('line2') && r.text.includes('line4'), r.text);

    r = await c.call('file_read', { path: target, match: 'nothing-here' });
    check('match with no hits says so', r.text.includes('no line matches'), r.text);

    r = await c.call('file_read', { path: join(dir, 'ghost.txt') });
    check('reading a missing file is an error', r.isError && r.text.includes('not found'), r.text);

    r = await c.call('file_write', { path: target, content: 'appended\n', mode: 'append' });
    check('append mode appends', !r.isError && r.text.includes('appended to'), r.text);
    check('append keeps earlier lines', (await readFile(target, 'utf8')).startsWith('line1'));
    check('append added the line', (await readFile(target, 'utf8')).includes('appended'));

    r = await c.call('file_write', { path: target, content: 'x', mode: 'create_new' });
    check('create_new refuses to clobber', r.isError && r.text.includes('Refusing'), r.text);

    // multi-op edit, line numbers against the original
    await writeFile(target, 'alpha\nbravo\ncharlie\ndelta\necho\n');
    r = await c.call('file_edit', {
      path: target,
      ops: [
        { type: 'replace_lines', start_line: 1, content: 'ALPHA' },
        { type: 'delete_lines', start_line: 3, end_line: 3 },
        { type: 'insert_after', start_line: 5, content: 'foxtrot' },
        { type: 'replace_text', old: 'bravo', new: 'BRAVO' },
      ],
    });
    let body = await readFile(target, 'utf8');
    check('file_edit applied all 4 ops', !r.isError, r.text);
    check('edit: replace_lines', body.includes('ALPHA') && !body.includes('alpha'), body);
    check('edit: delete_lines removed charlie', !body.includes('charlie'), body);
    check('edit: insert_after appended foxtrot', body.includes('foxtrot'), body);
    check('edit: replace_text', body.includes('BRAVO'), body);
    check('edit: untouched line survives', body.includes('delta'), body);

    r = await c.call('file_edit', { path: target, ops: [{ type: 'replace_text', old: 'not-present', new: 'x' }] });
    check('replace_text missing text is an error', r.isError && r.text.includes('not found'), r.text);

    await writeFile(target, 'dup\ndup\n');
    r = await c.call('file_edit', { path: target, ops: [{ type: 'replace_text', old: 'dup', new: 'uniq' }] });
    check('replace_text refuses ambiguous match', r.isError && r.text.includes('expected 1'), r.text);

    r = await c.call('file_edit', { path: target, ops: [{ type: 'replace_text', old: 'dup', new: 'uniq', all: true }] });
    body = await readFile(target, 'utf8');
    check('replace_text all=true replaces both', !r.isError && body === 'uniq\nuniq\n', JSON.stringify(body));

    await writeFile(target, 'a\nb\nc\nd\n');
    r = await c.call('file_edit', {
      path: target,
      ops: [
        { type: 'replace_lines', start_line: 1, end_line: 2, content: 'X' },
        { type: 'replace_lines', start_line: 2, end_line: 3, content: 'Y' },
      ],
    });
    check('overlapping ranges are rejected', r.isError && r.text.includes('Overlapping'), r.text);
    check('rejected edit left the file untouched', (await readFile(target, 'utf8')) === 'a\nb\nc\nd\n');

    r = await c.call('file_edit', {
      path: target,
      dry_run: true,
      ops: [{ type: 'replace_lines', start_line: 1, content: 'CHANGED' }],
    });
    check('dry_run previews without writing', r.text.includes('DRY RUN') && r.text.includes('CHANGED'), r.text);
    check('dry_run really did not write', (await readFile(target, 'utf8')) === 'a\nb\nc\nd\n');

    r = await c.call('file_edit', {
      path: target,
      ops: [{ type: 'replace_lines', start_line: 2, content: 'Z', expect_match: 'not-there' }],
    });
    check('expect_match guards stale line numbers', r.isError && r.text.includes('expect_match'), r.text);

    r = await c.call('file_edit', { path: target, ops: [{ type: 'regex_replace', pattern: '^b$', flags: 'm', replacement: 'BEE' }] });
    check('regex_replace works', !r.isError && (await readFile(target, 'utf8')).includes('BEE'), r.text);

    r = await c.call('file_edit', { path: target, ops: [{ type: 'replace_lines', start_line: 99, content: 'x' }] });
    check('out-of-range line is an error', r.isError && r.text.includes('out of range'), r.text);

    // binary handling
    await writeFile(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    r = await c.call('file_read', { path: join(dir, 'blob.bin') });
    check('binary file is flagged, not dumped', r.text.includes('BINARY'), r.text);
    r = await c.call('file_read', { path: join(dir, 'blob.bin'), encoding: 'base64' });
    check('base64 read works', r.text.includes('base64') && r.text.includes('AAECAwD/'), r.text);

    // ----------------------------------------------------------- fs_list
    r = await c.call('fs_list', { path: dir });
    check('fs_list lists entries', r.text.includes('demo.txt') === false && r.text.includes('sub/'), r.text);
    r = await c.call('fs_list', { path: dir, depth: 2 });
    check('fs_list recurses with depth', r.text.includes('sub/demo.txt'), r.text);
    r = await c.call('fs_list', { path: dir, depth: 2, pattern: '*.bin' });
    check('fs_list pattern filters', r.text.includes('blob.bin') && !r.text.includes('demo.txt'), r.text);

    // --------------------------------------------------------- shell_info
    r = await c.call('shell_info', {});
    check('shell_info reports the platform', r.text.includes(process.platform), r.text);
    check('shell_info reports the active shell', r.text.includes('active shell:'), r.text);
    check('shell_info says access is unrestricted', r.text.includes('none (full access)'), r.text);

    // ------------------------------------------------------ unknown tool
    r = await c.send('tools/call', { name: 'nope', arguments: {} });
    check('unknown tool is rejected', r.error?.code === -32602, JSON.stringify(r).slice(0, 200));

    check('nothing but protocol went to stdout', true);
    check('server logged to stderr', c.stderr.includes('[terminalmcp]'), c.stderr.slice(0, 200));
    // ------------------------------------------------------ tool profiles
    {
      const core = new Client(dir, ['--tools', 'core']);
      await core.send('initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'profile-test', version: '1' },
      });
      const coreList = await core.send('tools/list', {});
      const coreNames = (coreList.result?.tools ?? []).map((t) => t.name);
      // core + vars: the vars group is always on, since ${vars.…} expansion always is.
      check('--tools core exposes the core group plus vars', coreNames.length === 10 && coreNames.includes('vars'), coreNames.join(','));
      check('--tools core drops the extra groups', !coreNames.includes('git') && !coreNames.includes('search_text'), coreNames.join(','));
      const gone = await core.call('git', { action: 'status' });
      check('a tool outside the profile is rejected', gone.isError, gone.text.slice(0, 120));
      const info = await core.call('shell_info', {});
      check('shell_info reports the active profile', /tools: 10 in groups \[core vars\]/.test(info.text), info.text.slice(0, 300));
      core.close();

      const dev = new Client(dir, ['--tools', 'dev']);
      await dev.send('initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'profile-test', version: '1' },
      });
      const devNames = ((await dev.send('tools/list', {})).result?.tools ?? []).map((t) => t.name);
      check('--tools dev includes git and search', devNames.includes('git') && devNames.includes('search_text'), devNames.join(','));
      check('--tools dev excludes watch and sys', !devNames.includes('watch') && !devNames.includes('sys_info'), devNames.join(','));
      dev.close();

      const trimmed = new Client(dir, ['--tools', 'all,-watch,-archive']);
      await trimmed.send('initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'profile-test', version: '1' },
      });
      const trimmedNames = ((await trimmed.send('tools/list', {})).result?.tools ?? []).map((t) => t.name);
      check('removals in a profile work', trimmedNames.length === 26 && !trimmedNames.includes('watch') && !trimmedNames.includes('archive'), trimmedNames.join(','));
      trimmed.close();
    }

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
