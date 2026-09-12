// Shell discovery and invocation strategy, per platform.
//
// Two ways to hand a command to a shell:
//   'arg'    -> shell -c "<command>"          (POSIX: safe, handles newlines)
//   'script' -> write a temp script, run it   (Windows: dodges all the
//               cmd.exe/PowerShell quoting rules and supports multi-line)

import { existsSync } from 'node:fs';
import { writeFile, unlink, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import process from 'node:process';

const IS_WIN = process.platform === 'win32';

/** Candidate absolute paths for Git Bash on Windows, in preference order. */
function gitBashCandidates() {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ].filter(Boolean);
  const out = [];
  for (const r of roots) {
    out.push(join(r, 'Git', 'bin', 'bash.exe'));
    out.push(join(r, 'Git', 'usr', 'bin', 'bash.exe'));
  }
  return out;
}

function firstExisting(paths) {
  for (const p of paths) if (p && existsSync(p)) return p;
  return null;
}

/** Look a binary up on PATH (honouring PATHEXT on Windows). */
function onPath(name) {
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = (process.env.PATH || '').split(IS_WIN ? ';' : ':');
  for (const d of dirs) {
    if (!d) continue;
    for (const e of exts) {
      const candidate = join(d, name.toLowerCase().endsWith(e.toLowerCase()) ? name : name + e);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function sysRoot() {
  return process.env.SystemRoot || process.env.windir || 'C:\\Windows';
}

function pwshCandidates() {
  const roots = [process.env.ProgramFiles, 'C:\\Program Files'].filter(Boolean);
  const out = [];
  for (const r of roots) {
    for (const v of ['7', '8', '6']) out.push(join(r, 'PowerShell', v, 'pwsh.exe'));
  }
  return out;
}

/**
 * Known shell profiles. `resolve()` returns an absolute path (or a bare name to
 * be found on PATH) or null when the shell is not installed here.
 */
const PROFILES = {
  bash: {
    platforms: ['linux', 'darwin', 'win32'],
    ext: '.sh',
    argFlags: ['-c'],
    loginFlags: ['-lc'],
    scriptArgs: (f) => [f],
    resolve: () =>
      IS_WIN
        ? firstExisting(gitBashCandidates()) || onPath('bash.exe')
        : firstExisting(['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash']) || onPath('bash'),
  },
  gitbash: {
    platforms: ['win32'],
    ext: '.sh',
    argFlags: ['-c'],
    loginFlags: ['-lc'],
    scriptArgs: (f) => [f],
    resolve: () => firstExisting(gitBashCandidates()),
  },
  sh: {
    platforms: ['linux', 'darwin'],
    ext: '.sh',
    argFlags: ['-c'],
    loginFlags: ['-lc'],
    scriptArgs: (f) => [f],
    resolve: () => firstExisting(['/bin/sh', '/usr/bin/sh']) || onPath('sh'),
  },
  zsh: {
    platforms: ['linux', 'darwin'],
    ext: '.sh',
    argFlags: ['-c'],
    loginFlags: ['-lc'],
    scriptArgs: (f) => [f],
    resolve: () => firstExisting(['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh']) || onPath('zsh'),
  },
  fish: {
    platforms: ['linux', 'darwin'],
    ext: '.fish',
    argFlags: ['-c'],
    loginFlags: ['-lc'],
    scriptArgs: (f) => [f],
    resolve: () => firstExisting(['/usr/bin/fish', '/usr/local/bin/fish', '/opt/homebrew/bin/fish']) || onPath('fish'),
  },
  cmd: {
    platforms: ['win32'],
    ext: '.cmd',
    prefer: 'script',
    argFlags: ['/d', '/s', '/c'],
    scriptArgs: (f) => ['/d', '/s', '/c', f],
    resolve: () => firstExisting([join(sysRoot(), 'System32', 'cmd.exe')]) || onPath('cmd.exe'),
  },
  powershell: {
    platforms: ['win32'],
    ext: '.ps1',
    prefer: 'script',
    argFlags: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'],
    scriptArgs: (f) => [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f,
    ],
    resolve: () =>
      firstExisting([
        join(sysRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ]) || onPath('powershell.exe'),
  },
  pwsh: {
    platforms: ['win32', 'linux', 'darwin'],
    ext: '.ps1',
    prefer: 'script',
    // -ExecutionPolicy exists only on Windows builds of PowerShell Core.
    argFlags: IS_WIN
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']
      : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
    scriptArgs: (f) =>
      IS_WIN
        ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f]
        : ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', f],
    resolve: () =>
      IS_WIN
        ? firstExisting(pwshCandidates()) || onPath('pwsh.exe')
        : firstExisting(['/usr/bin/pwsh', '/usr/local/bin/pwsh', '/opt/microsoft/powershell/7/pwsh']),
  },
  wsl: {
    platforms: ['win32'],
    ext: '.sh',
    argFlags: ['-e', 'bash', '-c'],
    scriptArgs: null, // temp paths are Windows-shaped; WSL needs the -c form
    resolve: () => firstExisting([join(sysRoot(), 'System32', 'wsl.exe')]),
  },
};

export const SHELL_NAMES = Object.keys(PROFILES);

/** Ordered guesses for `shell: "auto"`. */
function autoOrder() {
  if (IS_WIN) return ['pwsh', 'powershell', 'cmd'];
  const envShell = process.env.SHELL || '';
  const base = envShell.split('/').pop();
  const order = ['bash', 'zsh', 'sh'];
  if (base && PROFILES[base]) return [base, ...order.filter((s) => s !== base)];
  return order;
}

/**
 * Turn a config/param shell spec into something spawnable.
 * Accepts: "auto", a profile name, an absolute path to an executable, or an
 * object {command, args?, scriptExt?, mode?}.
 */
export function resolveShell(spec, custom = {}) {
  if (!spec || spec === 'auto' || spec === 'default') {
    for (const name of autoOrder()) {
      const r = tryProfile(name);
      if (r) return r;
    }
    // Last resort: whatever Node thinks the system shell is.
    return {
      name: 'system',
      command: IS_WIN ? 'cmd.exe' : '/bin/sh',
      mode: IS_WIN ? 'script' : 'arg',
      ext: IS_WIN ? '.cmd' : '.sh',
      argFlags: IS_WIN ? ['/d', '/s', '/c'] : ['-c'],
      scriptArgs: IS_WIN ? (f) => ['/d', '/s', '/c', f] : (f) => [f],
    };
  }

  if (typeof spec === 'object') return fromCustom('custom', spec);
  if (custom[spec]) return fromCustom(spec, custom[spec]);

  const key = String(spec).toLowerCase();
  if (PROFILES[key]) {
    const r = tryProfile(key);
    if (!r) throw new Error(`Shell "${spec}" is not available on this system (${process.platform}).`);
    return r;
  }

  // Treat as a path / executable name; infer the profile from its basename.
  const base = String(spec).replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '').toLowerCase();
  const proto = PROFILES[base];
  if (proto) {
    return {
      name: base,
      command: spec,
      mode: proto.prefer || 'arg',
      ext: proto.ext,
      argFlags: proto.argFlags,
      loginFlags: proto.loginFlags,
      scriptArgs: proto.scriptArgs,
    };
  }
  return {
    name: base || 'custom',
    command: spec,
    mode: 'arg',
    ext: IS_WIN ? '.cmd' : '.sh',
    argFlags: ['-c'],
    scriptArgs: (f) => [f],
  };
}

function fromCustom(name, def) {
  if (!def.command) throw new Error(`Custom shell "${name}" has no "command".`);
  const args = def.args || ['-c'];
  return {
    name,
    command: def.command,
    mode: def.mode || 'arg',
    ext: def.scriptExt || (IS_WIN ? '.cmd' : '.sh'),
    argFlags: args,
    scriptArgs: def.scriptArgs ? (f) => [...def.scriptArgs.map((a) => (a === '{file}' ? f : a))] : (f) => [...args.slice(0, -1), f],
  };
}

function tryProfile(name) {
  const p = PROFILES[name];
  if (!p || !p.platforms.includes(process.platform)) return null;
  const command = p.resolve();
  if (!command) return null;
  return {
    name,
    command,
    mode: p.prefer || 'arg',
    ext: p.ext,
    argFlags: p.argFlags,
    loginFlags: p.loginFlags,
    scriptArgs: p.scriptArgs,
  };
}

/** Which known shells are actually installed here — used by `shell_info`. */
export function detectAvailable() {
  const out = [];
  for (const name of SHELL_NAMES) {
    const r = tryProfile(name);
    if (r) out.push({ name, command: r.command, mode: r.mode });
  }
  return out;
}

let scriptDir = null;
async function ensureScriptDir() {
  if (!scriptDir) scriptDir = await mkdtemp(join(tmpdir(), 'terminalmcp-'));
  return scriptDir;
}

/**
 * Build the argv for running `command` in `shell`.
 * Returns { file, args, cleanup } — call cleanup() once the process exits.
 */
export async function buildInvocation(shell, command, { login = false, mode } = {}) {
  const useMode = mode || shell.mode || 'arg';

  if (useMode === 'script' && shell.scriptArgs) {
    const dir = await ensureScriptDir();
    const path = join(dir, `cmd-${randomBytes(6).toString('hex')}${shell.ext || '.sh'}`);
    const body = scriptPreamble(shell) + command + scriptEpilogue(shell);
    await writeFile(path, body, { encoding: 'utf8', mode: 0o700 });
    return {
      file: shell.command,
      args: shell.scriptArgs(path),
      cleanup: () => unlink(path).catch(() => {}),
    };
  }

  const flags = login && shell.loginFlags ? shell.loginFlags : shell.argFlags;
  return { file: shell.command, args: [...flags, command], cleanup: () => {} };
}

function scriptPreamble(shell) {
  if (shell.ext === '.cmd') return '@echo off\r\nsetlocal\r\n';
  if (shell.ext === '.ps1') return '$ErrorActionPreference = "Continue"\r\n';
  return '';
}

function scriptEpilogue(shell) {
  // cmd.exe: make the script's exit code the last command's exit code.
  if (shell.ext === '.cmd') return '\r\nexit /b %ERRORLEVEL%\r\n';
  // $LASTEXITCODE is unset after a script of pure cmdlets; exiting $null throws.
  if (shell.ext === '.ps1')
    return '\r\nif ($null -eq $LASTEXITCODE) { exit 0 } else { exit $LASTEXITCODE }\r\n';
  return '\n';
}
