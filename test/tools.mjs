// Tests for the extended tool groups: search, git, fs, archive, sys, net,
// dev, data, watch. Drives the real server over stdio.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
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
const sleep = (n) => new Promise((r) => setTimeout(r, n));

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
      const t = setTimeout(() => rej(new Error(`timeout on ${method}`)), 120000);
      this.pending.set(id, (m) => { clearTimeout(t); res(m); });
    });
  }
  async call(name, args) {
    const res = await this.send('tools/call', { name, arguments: args });
    if (res.error) return { isError: true, text: res.error.message };
    return { isError: Boolean(res.result?.isError), text: res.result?.content?.[0]?.text ?? '' };
  }
  close() { this.proc.stdin.end(); this.proc.kill(); }
}

/** Build a small project tree to search, pack, inspect and commit. */
async function fixture(dir) {
  await mkdir(join(dir, 'src', 'lib'), { recursive: true });
  await mkdir(join(dir, 'node_modules', 'junk'), { recursive: true });
  await mkdir(join(dir, 'docs'), { recursive: true });

  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'fixture-app',
    version: '2.3.4',
    main: 'src/index.js',
    scripts: { build: 'echo building', test: 'echo testing', lint: 'echo linting' },
    dependencies: { express: '^4.18.0', react: '^18.2.0' },
    devDependencies: { vitest: '^1.0.0', typescript: '^5.3.0' },
  }, null, 2) + '\n');

  await writeFile(join(dir, 'src', 'index.js'), [
    "import express from 'express';",
    "import { helper } from './lib/helper.js';",
    '',
    '// TODO: add error handling',
    'export function createApp() {',
    '  const app = express();',
    '  return app;',
    '}',
    '',
    'export class Server {',
    '  start() {',
    '    return helper();',
    '  }',
    '}',
    '',
    'export const shutdown = () => { /* FIXME: not implemented */ };',
    '',
  ].join('\n'));

  await writeFile(join(dir, 'src', 'lib', 'helper.js'), [
    'export function helper() {',
    "  return 'needle-in-a-haystack';",
    '}',
    '',
    '// HACK: temporary',
    '',
  ].join('\n'));

  await writeFile(join(dir, 'src', 'app.ts'), [
    'export interface Config {',
    '  port: number;',
    '}',
    'export type Mode = "dev" | "prod";',
    'export async function boot(config: Config): Promise<void> {',
    '  console.log(config.port);',
    '}',
    '',
  ].join('\n'));

  await writeFile(join(dir, 'docs', 'readme.md'), '# Fixture\n\nneedle appears here too.\n');
  await writeFile(join(dir, 'node_modules', 'junk', 'ignored.js'), "// needle should not be found here\n");
  await writeFile(join(dir, '.gitignore'), 'node_modules/\n*.log\nbuild/\n');
  await writeFile(join(dir, 'debug.log'), 'needle in an ignored log\n');
  await writeFile(join(dir, 'data.json'), JSON.stringify({
    name: 'cfg', nested: { list: [10, 20, 30], flag: true }, keep: 'me',
  }, null, 2) + '\n');
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'tmcp-tools-'));
  await fixture(dir);
  const c = new Client(dir);

  // A local HTTP server so http_request is tested against something real.
  let hits = 0;
  const httpSrv = createServer((req, res) => {
    hits++;
    if (req.url === '/json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'abc123' });
      res.end(JSON.stringify({ ok: true, items: [1, 2, 3] }));
      return;
    }
    if (req.url === '/echo' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: body, contentType: req.headers['content-type'] }));
      });
      return;
    }
    if (req.url === '/boom') { res.writeHead(500); res.end('kaboom'); return; }
    res.writeHead(404); res.end('nope');
  });
  const httpPort = await new Promise((resolve) => {
    httpSrv.listen(0, '127.0.0.1', () => resolve(httpSrv.address().port));
  });
  const base = `http://127.0.0.1:${httpPort}`;

  try {
    await c.send('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tools-test', version: '1' },
    });

    // ======================================================= search_text
    let r = await c.call('search_text', { pattern: 'needle' });
    check('search_text finds matches', r.text.includes('src/lib/helper.js') && r.text.includes('docs/readme.md'), r.text.slice(0, 300));
    check('search_text honours .gitignore', !r.text.includes('node_modules') && !r.text.includes('debug.log'), r.text.slice(0, 400));
    check('search_text shows line numbers', /\d+:.*needle/.test(r.text), r.text.slice(0, 300));

    r = await c.call('search_text', { pattern: 'needle', files_only: true });
    check('files_only lists files without lines', r.text.includes('helper.js') && !r.text.includes('return'), r.text.slice(0, 200));

    r = await c.call('search_text', { pattern: 'needle', count_only: true });
    check('count_only reports tallies', /\d+ (src|docs)/.test(r.text), r.text.slice(0, 200));

    r = await c.call('search_text', { pattern: 'needle', glob: ['*.md'] });
    check('glob narrows the search', r.text.includes('readme.md') && !r.text.includes('helper.js'), r.text.slice(0, 200));

    r = await c.call('search_text', { pattern: 'NEEDLE', ignore_case: true });
    check('ignore_case works', r.text.includes('helper.js'), r.text.slice(0, 200));

    r = await c.call('search_text', { pattern: 'export function', literal: true, context: 1 });
    check('literal + context works', r.text.includes('export function') && r.text.includes('-'), r.text.slice(0, 300));

    r = await c.call('search_text', { pattern: 'definitely-not-present-anywhere' });
    check('no matches says so', r.text.includes('no matches'), r.text);

    r = await c.call('search_text', { pattern: '(unclosed' });
    check('an invalid regex is an error', r.isError && /Invalid pattern/.test(r.text), r.text.slice(0, 150));

    // replace, dry run first
    r = await c.call('search_text', { pattern: 'needle', replace: 'thread', dry_run: true, glob: ['*.md'] });
    check('replace dry_run shows a diff', r.text.includes('DRY RUN') && r.text.includes('-needle') && r.text.includes('+thread'), r.text.slice(0, 400));
    check('replace dry_run does not write', (await readFile(join(dir, 'docs', 'readme.md'), 'utf8')).includes('needle'));

    r = await c.call('search_text', { pattern: 'needle', replace: 'thread', glob: ['*.md'] });
    check('replace rewrites the file', r.text.includes('rewritten'), r.text.slice(0, 200));
    check('replace really changed the content', (await readFile(join(dir, 'docs', 'readme.md'), 'utf8')).includes('thread'));

    // ======================================================= search_files
    r = await c.call('search_files', { glob: ['*.js'] });
    check('search_files finds by glob', r.text.includes('src/index.js') && r.text.includes('helper.js'), r.text.slice(0, 300));
    check('search_files honours .gitignore', !r.text.includes('node_modules'), r.text.slice(0, 300));

    r = await c.call('search_files', { type: 'dir' });
    check('search_files can list dirs', r.text.includes('src/') && r.text.includes('docs/'), r.text.slice(0, 200));

    r = await c.call('search_files', { glob: ['*.js'], sort: 'size' });
    check('search_files sorts by size', r.text.includes('sorted by size'), r.text.slice(0, 150));

    r = await c.call('search_files', { glob: ['*.nothing'] });
    check('search_files with no hits says so', r.text.includes('nothing matched'), r.text.slice(0, 150));

    // ============================================================== code
    r = await c.call('code', { action: 'outline', path: 'src/index.js' });
    check('code outline finds a function', r.text.includes('createApp'), r.text.slice(0, 300));
    check('code outline finds a class', r.text.includes('class Server'), r.text.slice(0, 300));
    check('code outline finds an arrow const', r.text.includes('shutdown'), r.text.slice(0, 300));

    r = await c.call('code', { action: 'outline', path: 'src/app.ts' });
    check('outline handles TypeScript', r.text.includes('interface Config') && r.text.includes('type Mode'), r.text.slice(0, 300));

    r = await c.call('code', { action: 'imports', path: 'src/index.js' });
    check('code imports separates external and local', r.text.includes('express') && r.text.includes('./lib/helper.js'), r.text.slice(0, 300));

    r = await c.call('code', { action: 'todos' });
    check('code todos finds all markers', r.text.includes('TODO') && r.text.includes('FIXME') && r.text.includes('HACK'), r.text.slice(0, 400));

    r = await c.call('code', { action: 'stats' });
    check('code stats reports languages', /JavaScript/.test(r.text) && /lines of code/.test(r.text), r.text.slice(0, 300));

    r = await c.call('code', { action: 'outline', path: 'src' });
    check('outline on a directory is an error', r.isError, r.text.slice(0, 150));

    // ====================================================== project_info
    r = await c.call('project_info', {});
    check('project_info names the project', r.text.includes('fixture-app') && r.text.includes('2.3.4'), r.text.slice(0, 400));
    check('project_info detects the manager', /manager\s+npm/.test(r.text), r.text.slice(0, 400));
    check('project_info lists scripts', r.text.includes('build') && r.text.includes('lint'), r.text.slice(0, 600));
    check('project_info detects frameworks', r.text.includes('React') && r.text.includes('Express'), r.text.slice(0, 800));
    check('project_info counts languages', /JavaScript\s+\d+ files/.test(r.text), r.text.slice(0, 600));
    check('project_info suggests commands', r.text.includes('likely commands'), r.text.slice(0, 800));

    // =============================================================== pkg
    r = await c.call('pkg', { action: 'detect' });
    check('pkg detects npm', r.text.includes('npm'), r.text.slice(0, 200));
    r = await c.call('pkg', { action: 'scripts' });
    check('pkg lists scripts', r.text.includes('build') && r.text.includes('echo building'), r.text.slice(0, 300));
    r = await c.call('pkg', { action: 'run', script: 'build' });
    check('pkg run executes a script', r.text.includes('building'), r.text.slice(0, 300));
    r = await c.call('pkg', { action: 'run' });
    check('pkg run without a script is an error', r.isError, r.text.slice(0, 150));
    r = await c.call('pkg', { action: 'detect', manager: 'not-a-manager' });
    check('an unknown manager is an error', r.isError && r.text.includes('Unknown manager'), r.text.slice(0, 150));

    // ============================================================ fs_op
    r = await c.call('fs_op', { action: 'stat', path: 'package.json' });
    check('fs_op stat reports a file', r.text.includes('type      file') && r.text.includes('size'), r.text.slice(0, 300));

    r = await c.call('fs_op', { action: 'copy', path: 'package.json', to: 'copy.json' });
    check('fs_op copy works', r.text.includes('copied'), r.text.slice(0, 150));
    r = await c.call('fs_op', { action: 'copy', path: 'package.json', to: 'copy.json' });
    check('copy refuses to clobber', r.isError && r.text.includes('force:true'), r.text.slice(0, 150));
    r = await c.call('fs_op', { action: 'copy', path: 'package.json', to: 'copy.json', force: true });
    check('copy with force overwrites', !r.isError, r.text.slice(0, 150));

    r = await c.call('fs_op', { action: 'move', path: 'copy.json', to: 'moved.json' });
    check('fs_op move works', r.text.includes('moved'), r.text.slice(0, 150));

    r = await c.call('fs_op', { action: 'hash', path: 'moved.json', algorithm: 'sha256' });
    check('fs_op hash returns a digest', /sha256 [0-9a-f]{64}/.test(r.text), r.text.slice(0, 150));

    r = await c.call('fs_op', { action: 'mkdir', path: 'newdir/sub' });
    check('fs_op mkdir is recursive', r.text.includes('created directory'), r.text.slice(0, 150));

    r = await c.call('fs_op', { action: 'delete', path: 'src' });
    check('delete refuses a non-empty dir', r.isError && r.text.includes('recursive:true'), r.text.slice(0, 200));

    r = await c.call('fs_op', { action: 'delete', path: 'moved.json' });
    check('fs_op delete removes a file', r.text.includes('deleted'), r.text.slice(0, 150));

    r = await c.call('fs_op', { action: 'tree', path: '.', depth: 2 });
    check('fs_op tree is indented', r.text.includes('src/') && r.text.includes('  index.js'), r.text.slice(0, 400));

    r = await c.call('fs_op', { action: 'disk_usage', path: '.' });
    check('fs_op disk_usage totals and ranks', r.text.includes('largest files') && /across \d+ file/.test(r.text), r.text.slice(0, 300));

    r = await c.call('fs_op', { action: 'touch', path: 'touched.txt' });
    check('fs_op touch creates a file', r.text.includes('created empty file'), r.text.slice(0, 150));

    r = await c.call('fs_op', { action: 'stat', path: 'no-such-file' });
    check('stat on a missing path is an error', r.isError, r.text.slice(0, 150));

    // ========================================================== archive
    r = await c.call('archive', { action: 'create', path: 'bundle.zip', from: 'src' });
    check('archive creates a zip', r.text.includes('created') && r.text.includes('zip'), r.text.slice(0, 200));

    r = await c.call('archive', { action: 'list', path: 'bundle.zip' });
    check('archive lists zip contents', r.text.includes('index.js') && r.text.includes('lib/helper.js'), r.text.slice(0, 300));

    r = await c.call('archive', { action: 'extract', path: 'bundle.zip', to: 'unzipped' });
    check('archive extracts a zip', r.text.includes('extracted'), r.text.slice(0, 200));
    check('extracted content matches the original',
      (await readFile(join(dir, 'unzipped', 'index.js'), 'utf8')) === (await readFile(join(dir, 'src', 'index.js'), 'utf8')));

    r = await c.call('archive', { action: 'extract', path: 'bundle.zip', to: 'unzipped' });
    check('extract skips existing files by default', r.text.includes('skipped'), r.text.slice(0, 200));

    r = await c.call('archive', { action: 'create', path: 'bundle.tar.gz', from: 'src' });
    check('archive creates a tar.gz', r.text.includes('tar.gz'), r.text.slice(0, 200));
    r = await c.call('archive', { action: 'list', path: 'bundle.tar.gz' });
    check('archive lists tar.gz contents', r.text.includes('index.js'), r.text.slice(0, 300));
    r = await c.call('archive', { action: 'extract', path: 'bundle.tar.gz', to: 'untarred' });
    check('archive extracts a tar.gz', r.text.includes('extracted'), r.text.slice(0, 200));
    check('tar.gz content matches',
      (await readFile(join(dir, 'untarred', 'lib', 'helper.js'), 'utf8')).includes('needle'));

    r = await c.call('archive', { action: 'gzip', path: 'package.json' });
    check('archive gzips one file', r.text.includes('gzipped'), r.text.slice(0, 200));
    r = await c.call('archive', { action: 'gunzip', path: 'package.json.gz', to: 'ungz.json' });
    check('archive gunzips', r.text.includes('gunzipped'), r.text.slice(0, 200));
    check('gunzip content matches',
      (await readFile(join(dir, 'ungz.json'), 'utf8')) === (await readFile(join(dir, 'package.json'), 'utf8')));

    r = await c.call('archive', { action: 'create', path: 'filtered.zip', from: 'src', glob: ['*.ts'] });
    check('archive create honours a glob', r.text.includes('1 file'), r.text.slice(0, 200));

    r = await c.call('archive', { action: 'list', path: 'package.json' });
    check('listing a non-archive is an error', r.isError, r.text.slice(0, 200));

    // ========================================================= json_tool
    r = await c.call('json_tool', { action: 'get', path: 'data.json', json_path: 'nested.list[1]' });
    check('json_tool get reads a nested path', r.text.includes('20'), r.text.slice(0, 200));

    r = await c.call('json_tool', { action: 'keys', path: 'data.json' });
    check('json_tool keys lists the level', r.text.includes('name') && r.text.includes('nested'), r.text.slice(0, 300));

    r = await c.call('json_tool', { action: 'set', path: 'data.json', json_path: 'nested.flag', value: false });
    check('json_tool set writes', r.text.includes('set nested.flag'), r.text.slice(0, 200));
    check('json_tool set really changed the file',
      JSON.parse(await readFile(join(dir, 'data.json'), 'utf8')).nested.flag === false);

    r = await c.call('json_tool', { action: 'set', path: 'data.json', json_path: 'deep.new.key', value: 'made' });
    check('json_tool set creates missing levels',
      JSON.parse(await readFile(join(dir, 'data.json'), 'utf8')).deep.new.key === 'made', r.text.slice(0, 200));

    r = await c.call('json_tool', { action: 'merge', path: 'data.json', value: { merged: { a: 1 } } });
    check('json_tool merge works',
      JSON.parse(await readFile(join(dir, 'data.json'), 'utf8')).merged.a === 1, r.text.slice(0, 200));

    r = await c.call('json_tool', { action: 'delete', path: 'data.json', json_path: 'keep' });
    check('json_tool delete removes a key',
      !('keep' in JSON.parse(await readFile(join(dir, 'data.json'), 'utf8'))), r.text.slice(0, 200));

    r = await c.call('json_tool', { action: 'get', content: '{"a":{"b":[1,2]}}', json_path: 'a.b[0]' });
    check('json_tool works on inline content', r.text.includes('1'), r.text.slice(0, 150));

    r = await c.call('json_tool', { action: 'validate', content: '{bad json' });
    check('json_tool validate reports invalid JSON', r.text.includes('INVALID'), r.text.slice(0, 200));

    r = await c.call('json_tool', { action: 'get', path: 'data.json', json_path: 'nope.missing' });
    check('a missing path is reported with hints', r.text.includes('not present'), r.text.slice(0, 250));

    r = await c.call('json_tool', { action: 'delete', path: 'data.json' });
    check('delete without a path is refused', r.isError && r.text.includes('refusing'), r.text.slice(0, 200));

    // ============================================================== diff
    await writeFile(join(dir, 'v1.txt'), 'alpha\nbravo\ncharlie\n');
    await writeFile(join(dir, 'v2.txt'), 'alpha\nBRAVO\ncharlie\ndelta\n');

    r = await c.call('diff', { action: 'files', path: 'v1.txt', to: 'v2.txt' });
    check('diff files produces a unified diff', r.text.includes('-bravo') && r.text.includes('+BRAVO') && r.text.includes('+delta'), r.text.slice(0, 400));
    check('diff files reports counts', /\+2 -1/.test(r.text), r.text.slice(0, 200));

    r = await c.call('diff', { action: 'files', path: 'v1.txt', to: 'v2.txt', stat: true });
    check('diff stat omits the patch', !r.text.includes('+delta'), r.text.slice(0, 200));

    r = await c.call('diff', { action: 'files', path: 'v1.txt', to: 'v1.txt' });
    check('identical files are reported as such', r.text.includes('identical'), r.text.slice(0, 200));

    r = await c.call('diff', { action: 'text', a: 'one\ntwo\n', b: 'one\nTWO\n' });
    check('diff text works inline', r.text.includes('-two') && r.text.includes('+TWO'), r.text.slice(0, 250));

    // round-trip a patch through apply
    const patchRes = await c.call('diff', { action: 'files', path: 'v1.txt', to: 'v2.txt' });
    const patch = patchRes.text.slice(patchRes.text.indexOf('---'));
    r = await c.call('diff', { action: 'apply', path: 'v1.txt', patch, dry_run: true });
    check('diff apply dry_run reports hunks', r.text.includes('DRY RUN') && r.text.includes('applied'), r.text.slice(0, 300));
    check('dry_run did not write', (await readFile(join(dir, 'v1.txt'), 'utf8')).includes('bravo'));

    r = await c.call('diff', { action: 'apply', path: 'v1.txt', patch });
    check('diff apply writes the patch', r.text.includes('written'), r.text.slice(0, 300));
    check('patched file matches the target',
      (await readFile(join(dir, 'v1.txt'), 'utf8')) === (await readFile(join(dir, 'v2.txt'), 'utf8')));

    r = await c.call('diff', { action: 'apply', path: 'v2.txt', patch: '@@ -1,1 +1,1 @@\n-nothing-like-this\n+x\n' });
    check('a patch that does not fit is refused', r.isError && /No hunk applied/.test(r.text), r.text.slice(0, 250));

    // ============================================================ encode
    r = await c.call('encode', { action: 'base64_encode', text: 'hello world' });
    check('base64_encode works', r.text.trim() === 'aGVsbG8gd29ybGQ=', r.text);
    r = await c.call('encode', { action: 'base64_decode', text: 'aGVsbG8gd29ybGQ=' });
    check('base64_decode works', r.text.trim() === 'hello world', r.text);
    r = await c.call('encode', { action: 'hex_encode', text: 'AB' });
    check('hex_encode works', r.text.trim() === '4142', r.text);
    r = await c.call('encode', { action: 'hex_decode', text: '4142' });
    check('hex_decode works', r.text.trim() === 'AB', r.text);
    r = await c.call('encode', { action: 'hex_decode', text: 'zzz' });
    check('bad hex is an error', r.isError, r.text.slice(0, 150));
    r = await c.call('encode', { action: 'url_encode', text: 'a b&c' });
    check('url_encode works', r.text.trim() === 'a%20b%26c', r.text);
    r = await c.call('encode', { action: 'html_escape', text: '<a href="x">' });
    check('html_escape works', r.text.includes('&lt;a href=&quot;x&quot;&gt;'), r.text);
    r = await c.call('encode', { action: 'hash', text: 'abc', algorithm: 'sha256' });
    check('sha256 matches the known digest',
      r.text.includes('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'), r.text);
    r = await c.call('encode', { action: 'uuid', count: 3 });
    check('uuid returns the requested count', r.text.trim().split('\n').length === 3, r.text);
    r = await c.call('encode', { action: 'random', count: 8 });
    check('random returns hex of the right length', /^[0-9a-f]{16}$/.test(r.text.trim()), r.text);
    r = await c.call('encode', { action: 'timestamp', text: '1700000000' });
    check('timestamp converts epoch to ISO', r.text.includes('2023-11-14'), r.text);
    r = await c.call('encode', { action: 'timestamp', text: '2023-11-14T22:13:20Z' });
    check('timestamp converts ISO to epoch', r.text.includes('1700000000'), r.text);
    {
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: 'u1', exp: 1700000000 })).toString('base64url');
      r = await c.call('encode', { action: 'jwt_decode', text: `${header}.${payload}.sig` });
      check('jwt_decode reads header and payload', r.text.includes('HS256') && r.text.includes('u1'), r.text.slice(0, 300));
      check('jwt_decode flags expiry', r.text.includes('EXPIRED'), r.text.slice(0, 400));
      check('jwt_decode warns about the signature', r.text.includes('not verified'), r.text.slice(0, 400));
    }
    r = await c.call('encode', { action: 'hash', path: 'package.json' });
    check('encode can read from a file', /sha256 [0-9a-f]{64}/.test(r.text), r.text.slice(0, 150));

    // ========================================================== sys_info
    r = await c.call('sys_info', {});
    check('sys_info overview reports the host', r.text.includes('host') && r.text.includes('cpu'), r.text.slice(0, 300));
    r = await c.call('sys_info', { action: 'memory' });
    check('sys_info memory works', r.text.includes('total'), r.text.slice(0, 200));
    r = await c.call('sys_info', { action: 'disk' });
    check('sys_info disk reports free space', /free of/.test(r.text), r.text.slice(0, 300));
    r = await c.call('sys_info', { action: 'network' });
    check('sys_info network lists interfaces', /IPv4|IPv6/.test(r.text), r.text.slice(0, 200));
    r = await c.call('sys_info', { action: 'env', filter: '^PATH$' });
    check('sys_info env filters variables', r.text.startsWith('PATH='), r.text.slice(0, 120));
    r = await c.call('sys_info', { action: 'nope' });
    check('an unknown sys_info action is an error', r.isError, r.text.slice(0, 150));

    // ============================================================== proc
    r = await c.call('proc', { action: 'list', limit: 5 });
    check('proc list returns processes', /pid\s+cpu/.test(r.text) && /\d+/.test(r.text), r.text.slice(0, 300));
    r = await c.call('proc', { action: 'list', name: 'node', limit: 5 });
    check('proc list filters by name', r.text.includes('node') || r.text.includes('no process'), r.text.slice(0, 200));
    r = await c.call('proc', { action: 'info', pid: process.pid });
    check('proc info describes a pid', r.text.includes(`pid       ${process.pid}`), r.text.slice(0, 300));
    r = await c.call('proc', { action: 'tree', pid: process.pid });
    check('proc tree renders a hierarchy', r.text.includes(String(process.pid)), r.text.slice(0, 300));
    r = await c.call('proc', { action: 'info', pid: 999999 });
    check('proc info on a missing pid is an error', r.isError, r.text.slice(0, 150));
    r = await c.call('proc', { action: 'kill', name: 'definitely-no-such-process-xyz' });
    check('kill by name without confirm only previews', r.text.includes('Would signal') && r.text.includes('confirm:true'), r.text.slice(0, 250));

    // =============================================================== net
    r = await c.call('net', { action: 'interfaces' });
    check('net interfaces lists addresses', r.text.includes('127.0.0.1'), r.text.slice(0, 200));
    r = await c.call('net', { action: 'tcp_check', host: '127.0.0.1', port: httpPort });
    check('net tcp_check finds an open port', r.text.includes('OPEN'), r.text.slice(0, 200));
    r = await c.call('net', { action: 'tcp_check', host: '127.0.0.1', port: 1 });
    check('net tcp_check reports a closed port', r.text.includes('closed'), r.text.slice(0, 200));
    r = await c.call('net', { action: 'listening' });
    check('net listening finds sockets', r.text.includes('listening socket') || r.text.includes('no listening'), r.text.slice(0, 200));
    r = await c.call('net', { action: 'dns', host: 'localhost' });
    check('net dns resolves localhost', r.text.includes('127.0.0.1') || r.text.includes('::1'), r.text.slice(0, 200));

    // ====================================================== http_request
    r = await c.call('http_request', { url: `${base}/json` });
    check('http_request reports the status', r.text.startsWith('200'), r.text.slice(0, 200));
    check('http_request pretty-prints JSON', r.text.includes('"items"') && r.text.includes('\n  '), r.text.slice(0, 300));
    check('http_request shows interesting headers', r.text.includes('x-request-id'), r.text.slice(0, 300));

    r = await c.call('http_request', { url: `${base}/echo`, method: 'POST', json: { hello: 'there' } });
    check('http_request sends a JSON body', r.text.includes('201') && r.text.includes('hello'), r.text.slice(0, 300));
    check('http_request sets the JSON content type', r.text.includes('application/json'), r.text.slice(0, 400));

    r = await c.call('http_request', { url: `${base}/boom` });
    check('http_request surfaces a 500', r.text.startsWith('500') && r.text.includes('kaboom'), r.text.slice(0, 200));

    r = await c.call('http_request', { url: `${base}/json`, headers_only: true });
    check('headers_only omits the body', !r.text.includes('items'), r.text.slice(0, 200));

    r = await c.call('http_request', { url: `${base}/json`, query: { a: '1' } });
    check('http_request appends query params', r.text.includes('a=1'), r.text.slice(0, 200));

    r = await c.call('http_request', { url: 'http://127.0.0.1:1/nothing', timeout_ms: 2000 });
    check('a refused connection is an error', r.isError && /ECONNREFUSED|failed/.test(r.text), r.text.slice(0, 200));

    r = await c.call('http_request', { url: 'not a url at all' });
    check('an invalid url is an error', r.isError, r.text.slice(0, 150));
    check('the test HTTP server was actually hit', hits >= 5, `hits=${hits}`);

    // =============================================================== git
    r = await c.call('git', { action: 'init' });
    check('git init works', !r.isError, r.text.slice(0, 200));
    await c.call('shell_exec', { command: 'git config user.email t@example.com && git config user.name Test' });

    r = await c.call('git', { action: 'status' });
    check('git status groups untracked files', r.text.includes('untracked') && r.text.includes('package.json'), r.text.slice(0, 400));
    check('git status names the branch', /^branch /.test(r.text), r.text.slice(0, 120));

    r = await c.call('git', { action: 'add' });
    check('git add stages everything', r.text.includes('staged'), r.text.slice(0, 250));

    r = await c.call('git', { action: 'status' });
    check('git status shows staged files', r.text.includes('staged ('), r.text.slice(0, 400));

    r = await c.call('git', { action: 'commit', message: 'first commit\n\nwith a body and "quotes"' });
    check('git commit with a multi-line quoted message works', r.text.includes('committed'), r.text.slice(0, 300));

    r = await c.call('git', { action: 'log', limit: 5 });
    check('git log is compact', r.text.includes('first commit') && !r.text.includes('Author:'), r.text.slice(0, 300));

    r = await c.call('git', { action: 'current' });
    check('git current summarises HEAD', r.text.includes('clean'), r.text.slice(0, 200));

    await writeFile(join(dir, 'src', 'index.js'), 'export const changed = true;\n');
    r = await c.call('git', { action: 'diff' });
    check('git diff shows the change', r.text.includes('changed'), r.text.slice(0, 300));
    r = await c.call('git', { action: 'diff', stat: true });
    check('git diff stat summarises', r.text.includes('index.js') && r.text.includes('|'), r.text.slice(0, 300));

    r = await c.call('git', { action: 'branch_create', ref: 'feature/test' });
    check('git branch_create switches branch', !r.isError, r.text.slice(0, 200));
    r = await c.call('git', { action: 'branches' });
    check('git branches marks the current one', r.text.includes('feature/test'), r.text.slice(0, 300));

    r = await c.call('git', { action: 'stash' });
    check('git stash works', !r.isError, r.text.slice(0, 200));
    r = await c.call('git', { action: 'stash_list' });
    check('git stash_list shows the stash', r.text.includes('stash@{0}') || r.text.includes('WIP'), r.text.slice(0, 200));
    r = await c.call('git', { action: 'stash_pop' });
    check('git stash_pop restores', !r.isError, r.text.slice(0, 200));

    r = await c.call('git', { action: 'raw', args: ['rev-parse', '--is-inside-work-tree'] });
    check('git raw passthrough works', r.text.includes('true'), r.text.slice(0, 200));

    r = await c.call('git', { action: 'commit' });
    check('git commit without a message is an error', r.isError, r.text.slice(0, 150));
    r = await c.call('git', { action: 'nonsense' });
    check('an unknown git action is an error', r.isError && r.text.includes('Unknown git action'), r.text.slice(0, 200));

    r = await c.call('git', { action: 'file_history', paths: ['package.json'] });
    check('git file_history works', r.text.includes('first commit'), r.text.slice(0, 200));

    // ============================================================= watch
    r = await c.call('watch', { action: 'start', path: 'docs' });
    const watchId = (r.text.match(/watch_id=(\S+)/) || [])[1];
    check('watch start returns an id', Boolean(watchId), r.text.slice(0, 200));

    r = await c.call('watch', { action: 'list' });
    check('watch list shows the watcher', r.text.includes(watchId), r.text.slice(0, 200));

    await sleep(150);
    await writeFile(join(dir, 'docs', 'triggered.md'), 'new file\n');
    r = await c.call('watch', { action: 'poll', watch_id: watchId, wait_ms: 5000 });
    check('watch poll reports the change', r.text.includes('triggered.md'), r.text.slice(0, 300));

    r = await c.call('watch', { action: 'poll', watch_id: watchId, wait_ms: 300 });
    check('watch poll clears consumed events', r.text.includes('no changes'), r.text.slice(0, 200));

    r = await c.call('watch', { action: 'stop', watch_id: watchId });
    check('watch stop ends the watcher', r.text.includes('stopped'), r.text.slice(0, 200));

    r = await c.call('watch', { action: 'poll', watch_id: 'watch-nope' });
    check('polling an unknown watcher is an error', r.isError, r.text.slice(0, 200));

    check('nothing corrupted the protocol stream', c.stderr.includes('[terminalmcp]'), c.stderr.slice(0, 200));
  } finally {
    c.close();
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
