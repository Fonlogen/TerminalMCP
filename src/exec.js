// Process spawning: timeouts, whole-tree kills, output buffering.

import { spawn } from 'node:child_process';
import process from 'node:process';
import { existsSync, statSync } from 'node:fs';
import { resolve as resolvePath, isAbsolute } from 'node:path';
import { buildInvocation, resolveShell } from './shells.js';

const IS_WIN = process.platform === 'win32';

/**
 * A running (or finished) command. Buffers output so background jobs can be
 * polled incrementally by byte offset.
 */
export class CommandRun {
  constructor(meta) {
    Object.assign(this, meta);
    this.stdout = '';
    this.stderr = '';
    this.combined = '';
    this.exitCode = undefined;
    this.signal = null;
    this.timedOut = false;
    this.killed = false;
    this.error = null;
    this.startedAt = Date.now();
    this.endedAt = null;
    this.droppedBytes = 0;
    this._waiters = [];
    this._settled = false;
  }

  get running() {
    return this.endedAt === null;
  }

  get durationMs() {
    return (this.endedAt ?? Date.now()) - this.startedAt;
  }

  _append(stream, chunk) {
    this[stream] += chunk;
    this.combined += chunk;
    const cap = this.maxBufferBytes;
    // Over the cap we drop from the front: the tail of a log is the useful part.
    for (const k of ['stdout', 'stderr', 'combined']) {
      if (this[k].length > cap) {
        const excess = this[k].length - cap;
        this[k] = this[k].slice(excess);
        if (k === 'combined') this.droppedBytes += excess;
      }
    }
    this._notify();
  }

  _notify() {
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) w();
  }

  /** Resolve as soon as new output arrives, the run ends, or `timeout` passes. */
  waitForChange(timeout) {
    if (this._settled || timeout <= 0) return Promise.resolve();
    return new Promise((res) => {
      const done = () => {
        clearTimeout(timer);
        res();
      };
      const timer = setTimeout(done, timeout);
      this._waiters.push(done);
    });
  }

  _settle() {
    this.endedAt = Date.now();
    this._settled = true;
    this._notify();
  }

  kill(signal = 'SIGTERM') {
    if (!this.child || !this.running) return false;
    this.killed = true;
    killTree(this.child, signal);
    return true;
  }

  write(data) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) return false;
    this.child.stdin.write(data);
    return true;
  }

  closeStdin() {
    if (this.child && this.child.stdin && !this.child.stdin.destroyed) this.child.stdin.end();
  }
}

/** Kill a process and every process it spawned. */
export function killTree(child, signal = 'SIGTERM') {
  if (!child || child.pid === undefined) return;
  if (IS_WIN) {
    // taskkill is the only reliable way to take down a Windows process tree.
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
      return;
    } catch {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      return;
    }
  }
  // detached:true put the child in its own process group; negating the pid
  // signals the whole group, so children of `cmd | other` die too.
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

function resolveCwd(cfg, cwd) {
  const dir = cwd ? (isAbsolute(cwd) ? resolvePath(cwd) : resolvePath(cfg.cwd, cwd)) : cfg.cwd;
  if (!existsSync(dir)) throw new Error(`cwd does not exist: ${dir}`);
  if (!statSync(dir).isDirectory()) throw new Error(`cwd is not a directory: ${dir}`);
  return dir;
}

/**
 * Launch a command. Returns a CommandRun immediately; await `run.done` for the
 * finished result.
 */
export function startCommand(cfg, opts) {
  const {
    command,
    cwd,
    shell: shellSpec,
    env: extraEnv = {},
    timeoutMs,
    stdin = null,
    login,
    maxBufferBytes,
    mode,
    name = null,
    keepStdinOpen = false,
  } = opts;

  const shell = resolveShell(shellSpec ?? cfg.shell, cfg.shells);
  const workDir = resolveCwd(cfg, cwd);
  const timeout = timeoutMs === undefined || timeoutMs === null ? cfg.timeoutMs : timeoutMs;

  const run = new CommandRun({
    name,
    command,
    cwd: workDir,
    shellName: shell.name,
    shellCommand: shell.command,
    timeoutMs: timeout,
    maxBufferBytes: maxBufferBytes ?? cfg.maxBufferBytes,
    mode: mode || shell.mode,
  });

  run.done = (async () => {
    let cleanup = () => {};
    try {
      const inv = await buildInvocation(shell, command, { login: login ?? cfg.login, mode });
      cleanup = inv.cleanup;

      const child = spawn(inv.file, inv.args, {
        cwd: workDir,
        env: { ...process.env, ...cfg.env, ...extraEnv },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: !IS_WIN, // own process group => killable as a tree
        windowsHide: true,
      });
      run.child = child;
      run.pid = child.pid;

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => run._append('stdout', d));
      child.stderr.on('data', (d) => run._append('stderr', d));

      child.stdin.on('error', () => {}); // EPIPE when the child exits early
      if (stdin !== null && stdin !== undefined) child.stdin.write(stdin);
      if (!keepStdinOpen) child.stdin.end();

      let timer = null;
      let killTimer = null;
      if (timeout > 0) {
        timer = setTimeout(() => {
          run.timedOut = true;
          killTree(child, 'SIGTERM');
          // Escalate if it ignores SIGTERM.
          killTimer = setTimeout(() => {
            if (run.running) killTree(child, 'SIGKILL');
          }, 3000);
          killTimer.unref?.();
        }, timeout);
      }

      await new Promise((res) => {
        child.on('error', (err) => {
          run.error = err.message;
          res();
        });
        child.on('close', (code, signal) => {
          run.exitCode = code;
          run.signal = signal;
          res();
        });
      });
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    } catch (err) {
      run.error = err.message;
    } finally {
      if (run.exitCode === undefined) run.exitCode = null;
      run._settle();
      await cleanup();
    }
    return run;
  })();

  return run;
}

/** Convenience: run to completion. */
export async function runCommand(cfg, opts) {
  return startCommand(cfg, opts).done;
}

/**
 * Run a binary directly, with no shell in between.
 *
 * This is what the tools that wrap a known program (git, package managers,
 * `ps`) use: an argv array cannot be mangled by quoting rules, so a commit
 * message with quotes, spaces and newlines just works, on every platform.
 */
export function startArgv(cfg, opts) {
  const {
    file,
    args = [],
    cwd,
    env: extraEnv = {},
    timeoutMs,
    stdin = null,
    maxBufferBytes,
    name = null,
    keepStdinOpen = false,
  } = opts;

  if (!file) throw new Error('startArgv needs a "file" to execute');
  const workDir = resolveCwd(cfg, cwd);
  const timeout = timeoutMs === undefined || timeoutMs === null ? cfg.timeoutMs : timeoutMs;

  const run = new CommandRun({
    name,
    command: `${file} ${args.join(' ')}`.trim(),
    argv: [file, ...args],
    cwd: workDir,
    shellName: '(direct)',
    shellCommand: file,
    timeoutMs: timeout,
    maxBufferBytes: maxBufferBytes ?? cfg.maxBufferBytes,
    mode: 'argv',
  });

  run.done = (async () => {
    try {
      const child = spawn(file, args, {
        cwd: workDir,
        env: { ...process.env, ...cfg.env, ...extraEnv },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: !IS_WIN,
        windowsHide: true,
      });
      run.child = child;
      run.pid = child.pid;

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => run._append('stdout', d));
      child.stderr.on('data', (d) => run._append('stderr', d));
      child.stdin.on('error', () => {});
      if (stdin !== null && stdin !== undefined) child.stdin.write(stdin);
      if (!keepStdinOpen) child.stdin.end();

      let timer = null;
      let killTimer = null;
      if (timeout > 0) {
        timer = setTimeout(() => {
          run.timedOut = true;
          killTree(child, 'SIGTERM');
          killTimer = setTimeout(() => {
            if (run.running) killTree(child, 'SIGKILL');
          }, 3000);
          killTimer.unref?.();
        }, timeout);
      }

      await new Promise((res) => {
        child.on('error', (err) => {
          // ENOENT here means the program is not installed; say so plainly.
          run.error = err.code === 'ENOENT' ? `${file} not found on PATH` : err.message;
          res();
        });
        child.on('close', (code, signal) => {
          run.exitCode = code;
          run.signal = signal;
          res();
        });
      });
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    } catch (err) {
      run.error = err.message;
    } finally {
      if (run.exitCode === undefined) run.exitCode = null;
      run._settle();
    }
    return run;
  })();

  return run;
}

export async function runArgv(cfg, opts) {
  return startArgv(cfg, opts).done;
}
