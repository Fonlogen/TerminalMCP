// Guardrail tests: readOnly, allowedRoots, denyCommands, denyPaths.
// These are opt-in config settings, so they get their own server instances.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

function client(extraArgs, env = {}) {
  const proc = spawn(process.execPath, [ENTRY, ...extraArgs], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERMINALMCP_CONFIG: join(tmpdir(), 'no-such-terminalmcp.json'), ...env },
  });
  let buf = '';
  let id = 0;
  const pending = new Map();
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); }
    }
  });
  proc.stderr.resume();
  return {
    send(method, params) {
      const rid = ++id;
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: rid, method, params })}\n`);
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`timeout on ${method}`)), 30000);
        pending.set(rid, (m) => { clearTimeout(t); res(m); });
      });
    },
    async call(name, args) {
      const r = await this.send('tools/call', { name, arguments: args });
      if (r.error) return { isError: true, text: r.error.message };
      return { isError: Boolean(r.result?.isError), text: r.result?.content?.[0]?.text ?? '' };
    },
    close() { proc.stdin.end(); proc.kill(); },
  };
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'terminalmcp-guards-'));
  const outside = await mkdtemp(join(tmpdir(), 'terminalmcp-outside-'));
  await writeFile(join(dir, 'in.txt'), 'inside\n');
  await writeFile(join(outside, 'out.txt'), 'outside\n');

  // ---- read-only mode
  let c = client(['--cwd', dir, '--read-only']);
  await c.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  let r = await c.call('shell_exec', { command: 'echo nope' });
  check('readOnly blocks shell_exec', r.isError && r.text.startsWith('Policy:'), r.text);
  r = await c.call('file_write', { path: join(dir, 'new.txt'), content: 'x' });
  check('readOnly blocks file_write', r.isError && r.text.startsWith('Policy:'), r.text);
  r = await c.call('file_read', { path: join(dir, 'in.txt') });
  check('readOnly still allows file_read', !r.isError && r.text.includes('inside'), r.text);
  r = await c.call('shell_bulk', { steps: [{ command: 'echo nope' }] });
  check('readOnly blocks shell_bulk steps', r.text.includes('REFUSED Policy:'), r.text);
  r = await c.call('shell_info', {});
  check('shell_info reports readOnly', r.text.includes('readOnly=true'), r.text);
  c.close();

  // ---- allowedRoots
  c = client(['--cwd', dir, '--allowed-root', dir]);
  await c.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  r = await c.call('file_read', { path: join(dir, 'in.txt') });
  check('allowedRoots permits inside', !r.isError && r.text.includes('inside'), r.text);
  r = await c.call('file_read', { path: join(outside, 'out.txt') });
  check('allowedRoots blocks outside', r.isError && r.text.includes('outside allowedRoots'), r.text);
  r = await c.call('file_write', { path: join(outside, 'hack.txt'), content: 'x' });
  check('allowedRoots blocks writes outside', r.isError && r.text.includes('outside allowedRoots'), r.text);
  r = await c.call('shell_info', {});
  check('shell_info lists allowedRoots', r.text.includes('allowedRoots'), r.text);
  c.close();

  // ---- denyCommands / denyPaths, via a config file
  const cfgPath = join(dir, 'deny.json');
  await writeFile(cfgPath, JSON.stringify({
    denyCommands: ['rm\\s+-rf\\s+/', 'mkfs'],
    denyPaths: ['\\.env$'],
  }));
  c = client(['--cwd', dir, '--config', cfgPath]);
  await c.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  r = await c.call('shell_exec', { command: 'rm -rf / --no-preserve-root' });
  check('denyCommands blocks a matching command', r.isError && r.text.includes('denyCommands'), r.text);
  r = await c.call('shell_exec', { command: 'echo harmless' });
  check('denyCommands allows everything else', !r.isError && r.text.includes('harmless'), r.text);
  r = await c.call('shell_bulk', { steps: [{ command: 'echo ok' }, { command: 'mkfs.ext4 /dev/sda' }] });
  check('denyCommands blocks a bulk step', r.text.includes('REFUSED Policy:') && r.text.includes('denyCommands'), r.text);
  r = await c.call('file_write', { path: join(dir, '.env'), content: 'SECRET=1' });
  check('denyPaths blocks a matching write', r.isError && r.text.includes('denyPaths'), r.text);
  r = await c.call('file_write', { path: join(dir, 'ok.txt'), content: 'fine' });
  check('denyPaths allows other writes', !r.isError, r.text);
  c.close();

  await rm(dir, { recursive: true, force: true }).catch(() => {});
  await rm(outside, { recursive: true, force: true }).catch(() => {});

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
}

main().catch((e) => { console.error('harness crashed:', e); process.exit(1); });
