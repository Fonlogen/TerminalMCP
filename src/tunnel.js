// A public URL for the HTTP transport, through Cloudflare's quick tunnels.
//
// `cloudflared tunnel --url http://127.0.0.1:8787` asks Cloudflare for a
// throwaway hostname under trycloudflare.com and connects to it outbound. No
// account, no DNS, no port forwarding, and nothing to open on the router —
// which is the whole appeal when the machine sits behind NAT or a firewall
// somebody else administers.
//
// Two things about it are worth being blunt about rather than discovering:
//
//   * The URL is public. It is random, but random is not secret: it travels
//     through whatever you paste it into, and the HTTP transport has no
//     authentication, so anyone who has it has a shell on this machine. A
//     quick tunnel is for a session, not for leaving up.
//   * The hostname changes every time. Quick tunnels are ephemeral by design;
//     a stable one needs a named tunnel and a Cloudflare account, which is a
//     different feature and not this one.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { killTree } from './exec.js';

const IS_WIN = process.platform === 'win32';

/** Where cloudflared installs itself, per platform and package manager. */
export function cloudflaredCandidates(env = process.env, platform = process.platform) {
  const out = [];
  if (platform === 'win32') {
    const dirs = [
      env.ProgramFiles && path.win32.join(env.ProgramFiles, 'cloudflared'),
      env['ProgramFiles(x86)'] && path.win32.join(env['ProgramFiles(x86)'], 'cloudflared'),
      env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
      env.ChocolateyInstall && path.win32.join(env.ChocolateyInstall, 'bin'),
      'C:\\ProgramData\\chocolatey\\bin',
    ].filter(Boolean);
    for (const dir of dirs) out.push(path.win32.join(dir, 'cloudflared.exe'));
    return out;
  }
  // Homebrew on both architectures, then the usual Linux packages.
  return [
    '/opt/homebrew/bin/cloudflared',
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',
    '/usr/sbin/cloudflared',
    '/snap/bin/cloudflared',
  ];
}

/** cloudflared on PATH, or in a place it is known to install itself. */
export function findCloudflared({ explicit = null, env = process.env, platform = process.platform } = {}) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`No cloudflared at ${explicit}`);
    return explicit;
  }
  const sep = platform === 'win32' ? ';' : ':';
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (env.PATH || '').split(sep).filter(Boolean)) {
    for (const ext of exts) {
      const full = path.join(dir, `cloudflared${ext}`);
      if (existsSync(full)) return full;
    }
  }
  for (const candidate of cloudflaredCandidates(env, platform)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** How to get it, for the platform actually in front of the reader. */
export function installHint(platform = process.platform) {
  if (platform === 'win32') {
    return (
      'winget install --id Cloudflare.cloudflared\n' +
      '  or: choco install cloudflared\n' +
      '  or download cloudflared.exe from ' +
      'https://github.com/cloudflare/cloudflared/releases/latest and put it on PATH'
    );
  }
  if (platform === 'darwin') return 'brew install cloudflared';
  return (
    'apt install cloudflared  (after adding Cloudflare\'s repo), or download the binary from\n' +
    '  https://github.com/cloudflare/cloudflared/releases/latest'
  );
}

/**
 * The quick-tunnel hostname, out of whatever cloudflared has printed so far.
 *
 * It arrives inside an ASCII box on the log stream rather than on stdout as a
 * value, so this is a search, not a parse.
 */
export function parseTunnelUrl(text) {
  const m = String(text ?? '').match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i);
  return m ? m[0] : null;
}

/** The lines most likely to say why it failed, without the whole log. */
export function tunnelFailureDetail(text, limit = 6) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\S+\s+(INF|WRN|ERR)\s+/, '').trim())
    .filter(Boolean);
  const interesting = lines.filter((l) => /error|failed|unable|refused|denied|cannot/i.test(l));
  return (interesting.length ? interesting : lines).slice(-limit).join('\n  ');
}

/**
 * Start a quick tunnel to a local port and wait for its public URL.
 *
 * Resolves to { url, bin, stop }. `stop` is idempotent: it is called both from
 * the signal handlers and from the exit path, and killing an already-dead
 * child must not be an event.
 */
export function startQuickTunnel({
  port,
  host = '127.0.0.1',
  bin = null,
  timeoutMs = 45000,
  onLog = null,
  env = process.env,
  platform = process.platform,
} = {}) {
  const exe = findCloudflared({ explicit: bin, env, platform });
  if (!exe) {
    return Promise.reject(
      new Error(
        'cloudflared is not installed, and a quick tunnel is what it does.\n' +
        `  ${installHint(platform)}\n` +
        'Without it the server still runs — it is just reachable on the local network only.',
      ),
    );
  }

  // cloudflared dials the server itself, so the loopback address is the right
  // target even when the server also listens on 0.0.0.0.
  const target = `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${port}`;
  const args = ['tunnel', '--no-autoupdate', '--url', target];

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      reject(new Error(`Could not start ${exe}: ${err.message}`));
      return;
    }

    let log = '';
    let settled = false;
    let stopped = false;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      try {
        killTree(child, 'SIGTERM');
      } catch {
        /* already gone */
      }
    };

    const fail = (message) => {
      if (settled) return;
      settled = true;
      stop();
      reject(new Error(message));
    };

    const timer = setTimeout(() => {
      fail(
        `cloudflared did not produce a tunnel URL within ${Math.round(timeoutMs / 1000)}s.\n` +
        `  ${tunnelFailureDetail(log) || 'it printed nothing at all'}\n` +
        'A quick tunnel needs outbound HTTPS to Cloudflare; a proxy or a firewall that blocks ' +
        'it looks exactly like this.',
      );
    }, timeoutMs);
    timer.unref?.();

    const onChunk = (chunk) => {
      const text = String(chunk);
      log += text;
      if (log.length > 64 * 1024) log = log.slice(-32 * 1024);
      if (onLog) onLog(text);
      if (settled) return;
      const url = parseTunnelUrl(log);
      if (!url) return;
      settled = true;
      clearTimeout(timer);
      resolve({ url, bin: exe, target, proc: child, stop });
    };

    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    child.on('error', (err) => {
      fail(
        err.code === 'ENOENT'
          ? `${exe} vanished between being found and being run`
          : `cloudflared could not be started: ${err.message}`,
      );
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      fail(
        `cloudflared exited (${signal ? `signal ${signal}` : `code ${code}`}) before giving a URL.\n` +
        `  ${tunnelFailureDetail(log) || 'it printed nothing at all'}`,
      );
    });
  });
}
