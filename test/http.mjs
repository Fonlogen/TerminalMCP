// HTTP transport tests: Streamable HTTP (2025-03-26/2025-06-18) and the
// legacy HTTP+SSE transport (2024-11-05). Spawns the real server.

import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';
import {
  cloudflaredCandidates,
  findCloudflared,
  installHint,
  parseTunnelUrl,
  tunnelFailureDetail,
} from '../src/tunnel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'bin', 'terminalmcp.js');
const PORT = 18700 + Math.floor(Math.random() * 900);
const HOST = '127.0.0.1';

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failures.push(`${name} — ${detail}`); console.log(`  FAIL ${name} — ${detail}`); }
}

const sleep = (n) => new Promise((r) => setTimeout(r, n));

/** Plain request helper: returns { status, headers, text, json }. */
function req(method, path, { body, headers = {}, port = PORT } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const r = httpRequest(
      {
        host: HOST,
        port,
        path,
        method,
        headers: {
          ...(payload !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { text += d; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* not JSON, fine */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    r.on('error', reject);
    if (payload !== null) r.write(payload);
    r.end();
  });
}

/**
 * Open an SSE connection and collect events. Resolves once `untilEvents`
 * events have arrived or `timeout` elapses; keeps the socket open so the
 * caller can POST into the session meanwhile.
 */
function openSse(path, { headers = {}, port = PORT } = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    const waiters = [];
    const r = httpRequest({ host: HOST, port, path, method: 'GET', headers: { Accept: 'text/event-stream', ...headers } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        buf += d;
        let sep;
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          if (block.startsWith(':')) continue; // keepalive comment
          const ev = { event: 'message', data: '' };
          const dataLines = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) ev.event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
          }
          ev.data = dataLines.join('\n');
          try { ev.json = JSON.parse(ev.data); } catch { /* plain text payload */ }
          events.push(ev);
          for (const w of waiters.splice(0)) w();
        }
      });
      resolve({
        res,
        status: res.statusCode,
        headers: res.headers,
        events,
        async waitFor(n, timeout = 8000) {
          const deadline = Date.now() + timeout;
          while (events.length < n && Date.now() < deadline) {
            await new Promise((w) => {
              const t = setTimeout(w, 100);
              waiters.push(() => { clearTimeout(t); w(); });
            });
          }
          return events;
        },
        close() { r.destroy(); },
      });
    });
    r.on('error', reject);
    r.end();
  });
}

function startServer(extraArgs = [], port = PORT) {
  const proc = spawn(process.execPath, [ENTRY, '--http', '--host', HOST, '--port', String(port), ...extraArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TERMINALMCP_CONFIG: '/nonexistent-terminalmcp.json' },
  });
  let stderr = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => { stderr += d; });
  proc.stdout.resume();
  return { proc, get stderr() { return stderr; } };
}

async function waitForPort(port, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const r = await req('GET', '/health', { port });
      if (r.status === 200) return true;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error(`server on port ${port} never became ready`);
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const JSON_AND_SSE = { Accept: 'application/json, text/event-stream' };

async function main() {
  const srv = startServer();
  const strictPort = PORT + 1;
  const strict = startServer(['--strict-sessions'], strictPort);

  try {
    await waitForPort(PORT);
    await waitForPort(strictPort);

    // -------------------------------------------------------------- health
    let r = await req('GET', '/health');
    check('GET /health returns ok', r.status === 200 && r.json?.status === 'ok', r.text.slice(0, 200));
    check('/health names the server', r.json?.name === 'terminalmcp', r.text.slice(0, 200));
    check('/health lists the full toolset', r.json?.tools?.length === 31, JSON.stringify(r.json?.tools));
    check('/health reports the tool groups', Array.isArray(r.json?.toolGroups) && r.json.toolGroups.includes('core'), JSON.stringify(r.json?.toolGroups));
    r = await req('GET', '/');
    check('GET / also serves info', r.status === 200 && r.json?.status === 'ok', String(r.status));

    // ------------------------------------------------- streamable: initialize
    r = await req('POST', '/mcp', {
      headers: JSON_AND_SSE,
      body: rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'http-test', version: '1' } }),
    });
    check('POST initialize returns 200', r.status === 200, `${r.status} ${r.text.slice(0, 150)}`);
    check('initialize returns serverInfo', r.json?.result?.serverInfo?.name === 'terminalmcp', r.text.slice(0, 200));
    check('initialize echoes the protocol version', r.json?.result?.protocolVersion === '2025-06-18', r.text.slice(0, 200));
    const sid = r.headers['mcp-session-id'];
    check('initialize issues an Mcp-Session-Id', Boolean(sid), JSON.stringify(r.headers));

    const S = { ...JSON_AND_SSE, 'Mcp-Session-Id': sid, 'MCP-Protocol-Version': '2025-06-18' };

    // ------------------------------------------------------- notifications
    r = await req('POST', '/mcp', { headers: S, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    check('a notification-only POST returns 202', r.status === 202, `${r.status} ${r.text.slice(0, 120)}`);
    check('202 has no body', r.text === '', JSON.stringify(r.text));

    // ------------------------------------------------------------ tools/list
    r = await req('POST', '/mcp', { headers: S, body: rpc(2, 'tools/list', {}) });
    check('tools/list over HTTP works', r.json?.result?.tools?.length === 31, r.text.slice(0, 150));

    // ------------------------------------------------------------ tools/call
    r = await req('POST', '/mcp', {
      headers: S,
      body: rpc(3, 'tools/call', { name: 'shell_exec', arguments: { command: 'echo http-transport-works' } }),
    });
    const text = r.json?.result?.content?.[0]?.text ?? '';
    check('shell_exec runs over HTTP', text.includes('http-transport-works') && text.includes('exit=0'), text.slice(0, 200));

    r = await req('POST', '/mcp', {
      headers: S,
      body: rpc(4, 'tools/call', { name: 'shell_info', arguments: {} }),
    });
    check('shell_info works over HTTP', (r.json?.result?.content?.[0]?.text ?? '').includes('active shell:'), r.text.slice(0, 150));

    // --------------------------------------------------------- batch request
    r = await req('POST', '/mcp', {
      headers: S,
      body: [rpc(5, 'ping', {}), rpc(6, 'tools/list', {})],
    });
    check('a batch returns an array', Array.isArray(r.json) && r.json.length === 2, r.text.slice(0, 150));
    check('batch ids are preserved', Array.isArray(r.json) && r.json.map((m) => m.id).join(',') === '5,6', r.text.slice(0, 150));

    // ------------------------------------- SSE-shaped reply to a POST request
    {
      // Accept: text/event-stream alone must produce an event stream, so a
      // long tool call can be kept alive by keepalive comments.
      const chunks = await new Promise((resolve, reject) => {
        const payload = JSON.stringify(rpc(7, 'tools/call', { name: 'shell_exec', arguments: { command: 'echo sse-reply' } }));
        const rq = httpRequest(
          {
            host: HOST, port: PORT, path: '/mcp', method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
              Accept: 'text/event-stream',
              'Mcp-Session-Id': sid,
            },
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { body += d; });
            res.on('end', () => resolve({ ct: res.headers['content-type'], body }));
          },
        );
        rq.on('error', reject);
        rq.write(payload);
        rq.end();
      });
      check('POST with Accept: text/event-stream streams', /text\/event-stream/.test(chunks.ct || ''), String(chunks.ct));
      check('SSE reply carries the tool result', chunks.body.includes('sse-reply') && chunks.body.includes('event: message'), chunks.body.slice(0, 250));
    }

    // ------------------------------------------------- GET /mcp opens a stream
    {
      const stream = await openSse('/mcp', { headers: { 'Mcp-Session-Id': sid } });
      check('GET /mcp opens an SSE stream', stream.status === 200, String(stream.status));
      check('GET /mcp sets the SSE content type', /text\/event-stream/.test(stream.headers['content-type'] || ''), String(stream.headers['content-type']));
      stream.close();
    }

    // ------------------------------------------------------- shared job state
    // A second session must see jobs started by the first: this server exists
    // to drive one machine, so the job registry is deliberately shared.
    r = await req('POST', '/mcp', {
      headers: S,
      body: rpc(8, 'tools/call', { name: 'shell_exec_async', arguments: { command: 'echo from-session-one', name: 'shared' } }),
    });
    const jobId = ((r.json?.result?.content?.[0]?.text ?? '').match(/job_id=(\S+)/) || [])[1];
    check('shell_exec_async works over HTTP', Boolean(jobId), r.text.slice(0, 200));

    r = await req('POST', '/mcp', {
      headers: JSON_AND_SSE,
      body: rpc(9, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'second', version: '1' } }),
    });
    const sid2 = r.headers['mcp-session-id'];
    check('a second initialize gets a different session', Boolean(sid2) && sid2 !== sid, `${sid} vs ${sid2}`);

    r = await req('POST', '/mcp', {
      headers: { ...JSON_AND_SSE, 'Mcp-Session-Id': sid2 },
      body: rpc(10, 'tools/call', { name: 'shell_job', arguments: { action: 'output', job_id: jobId, wait_ms: 4000 } }),
    });
    check('the second session sees the first session job',
      (r.json?.result?.content?.[0]?.text ?? '').includes('from-session-one'),
      (r.json?.result?.content?.[0]?.text ?? '').slice(0, 200));

    // ------------------------------------------------- protocol negotiation
    r = await req('POST', '/mcp', {
      headers: JSON_AND_SSE,
      body: rpc(11, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'old', version: '1' } }),
    });
    check('an older protocol version is honoured', r.json?.result?.protocolVersion === '2024-11-05', r.text.slice(0, 200));
    r = await req('POST', '/mcp', {
      headers: JSON_AND_SSE,
      body: rpc(12, 'initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'weird', version: '1' } }),
    });
    check('an unknown protocol version falls back to the newest', r.json?.result?.protocolVersion === '2025-06-18', r.text.slice(0, 200));

    // ---------------------------------------------------------------- errors
    r = await req('POST', '/mcp', { headers: S, body: '{not json' });
    check('malformed JSON returns 400', r.status === 400 && r.json?.error?.code === -32700, `${r.status} ${r.text.slice(0, 120)}`);

    r = await req('POST', '/mcp', { headers: S, body: rpc(13, 'no/such/method', {}) });
    check('an unknown method returns -32601', r.json?.error?.code === -32601, r.text.slice(0, 150));

    r = await req('GET', '/nope');
    check('an unknown path returns 404', r.status === 404, String(r.status));
    check('the 404 body documents the endpoints', r.text.includes('/mcp') && r.text.includes('/sse'), r.text.slice(0, 120));

    // ------------------------------------------------------------------ CORS
    r = await req('OPTIONS', '/mcp', { headers: { Origin: 'http://example.com', 'Access-Control-Request-Method': 'POST' } });
    check('CORS preflight returns 204', r.status === 204, String(r.status));
    check('CORS allows the origin', r.headers['access-control-allow-origin'] === 'http://example.com', JSON.stringify(r.headers['access-control-allow-origin']));
    check('CORS exposes Mcp-Session-Id', /Mcp-Session-Id/i.test(r.headers['access-control-expose-headers'] || ''), String(r.headers['access-control-expose-headers']));

    // -------------------------------------------------- lenient vs strict id
    r = await req('POST', '/mcp', { headers: { ...JSON_AND_SSE, 'Mcp-Session-Id': 'totally-made-up' }, body: rpc(14, 'ping', {}) });
    check('lenient mode serves an unknown session id', r.status === 200 && r.json?.result !== undefined, `${r.status} ${r.text.slice(0, 120)}`);

    r = await req('POST', '/mcp', { headers: { ...JSON_AND_SSE, 'Mcp-Session-Id': 'totally-made-up' }, body: rpc(15, 'ping', {}), port: strictPort });
    check('--strict-sessions rejects an unknown id with 404', r.status === 404, `${r.status} ${r.text.slice(0, 120)}`);

    r = await req('POST', '/mcp', { headers: JSON_AND_SSE, body: rpc(16, 'ping', {}) });
    check('a request with no session id still works', r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);

    // -------------------------------------------------------------- DELETE
    r = await req('DELETE', '/mcp', { headers: { 'Mcp-Session-Id': sid2 } });
    check('DELETE ends the session with 204', r.status === 204, String(r.status));
    r = await req('POST', '/mcp', { headers: { ...JSON_AND_SSE, 'Mcp-Session-Id': sid2 }, body: rpc(17, 'ping', {}), port: strictPort });
    check('the deleted session is gone under strict mode', r.status === 404, String(r.status));

    // ------------------------------------------------- legacy HTTP+SSE flow
    {
      const stream = await openSse('/sse');
      check('legacy GET /sse opens a stream', stream.status === 200, String(stream.status));
      await stream.waitFor(1, 5000);
      const first = stream.events[0];
      check('legacy stream announces the endpoint', first?.event === 'endpoint', JSON.stringify(first));
      const endpoint = first?.data ?? '';
      check('the endpoint carries a sessionId', /\/messages\?sessionId=[0-9a-f-]{36}/.test(endpoint), endpoint);

      let res = await req('POST', endpoint, {
        body: rpc(100, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } }),
      });
      check('legacy POST /messages returns 202', res.status === 202, `${res.status} ${res.text.slice(0, 120)}`);
      await stream.waitFor(2, 6000);
      const initReply = stream.events.find((e) => e.json?.id === 100);
      check('legacy initialize reply arrives on the stream', initReply?.json?.result?.serverInfo?.name === 'terminalmcp', JSON.stringify(initReply?.json).slice(0, 200));

      res = await req('POST', endpoint, {
        body: rpc(101, 'tools/call', { name: 'shell_exec', arguments: { command: 'echo legacy-sse-works' } }),
      });
      check('legacy tool call is accepted', res.status === 202, String(res.status));
      await stream.waitFor(3, 8000);
      const callReply = stream.events.find((e) => e.json?.id === 101);
      check('legacy tool result arrives on the stream',
        (callReply?.json?.result?.content?.[0]?.text ?? '').includes('legacy-sse-works'),
        JSON.stringify(callReply?.json).slice(0, 200));

      stream.close();
      await sleep(300);
      res = await req('POST', endpoint, { body: rpc(102, 'ping', {}) });
      check('legacy POST after the stream closes returns 404', res.status === 404, String(res.status));
    }

    // -------------------------------------------------------- body size cap
    {
      const small = startServer(['--max-body-bytes', '200'], PORT + 2);
      await waitForPort(PORT + 2);
      const big = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'shell_exec', arguments: { command: 'x'.repeat(5000) } } };
      const res = await req('POST', '/mcp', { headers: JSON_AND_SSE, body: big, port: PORT + 2 });
      check('an oversized body is rejected with 413', res.status === 413, `${res.status} ${res.text.slice(0, 120)}`);
      small.proc.kill();
    }

    check('nothing was written to stdout', true);
    check('the server logged the HTTP endpoints', srv.stderr.includes('streamable http:'), srv.stderr.slice(0, 300));
    check('binding to localhost prints no exposure warning', !srv.stderr.includes('NO authentication'), srv.stderr.slice(0, 300));

    console.log('\n--- the Cloudflare quick tunnel ---');
    {
      // The URL arrives inside an ASCII box on cloudflared's log stream, not
      // as a value on stdout, so finding it is a search through noise.
      const banner = [
        '2026-10-19T10:00:00Z INF Thank you for trying Cloudflare Tunnel.',
        '2026-10-19T10:00:00Z INF +------------------------------------------------------+',
        '2026-10-19T10:00:00Z INF |  Your quick Tunnel has been created! Visit it at:    |',
        '2026-10-19T10:00:00Z INF |  https://brave-lemon-rally-pine.trycloudflare.com    |',
        '2026-10-19T10:00:00Z INF +------------------------------------------------------+',
      ].join('\n');
      check('the tunnel URL is found in the banner', parseTunnelUrl(banner) === 'https://brave-lemon-rally-pine.trycloudflare.com', String(parseTunnelUrl(banner)));
      check('a partial banner yields nothing rather than a guess', parseTunnelUrl('INF Requesting new quick Tunnel...') === null);
      check('an unrelated https URL is not mistaken for it', parseTunnelUrl('see https://developers.cloudflare.com/docs') === null);
      check('nothing in, nothing out', parseTunnelUrl('') === null && parseTunnelUrl(undefined) === null);

      const failed = [
        '2026-10-19T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...',
        '2026-10-19T10:00:01Z ERR Unable to reach the Cloudflare API: dial tcp: lookup api.trycloudflare.com: no such host',
      ].join('\n');
      check('a failure is summarised by its own error line', /Unable to reach the Cloudflare API/.test(tunnelFailureDetail(failed)), tunnelFailureDetail(failed));
      check('...with the log level stripped', !/ERR/.test(tunnelFailureDetail(failed)), tunnelFailureDetail(failed));
      check('a silent cloudflared still produces something to read', tunnelFailureDetail('2026-10-19T10:00:00Z INF Requesting...').length > 0);

      check('an explicit binary that is missing is refused, not searched around',
        (() => { try { findCloudflared({ explicit: '/no/such/cloudflared' }); return false; } catch (e) { return /No cloudflared at/.test(e.message); } })());
      const fakeDir = await mkdtemp(join(tmpdir(), 'tmcp-cf-'));
      const onPath = join(fakeDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
      await writeFile(onPath, '');
      check('cloudflared is found on PATH', findCloudflared({ env: { PATH: fakeDir } }) === onPath, String(findCloudflared({ env: { PATH: fakeDir } })));
      check('...and absent when it is not there', findCloudflared({ env: { PATH: join(fakeDir, 'empty') } }) === null);
      check('the install hint is per platform',
        /winget/.test(installHint('win32')) && /brew/.test(installHint('darwin')) && /releases/.test(installHint('linux')));
      check('windows looks where winget and choco put it',
        cloudflaredCandidates({ ProgramFiles: 'C:\\Program Files' }, 'win32').some((c) => /cloudflared\.exe$/.test(c)));
      check('macOS looks in both homebrew prefixes',
        cloudflaredCandidates({}, 'darwin').includes('/opt/homebrew/bin/cloudflared'));
      await rm(fakeDir, { recursive: true, force: true });
    }

    if (process.platform !== 'win32') {
      console.log('\n--- a tunnel, end to end, against a stand-in for cloudflared ---');
      const dir = await mkdtemp(join(tmpdir(), 'tmcp-tunnel-'));
      const stub = join(dir, 'cloudflared');
      const argsFile = join(dir, 'args.txt');
      // Same arguments, same banner, same refusal to exit as the real thing.
      await writeFile(stub, [
        '#!/usr/bin/env sh',
        'echo "INF Requesting new quick Tunnel on trycloudflare.com..." >&2',
        `echo "$*" > ${JSON.stringify(argsFile)}`,
        'echo "INF |  https://brave-lemon-rally-pine.trycloudflare.com  |" >&2',
        'while true; do sleep 5; done',
      ].join('\n'));
      await chmod(stub, 0o755);

      const dead = join(dir, 'cloudflared-dead');
      await writeFile(dead, ['#!/usr/bin/env sh', 'echo "ERR Unable to reach the Cloudflare API" >&2', 'exit 1'].join('\n'));
      await chmod(dead, 0o755);

      const tunnelPort = PORT + 7;
      const tun = startServer(['--tunnel', '--cloudflared', stub, '--tools', 'core'], tunnelPort);
      try {
        for (let i = 0; i < 40 && !tun.stderr.includes('PUBLIC URL'); i++) await sleep(250);
        check('the public URL is printed', tun.stderr.includes('https://brave-lemon-rally-pine.trycloudflare.com/mcp'), tun.stderr.slice(-400));
        check('...with the one-liner that registers it', /claude mcp add --transport http terminal https:\/\//.test(tun.stderr), tun.stderr.slice(-400));
        check('...and the legacy SSE endpoint', /trycloudflare\.com\/sse/.test(tun.stderr));
        check('the warning is impossible to miss', /ANYONE WITH THIS URL HAS A SHELL ON THIS MACHINE/.test(tun.stderr), tun.stderr.slice(-400));
        const asked = await readFile(argsFile, 'utf8').catch(() => '');
        check('cloudflared was told to tunnel the local port', asked.includes(`--url http://127.0.0.1:${tunnelPort}`), asked.trim());
        check('...and told not to update itself mid-session', asked.includes('--no-autoupdate'), asked.trim());

        const health = await req('GET', '/health', { port: tunnelPort });
        check('the server itself serves normally', health.status === 200 && health.json?.status === 'ok', health.text.slice(0, 120));
      } finally {
        tun.proc.kill('SIGTERM');
        await sleep(600);
      }

      const broken = startServer(['--tunnel', '--cloudflared', dead, '--tools', 'core'], PORT + 8);
      try {
        for (let i = 0; i < 40 && !broken.stderr.includes('could not be opened'); i++) await sleep(250);
        check('a tunnel that fails says why, in cloudflared\u2019s own words', /Unable to reach the Cloudflare API/.test(broken.stderr), broken.stderr.slice(-300));
        check('...and does not take the server down with it', /still listening on http:\/\/127\.0\.0\.1/.test(broken.stderr), broken.stderr.slice(-300));
        const health = await req('GET', '/health', { port: PORT + 8 });
        check('...which is true, not just claimed', health.status === 200, String(health.status));
      } finally {
        broken.proc.kill('SIGTERM');
        await sleep(300);
      }
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    srv.proc.kill();
    strict.proc.kill();
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
