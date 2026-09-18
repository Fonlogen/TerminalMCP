// Desktop screen capture: the whole screen, one monitor, one window, or a
// rectangle the caller picks.
//
// There is no portable API for this, so each platform gets the tool its users
// already have:
//
//   Windows  PowerShell + System.Drawing + a little user32 — always present,
//            nothing to install, and it can enumerate windows properly.
//   macOS    screencapture(1), which ships with the OS.
//   Linux    whichever of grim/maim/import/scrot/gnome-screenshot/spectacle
//            is installed, chosen by whether the session is Wayland or X11.
//
// The selection logic is kept separate from running anything (see
// `pickCapturer`) so it can be tested on a machine with no display at all —
// which, notably, includes most CI.

import { mkdirSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { describeRunFailure, runArgv, runFailed } from './exec.js';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

function onPath(name) {
  const dirs = (process.env.PATH || '').split(IS_WIN ? ';' : ':').filter(Boolean);
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      if (existsSync(path.join(dir, name + ext))) return path.join(dir, name + ext);
    }
  }
  return null;
}

/**
 * A temp directory that Node and .NET agree on.
 *
 * os.tmpdir() returns TEMP verbatim, and Git Bash sets TEMP=/tmp — a path
 * PowerShell and .NET resolve against whatever drive the process happens to be
 * on, while Node resolves it against its own. The file then lands somewhere the
 * caller never looks. On Windows, insist on a drive-qualified path.
 */
export function shotTempDir({ tmp = tmpdir(), env = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') return tmp;
  const rooted = (v) => typeof v === 'string' && (/^[a-zA-Z]:[\\/]/.test(v) || v.startsWith('\\\\'));
  if (rooted(tmp)) return tmp;
  const join = path.win32.join;
  if (rooted(env.LOCALAPPDATA)) return join(env.LOCALAPPDATA, 'Temp');
  if (rooted(env.USERPROFILE)) return join(env.USERPROFILE, 'AppData', 'Local', 'Temp');
  return join(env.SystemRoot || env.windir || 'C:\\Windows', 'Temp');
}

/** x11, wayland, quartz, windows — or null when there is no desktop at all. */
export function sessionType() {
  if (IS_WIN) return 'windows';
  if (IS_MAC) return 'quartz';
  if (process.env.WAYLAND_DISPLAY) return 'wayland';
  if (process.env.DISPLAY) return 'x11';
  if (process.env.XDG_SESSION_TYPE === 'wayland') return 'wayland';
  if (process.env.XDG_SESSION_TYPE === 'x11') return 'x11';
  return null;
}

/**
 * Linux capture back ends, best first.
 *
 * Each entry says what it can do rather than being assumed to do everything:
 * scrot cannot target a window by id, gnome-screenshot cannot crop, and
 * pretending otherwise produces a confusing failure instead of a clear one.
 */
export const LINUX_CAPTURERS = [
  {
    name: 'grim',
    session: 'wayland',
    full: (out) => ['grim', out],
    region: (r, out) => ['grim', '-g', `${r.x},${r.y} ${r.width}x${r.height}`, out],
    display: (name, out) => ['grim', '-o', name, out],
    install: 'apt install grim  (Wayland)',
  },
  {
    name: 'maim',
    session: 'x11',
    full: (out) => ['maim', '--hidecursor', out],
    region: (r, out) => ['maim', '--hidecursor', '-g', `${r.width}x${r.height}+${r.x}+${r.y}`, out],
    window: (id, out) => ['maim', '--hidecursor', '-i', String(id), out],
    install: 'apt install maim',
  },
  {
    name: 'import',
    session: 'x11',
    full: (out) => ['import', '-silent', '-window', 'root', out],
    region: (r, out) => [
      'import', '-silent', '-window', 'root',
      '-crop', `${r.width}x${r.height}+${r.x}+${r.y}`, '+repage', out,
    ],
    window: (id, out) => ['import', '-silent', '-window', String(id), out],
    install: 'apt install imagemagick',
  },
  {
    name: 'scrot',
    session: 'x11',
    full: (out) => ['scrot', '--overwrite', out],
    region: (r, out) => ['scrot', '--overwrite', '-a', `${r.x},${r.y},${r.width},${r.height}`, out],
    install: 'apt install scrot',
  },
  {
    name: 'spectacle',
    session: 'any',
    full: (out) => ['spectacle', '-b', '-n', '-f', '-o', out],
    window: (id, out) => ['spectacle', '-b', '-n', '-a', '-o', out],
    install: 'KDE: apt install kde-spectacle',
  },
  {
    name: 'gnome-screenshot',
    session: 'any',
    full: (out) => ['gnome-screenshot', '-f', out],
    window: (id, out) => ['gnome-screenshot', '-w', '-f', out],
    install: 'GNOME: apt install gnome-screenshot',
  },
  {
    name: 'xfce4-screenshooter',
    session: 'x11',
    full: (out) => ['xfce4-screenshooter', '-f', '-s', out],
    install: 'XFCE: apt install xfce4-screenshooter',
  },
];

/**
 * Choose a Linux capture back end for a given mode.
 * Pure: takes the list of installed tool names, so it is testable anywhere.
 */
export function pickCapturer(mode, { session, installed }) {
  const usable = LINUX_CAPTURERS.filter(
    (c) => installed.includes(c.name) && (c.session === 'any' || c.session === session),
  );
  if (!usable.length) {
    const wrongSession = LINUX_CAPTURERS.filter((c) => installed.includes(c.name));
    return {
      tool: null,
      reason: wrongSession.length
        ? `${wrongSession.map((c) => c.name).join(', ')} is installed but is for ` +
          `${wrongSession[0].session}, and this is a ${session} session`
        : 'no screenshot tool installed',
      suggest: LINUX_CAPTURERS.filter((c) => c.session === 'any' || c.session === session)
        .map((c) => c.install)
        .filter(Boolean),
    };
  }

  const capable = usable.filter((c) => typeof c[mode] === 'function');
  if (!capable.length) {
    return {
      tool: null,
      reason:
        `${usable.map((c) => c.name).join(', ')} cannot capture "${mode}" — ` +
        `${usable[0].name} supports ${Object.keys(usable[0]).filter((k) => typeof usable[0][k] === 'function').join(', ')}`,
      suggest: LINUX_CAPTURERS.filter((c) => typeof c[mode] === 'function' && (c.session === 'any' || c.session === session))
        .map((c) => c.install)
        .filter(Boolean),
    };
  }
  return { tool: capable[0], reason: null, suggest: [] };
}

// -------------------------------------------------------------- Windows side

/**
 * One PowerShell script covers listing displays, listing windows and
 * capturing, because starting PowerShell is the slow part — not the work.
 *
 * The C# is a literal here-string (@'...'@) so PowerShell does not try to
 * interpolate anything that looks like a variable inside it.
 */
export const WINDOWS_SCRIPT = `param(
  [string]$Mode = 'full',
  [string]$OutFile = '',
  [int]$Left = 0, [int]$Top = 0, [int]$Width = 0, [int]$Height = 0,
  [int]$DisplayIndex = 0,
  [string]$TitleMatch = '',
  [int]$Raise = 0
)
# Parameter names are spelled out on purpose. PowerShell binds parameters by
# prefix, so short ones like -Out or -W are a standing liability: the moment the
# binder also offers common parameters they become ambiguous, and the script
# then fails before it runs, with a message that says nothing about screenshots.
$ErrorActionPreference = 'Stop'

# Failures are reported as one tab-separated line on stdout rather than left to
# PowerShell's own formatting, so the caller gets the exception TYPE and not
# just a sentence — which is the difference between "capture failed" and "this
# process cannot reach the interactive desktop".
function Fail($stage, $err) {
  $ex = $err
  if ($err -is [System.Management.Automation.ErrorRecord]) { $ex = $err.Exception }
  $type = 'none'
  $hr = ''
  $msg = [string]$err
  if ($ex -is [Exception]) {
    $type = $ex.GetType().FullName
    $msg = $ex.Message
    try { $hr = '0x' + ($ex.HResult).ToString('X8') } catch { $hr = '' }
  }
  $msg = $msg.Replace("\`r", ' ').Replace("\`n", ' ').Replace("\`t", ' ').Trim()
  Write-Output ("ERR\`t" + $stage + "\`t" + $type + "\`t" + $hr + "\`t" + $msg)
  exit 2
}

try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
} catch { Fail 'assemblies' $_ }

try {
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class TMcpWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder info, int len, out int needed);
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(int flags, bool inherit, int access);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public static List<string> List() {
    var res = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len == 0) return true;
      var sb = new StringBuilder(len + 2);
      GetWindowText(h, sb, sb.Capacity);
      RECT r; GetWindowRect(h, out r);
      int w = r.Right - r.Left, hh = r.Bottom - r.Top;
      if (w < 8 || hh < 8) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      res.Add(h.ToInt64() + "\\t" + pid + "\\t" + r.Left + "\\t" + r.Top + "\\t" + w + "\\t" + hh
              + "\\t" + (IsIconic(h) ? "min" : "normal") + "\\t" + sb.ToString());
      return true;
    }, IntPtr.Zero);
    return res;
  }

  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    string want = title.ToLowerInvariant();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (found != IntPtr.Zero || !IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len == 0) return true;
      var sb = new StringBuilder(len + 2);
      GetWindowText(h, sb, sb.Capacity);
      if (sb.ToString().ToLowerInvariant().Contains(want)) found = h;
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static int[] RectOf(IntPtr h) {
    RECT r; GetWindowRect(h, out r);
    return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
  }

  // Only processes on the interactive window station (WinSta0) can copy
  // pixels off the screen; a service or an SSH login sits on its own station
  // and can still enumerate windows, which is exactly why a failure there
  // looks so much like a bug in the tool.
  public static string StationName() {
    var sb = new StringBuilder(256);
    int need;
    if (GetUserObjectInformation(GetProcessWindowStation(), 2, sb, 256, out need)) return sb.ToString();
    return "unknown";
  }

  public static bool InputDesktop() {
    IntPtr d = OpenInputDesktop(0, false, 0x0001);
    if (d == IntPtr.Zero) return false;
    CloseDesktop(d);
    return true;
  }
}
'@
} catch { Fail 'compile' $_ }

# Without this, a scaled display is captured at the wrong size.
try { [TMcpWin]::SetProcessDPIAware() | Out-Null } catch { }

function Grab($x, $y, $w, $h, $out) {
  if ($w -lt 1 -or $h -lt 1) { Fail 'geometry' "the capture area is empty ($w x $h)" }
  if ($out -eq '') { Fail 'args' 'no output path was given' }

  # Resolve the path here, with .NET's own rules. PowerShell's current
  # directory and the process's are not the same thing, and Bitmap.Save uses
  # the latter — so a relative or drive-less path (Git Bash hands over /tmp/...)
  # would be written somewhere the caller never looks.
  $full = ''
  try { $full = [System.IO.Path]::GetFullPath($out) } catch { Fail 'path' $_ }
  $dir = [System.IO.Path]::GetDirectoryName($full)
  if ($dir -ne '' -and -not (Test-Path -LiteralPath $dir)) {
    try { New-Item -ItemType Directory -Path $dir -Force | Out-Null } catch { Fail 'path' $_ }
  }

  $bmp = $null
  $g = $null
  try {
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))
  } catch {
    if ($g -ne $null) { $g.Dispose() }
    if ($bmp -ne $null) { $bmp.Dispose() }
    Fail 'copyfromscreen' $_
  }

  try {
    $bmp.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)
  } catch {
    Fail 'save' $_
  } finally {
    if ($g -ne $null) { $g.Dispose() }
    if ($bmp -ne $null) { $bmp.Dispose() }
  }

  $len = 0
  try { $len = (Get-Item -LiteralPath $full).Length } catch { Fail 'save' "nothing was written to $full" }
  Write-Output ("OK\`t" + $x + "\`t" + $y + "\`t" + $w + "\`t" + $h + "\`t" + $full + "\`t" + $len)
}

# Anything the stages above did not anticipate — a type initializer, a runtime
# that is not installed, a mode that never reaches Grab — still has to come back
# as one parseable line rather than as PowerShell's own multi-page rendering.
try {
  switch ($Mode) {
    'displays' {
      $i = 0
      foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
        $i++
        $b = $s.Bounds
        Write-Output ($i.ToString() + "\`t" + $b.X + "\`t" + $b.Y + "\`t" + $b.Width + "\`t" + $b.Height + "\`t" + $(if ($s.Primary) { "primary" } else { "secondary" }) + "\`t" + $s.DeviceName)
      }
    }
    'windows' { [TMcpWin]::List() | ForEach-Object { Write-Output $_ } }
    'probe' {
      Write-Output ("powershell\`t" + $PSVersionTable.PSVersion.ToString() + "\`t" + $PSVersionTable.PSEdition)
      Write-Output ("winsession\`t" + [System.Diagnostics.Process]::GetCurrentProcess().SessionId)
      Write-Output ("station\`t" + [TMcpWin]::StationName())
      Write-Output ("inputdesktop\`t" + [TMcpWin]::InputDesktop())
      Write-Output ("displays\`t" + @([System.Windows.Forms.Screen]::AllScreens).Count)
      $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
      Write-Output ("virtualscreen\`t" + $b.Width + "x" + $b.Height + " at " + $b.X + "," + $b.Y)
      # The smallest possible capture: it costs nothing and answers the only
      # question that matters — may this process read the screen at all?
      try {
        $bmp = New-Object System.Drawing.Bitmap 1, 1
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen(0, 0, 0, 0, (New-Object System.Drawing.Size 1, 1))
        $g.Dispose()
        $bmp.Dispose()
        Write-Output "copyfromscreen\`tok"
      } catch {
        $ex = $_.Exception
        $m = $ex.Message.Replace("\`r", ' ').Replace("\`n", ' ').Replace("\`t", ' ').Trim()
        Write-Output ("copyfromscreen\`tfailed\`t" + $ex.GetType().FullName + "\`t" + $m)
      }
    }
    'full' {
      $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
      Grab $b.X $b.Y $b.Width $b.Height $OutFile
    }
    'display' {
      $all = @([System.Windows.Forms.Screen]::AllScreens)
      if ($DisplayIndex -lt 1 -or $DisplayIndex -gt $all.Count) { Fail 'args' "there is no display $DisplayIndex; this machine has $($all.Count)" }
      $b = $all[$DisplayIndex - 1].Bounds
      Grab $b.X $b.Y $b.Width $b.Height $OutFile
    }
    'region' { Grab $Left $Top $Width $Height $OutFile }
    'window' {
      $h = [TMcpWin]::Find($TitleMatch)
      if ($h -eq [IntPtr]::Zero) { Fail 'window' "no visible window has '$TitleMatch' in its title" }
      if ($Raise -ne 0) {
        [TMcpWin]::ShowWindow($h, 9) | Out-Null
        [TMcpWin]::SetForegroundWindow($h) | Out-Null
        Start-Sleep -Milliseconds 350
      }
      # A minimized window has no pixels on screen: GetWindowRect returns an
      # off-screen rectangle and the capture would be a black image.
      if ([TMcpWin]::IsIconic($h)) { Fail 'minimized' "the window '$TitleMatch' is minimized, so there is nothing on screen to copy" }
      $r = [TMcpWin]::RectOf($h)
      Grab $r[0] $r[1] $r[2] $r[3] $OutFile
    }
    default { Fail 'args' "unknown mode '$Mode'" }
  }
} catch { Fail 'unexpected' $_ }
`;

let windowsScriptPath = null;

async function windowsScript() {
  if (windowsScriptPath && existsSync(windowsScriptPath)) return windowsScriptPath;
  const p = path.join(shotTempDir(), `terminalmcp-screen-${process.pid}.ps1`);
  // The BOM makes PowerShell 5 read it as UTF-8 rather than the ANSI codepage.
  await writeFile(p, `﻿${WINDOWS_SCRIPT}`, 'utf8');
  windowsScriptPath = p;
  return p;
}

function powershell() {
  return onPath('pwsh') ? 'pwsh' : 'powershell';
}

/**
 * What to say when GDI can see the desktop's furniture but not its pixels.
 *
 * This is the failure that looks most like a broken tool and is least like one:
 * every listing action succeeds, every capture fails, and the underlying
 * message ("The handle is invalid") explains nothing to anybody.
 */
export const NO_INTERACTIVE_DESKTOP =
  'Windows refused the capture: this process cannot reach the interactive desktop. ' +
  'Enumerating monitors and windows works from anywhere, but copying pixels does not — ' +
  'which is exactly why displays and windows succeed while every shot fails. ' +
  'The usual causes are a server running as a Windows service or scheduled task, ' +
  'in session 0, or started from an SSH/WinRM login instead of the desktop session ' +
  'you are logged into.\n' +
  'Run screen { action: "probe" }: it reports the window station (only WinSta0 can ' +
  'capture), the Windows session id, and a one-pixel test capture with the exact exception.\n' +
  'The fix is to start TerminalMCP from a terminal inside your own logged-in session. ' +
  'A web page needs no desktop at all: the browser tool screenshots headlessly, ' +
  'including the whole scrolling page.';

const DESKTOP_DENIED = /invalid handle|handle is invalid|handle non valido|access is denied|accesso negato|denied|unauthori[sz]ed/i;

/** Pull the script's one-line ERR report out of its stdout, if it made one. */
export function findWindowsError(stdout = '') {
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.startsWith('ERR\t')) continue;
    const parts = line.split('\t');
    return {
      stage: parts[1] ?? '',
      type: parts[2] ?? '',
      hresult: parts[3] ?? '',
      message: parts.slice(4).join('\t').trim(),
    };
  }
  return null;
}

/** Turn that report into something the reader can act on. */
export function explainWindowsFailure(err) {
  const stage = err?.stage ?? '';
  const type = err?.type && err.type !== 'none' ? err.type : '';
  const message = (err?.message ?? '').trim();
  const hresult = err?.hresult ? ` ${err.hresult}` : '';
  const raw = `${type ? `${type}: ` : ''}${message}${hresult}`.trim();

  switch (stage) {
    case 'copyfromscreen':
      if (/Win32Exception/i.test(type) || DESKTOP_DENIED.test(message)) {
        return `${NO_INTERACTIVE_DESKTOP}\nWindows said: ${raw}`;
      }
      return (
        `Windows could not copy the screen: ${raw}.\n` +
        'Run screen { action: "probe" } — it tries a one-pixel capture and reports the ' +
        'window station and session id, which says whether this process can read the screen at all.'
      );
    case 'save':
      return (
        `The screen was captured but the PNG could not be written: ${raw}.\n` +
        'GDI+ reports a "generic error" for anything it cannot write, so this is almost ' +
        'always the destination: a capture goes to the temp directory first, so check that ' +
        'TEMP points somewhere this user may write to.'
      );
    case 'assemblies':
      return (
        `PowerShell could not load System.Drawing / System.Windows.Forms: ${raw}.\n` +
        'That is a PowerShell 7 install without the Windows Desktop runtime. ' +
        'Windows PowerShell 5.1 (powershell.exe) always has both — remove pwsh from PATH ' +
        'for this server, or install the .NET Windows Desktop runtime.'
      );
    case 'compile':
      return `PowerShell could not compile the helper this tool uses to reach user32: ${raw}.`;
    case 'unexpected':
      // A type initializer blowing up is what a broken or absent GDI+ looks
      // like from here, so treat it as the assembly problem it is.
      if (/type initializer|System\.Drawing|Could not load file or assembly/i.test(raw)) {
        return explainWindowsFailure({ ...err, stage: 'assemblies' });
      }
      return (
        `Screen capture failed in a way this tool did not anticipate: ${raw}.\n` +
        'Run screen { action: "probe" }: it reports the PowerShell version, the window ' +
        'station and a one-pixel test capture, which usually names the real cause.'
      );
    case 'minimized':
      return `${message}. Pass activate: true to raise it first, or capture the whole screen.`;
    case 'window':
      return `${message}. Action "windows" lists every title that exists.`;
    case 'path':
      return `That screenshot path cannot be used: ${raw}.`;
    case 'geometry':
    case 'args':
      return message || raw || `Screen capture was asked for something impossible (${stage}).`;
    default:
      return `Screen capture failed${stage ? ` at stage "${stage}"` : ''}: ${raw || 'no detail was reported'}`;
  }
}

/**
 * The last line of a successful capture: OK, x, y, w, h, the path the script
 * resolved, and the bytes it wrote.
 */
export function parseWindowsOk(stdout = '') {
  const last = String(stdout).trim().split(/\r?\n/).pop() ?? '';
  const p = last.split('\t');
  if (p[0] !== 'OK') return null;
  return {
    x: Number(p[1]),
    y: Number(p[2]),
    width: Number(p[3]),
    height: Number(p[4]),
    path: p[5] || null,
    bytes: Number(p[6] ?? 0),
  };
}

async function runWindows(cfg, args, timeoutMs) {
  const script = await windowsScript();
  const r = await runArgv(cfg, {
    file: powershell(),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    timeoutMs,
  });
  // A reported failure beats an exit code: it carries the stage and the
  // exception type, which is what makes the cause nameable.
  const reported = findWindowsError(r.stdout);
  if (reported) throw new Error(explainWindowsFailure(reported));
  if (runFailed(r)) {
    throw new Error(
      `${describeRunFailure(r, 'PowerShell')}\n` +
      'The script reports its own failures as an ERR line and printed none, so this ' +
      'came from outside it. Run screen { action: "probe" } for the whole picture.',
    );
  }
  return r.stdout;
}

// ------------------------------------------------------------------ displays

/** Every monitor, with its position in the virtual desktop. */
export async function listDisplays(cfg, { timeoutMs = 15000 } = {}) {
  const session = sessionType();
  if (!session) throw new Error(noDesktopMessage());

  if (session === 'windows') {
    const out = await runWindows(cfg, ['-Mode', 'displays'], timeoutMs);
    return out
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [index, x, y, width, height, primary, name] = line.split('\t');
        return {
          index: Number(index),
          x: Number(x),
          y: Number(y),
          width: Number(width),
          height: Number(height),
          primary: primary === 'primary',
          name,
        };
      });
  }

  if (session === 'quartz') {
    // system_profiler is the only built-in source, and it is slow, so this is
    // the one place we accept a couple of seconds.
    const r = await runArgv(cfg, {
      file: 'system_profiler',
      args: ['-json', 'SPDisplaysDataType'],
      timeoutMs,
    });
    const out = [];
    try {
      const data = JSON.parse(r.stdout);
      const cards = data.SPDisplaysDataType ?? [];
      let i = 0;
      for (const card of cards) {
        for (const d of card._items ?? card.spdisplays_ndrvs ?? []) {
          i++;
          const res = d._spdisplays_resolution ?? d.spdisplays_resolution ?? d._spdisplays_pixels ?? '';
          const m = String(res).match(/(\d+)\s*[x×]\s*(\d+)/);
          out.push({
            index: i,
            x: 0,
            y: 0,
            width: m ? Number(m[1]) : null,
            height: m ? Number(m[2]) : null,
            primary: /main/i.test(String(d.spdisplays_main ?? '')),
            name: d._name ?? `Display ${i}`,
          });
        }
      }
    } catch {
      /* fall through to the generic answer below */
    }
    if (out.length) return out;
    return [{ index: 1, x: 0, y: 0, width: null, height: null, primary: true, name: 'Main display' }];
  }

  if (session === 'wayland') {
    if (onPath('wlr-randr')) {
      const r = await runArgv(cfg, { file: 'wlr-randr', args: [], timeoutMs });
      const out = [];
      let cur = null;
      for (const line of r.stdout.split(/\r?\n/)) {
        const head = line.match(/^(\S+)\s+"/);
        if (head) {
          cur = { index: out.length + 1, name: head[1], x: 0, y: 0, width: null, height: null, primary: out.length === 0 };
          out.push(cur);
          continue;
        }
        const mode = line.match(/^\s+(\d+)x(\d+).*current/);
        if (mode && cur) {
          cur.width = Number(mode[1]);
          cur.height = Number(mode[2]);
        }
      }
      if (out.length) return out;
    }
    if (onPath('swaymsg')) {
      const r = await runArgv(cfg, { file: 'swaymsg', args: ['-t', 'get_outputs', '-r'], timeoutMs });
      try {
        return JSON.parse(r.stdout).map((o, i) => ({
          index: i + 1,
          name: o.name,
          x: o.rect?.x ?? 0,
          y: o.rect?.y ?? 0,
          width: o.rect?.width ?? null,
          height: o.rect?.height ?? null,
          primary: Boolean(o.focused),
        }));
      } catch {
        /* fall through */
      }
    }
    throw new Error(
      'Cannot list Wayland outputs: neither wlr-randr nor swaymsg is installed. ' +
      'Capture the whole screen instead (mode "screen"), or name an output you already know.',
    );
  }

  // X11
  if (!onPath('xrandr')) {
    throw new Error('Cannot list displays: xrandr is not installed (apt install x11-xserver-utils).');
  }
  const r = await runArgv(cfg, { file: 'xrandr', args: ['--listmonitors'], timeoutMs });
  const out = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    // " 0: +*eDP-1 1920/344x1080/193+0+0  eDP-1"
    const m = line.match(/^\s*(\d+):\s+\+(\*?)(\S+)\s+(\d+)\/\d+x(\d+)\/\d+\+(\d+)\+(\d+)/);
    if (!m) continue;
    out.push({
      index: Number(m[1]) + 1,
      name: m[3],
      primary: m[2] === '*',
      width: Number(m[4]),
      height: Number(m[5]),
      x: Number(m[6]),
      y: Number(m[7]),
    });
  }
  if (!out.length) throw new Error('xrandr reported no monitors');
  return out;
}

// ------------------------------------------------------------------- windows

/** Visible top-level windows: id, owner pid, geometry, title. */
export async function listWindows(cfg, { timeoutMs = 15000 } = {}) {
  const session = sessionType();
  if (!session) throw new Error(noDesktopMessage());

  if (session === 'windows') {
    const out = await runWindows(cfg, ['-Mode', 'windows'], timeoutMs);
    return out
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [id, pid, x, y, width, height, state, ...rest] = line.split('\t');
        return {
          id,
          pid: Number(pid),
          x: Number(x),
          y: Number(y),
          width: Number(width),
          height: Number(height),
          minimized: state === 'min',
          title: rest.join('\t'),
        };
      });
  }

  if (session === 'quartz') {
    const script =
      'set out to ""\n' +
      'tell application "System Events"\n' +
      '  repeat with p in (every application process whose visible is true)\n' +
      '    repeat with w in (every window of p)\n' +
      '      try\n' +
      '        set pos to position of w\n' +
      '        set sz to size of w\n' +
      '        set out to out & (unix id of p) & tab & (item 1 of pos) & tab & (item 2 of pos) & tab & ' +
      '(item 1 of sz) & tab & (item 2 of sz) & tab & (name of p) & " — " & (name of w) & linefeed\n' +
      '      end try\n' +
      '    end repeat\n' +
      '  end repeat\n' +
      'end tell\n' +
      'return out';
    const r = await runArgv(cfg, { file: 'osascript', args: ['-e', script], timeoutMs });
    if (runFailed(r)) {
      const denied = /not allowed assistive|1743|accessibility/i.test(r.stderr || '');
      throw new Error(
        denied
          ? 'macOS refused the window list: this process needs Accessibility permission. ' +
            'System Settings → Privacy & Security → Accessibility, and add the app running this server ' +
            '(Terminal, iTerm, VS Code…). Region capture with x/y/width/height needs no permission.'
          : `Could not list windows: ${describeRunFailure(r, 'osascript')}`,
      );
    }
    return r.stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line, i) => {
        const [pid, x, y, width, height, ...rest] = line.split('\t');
        return {
          id: String(i + 1),
          pid: Number(pid),
          x: Number(x),
          y: Number(y),
          width: Number(width),
          height: Number(height),
          minimized: false,
          title: rest.join('\t'),
        };
      });
  }

  if (session === 'wayland') {
    if (onPath('swaymsg')) {
      const r = await runArgv(cfg, { file: 'swaymsg', args: ['-t', 'get_tree', '-r'], timeoutMs });
      const out = [];
      const walk = (node) => {
        if (node.pid && node.name && node.rect) {
          out.push({
            id: String(node.id),
            pid: node.pid,
            x: node.rect.x,
            y: node.rect.y,
            width: node.rect.width,
            height: node.rect.height,
            minimized: false,
            title: node.name,
          });
        }
        for (const c of [...(node.nodes ?? []), ...(node.floating_nodes ?? [])]) walk(c);
      };
      try {
        walk(JSON.parse(r.stdout));
        return out;
      } catch {
        /* fall through */
      }
    }
    throw new Error(
      'Wayland does not let an application enumerate other windows, by design. ' +
      'On Sway, swaymsg works; otherwise capture the whole screen (mode "screen") ' +
      'or a region you specify.',
    );
  }

  // X11
  if (onPath('wmctrl')) {
    const r = await runArgv(cfg, { file: 'wmctrl', args: ['-lGp'], timeoutMs });
    const rows = r.stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\s+/);
        const [id, , pid, x, y, width, height] = parts;
        return {
          id,
          pid: Number(pid),
          x: Number(x),
          y: Number(y),
          width: Number(width),
          height: Number(height),
          minimized: false,
          title: parts.slice(8).join(' '),
        };
      });
    if (rows.length) return rows;
    // wmctrl only knows what the window manager publishes in _NET_CLIENT_LIST.
    // A bare X session, or a WM without EWMH, leaves it with nothing to read —
    // which is not the same as there being no windows. xdotool asks the X
    // server itself, so try that before believing the desktop is empty.
  }
  if (onPath('xdotool')) {
    const r = await runArgv(cfg, {
      file: 'xdotool',
      args: ['search', '--onlyvisible', '--name', '.'],
      timeoutMs,
    });
    const ids = r.stdout.trim().split(/\s+/).filter(Boolean);
    const out = [];
    for (const id of ids.slice(0, 80)) {
      const [name, geo] = await Promise.all([
        runArgv(cfg, { file: 'xdotool', args: ['getwindowname', id], timeoutMs: 3000 }),
        runArgv(cfg, { file: 'xdotool', args: ['getwindowgeometry', '--shell', id], timeoutMs: 3000 }),
      ]);
      const g = Object.fromEntries(
        geo.stdout
          .trim()
          .split(/\r?\n/)
          .map((l) => l.split('='))
          .filter((p) => p.length === 2),
      );
      const title = name.stdout.trim();
      if (!title) continue;
      out.push({
        id,
        pid: Number(g.PID ?? 0),
        x: Number(g.X ?? 0),
        y: Number(g.Y ?? 0),
        width: Number(g.WIDTH ?? 0),
        height: Number(g.HEIGHT ?? 0),
        minimized: false,
        title,
      });
    }
    return out;
  }
  throw new Error(
    'Cannot list windows: neither wmctrl nor xdotool is installed (apt install wmctrl). ' +
    'Capturing the whole screen or a region still works.',
  );
}

function noDesktopMessage() {
  return (
    'No graphical session: DISPLAY and WAYLAND_DISPLAY are both unset, so there is no ' +
    'screen to capture. This is normal on a server, in a container, and over plain SSH. ' +
    'To screenshot a web page here, use the browser tool instead — it renders headlessly ' +
    'and its screenshot action needs no display.'
  );
}

// ------------------------------------------------------------------- capture

/**
 * Take a screenshot.
 *
 * `mode`:
 *   screen  everything, across all monitors
 *   display one monitor, by index or name
 *   window  one window, matched on its title
 *   region  an exact rectangle
 *
 * Returns { buf, tool, mode, detail } — the PNG bytes, not a path. Saving is
 * the caller's decision, which keeps this usable under readOnly.
 */
export async function capture(cfg, { mode = 'screen', display = null, window: windowSpec = null, region = null, activate = false, delayMs = 0, timeoutMs = 30000 } = {}) {
  const session = sessionType();
  if (!session) throw new Error(noDesktopMessage());

  if (delayMs > 0) await new Promise((r) => setTimeout(r, Math.min(delayMs, 60000)));

  const out = path.join(shotTempDir(), `terminalmcp-shot-${process.pid}-${Date.now()}.png`);
  mkdirSync(path.dirname(out), { recursive: true });
  let tool = session;
  let detail = '';
  // Where the file actually ended up; the Windows script reports it back.
  let written = out;

  try {
    if (session === 'windows') {
      const args =
        mode === 'region'
          ? ['-Mode', 'region', '-Left', String(region.x), '-Top', String(region.y), '-Width', String(region.width), '-Height', String(region.height)]
          : mode === 'display'
            ? ['-Mode', 'display', '-DisplayIndex', String(await resolveDisplayIndex(cfg, display, timeoutMs))]
            : mode === 'window'
              ? ['-Mode', 'window', '-TitleMatch', String(windowSpec), '-Raise', activate ? '1' : '0']
              : ['-Mode', 'full'];
      const stdout = await runWindows(cfg, [...args, '-OutFile', out], timeoutMs);
      tool = `${powershell()} + System.Drawing`;
      const ok = parseWindowsOk(stdout);
      if (ok) {
        detail = `${ok.width}x${ok.height} at ${ok.x},${ok.y}`;
        // Read back the path the script resolved, not the one we asked for:
        // .NET and Node do not always agree on what a path means.
        if (ok.path) written = ok.path;
      }
    } else if (session === 'quartz') {
      const args = ['-x']; // no shutter sound
      if (mode === 'region') {
        args.push('-R', `${region.x},${region.y},${region.width},${region.height}`);
      } else if (mode === 'display') {
        args.push('-D', String(await resolveDisplayIndex(cfg, display, timeoutMs)));
      } else if (mode === 'window') {
        // screencapture -l needs a CGWindowID, which AppleScript cannot give
        // us, so a window becomes the rectangle it occupies.
        const win = await findWindow(cfg, windowSpec, timeoutMs);
        args.push('-R', `${win.x},${win.y},${win.width},${win.height}`);
        detail = `window "${win.title}"`;
      }
      args.push(out);
      const r = await runArgv(cfg, { file: 'screencapture', args, timeoutMs });
      if (runFailed(r)) {
        const denied = /not authorized|permission/i.test(`${r.stderr}${r.stdout}`);
        throw new Error(
          denied
            ? 'macOS refused the capture: grant Screen Recording permission in ' +
              'System Settings → Privacy & Security → Screen Recording to the app running this server.'
            : describeRunFailure(r, 'screencapture'),
        );
      }
      tool = 'screencapture';
    } else {
      const installed = LINUX_CAPTURERS.map((c) => c.name).filter((n) => onPath(n));
      // A window or a display can always be done as a region, given geometry,
      // so fall back to that rather than refusing.
      //
      // `screen` is this tool's word for the whole desktop; `full` is what the
      // back ends call the same thing. Translate once, here, rather than
      // asking a capturer for a capability none of them has ever had.
      let effective = mode === 'screen' ? 'full' : mode;
      let rect = region;
      if (mode === 'window') {
        const win = await findWindow(cfg, windowSpec, timeoutMs);
        const direct = pickCapturer('window', { session, installed });
        if (direct.tool) {
          const r = await runArgv(cfg, {
            file: direct.tool.window(win.id, out)[0],
            args: direct.tool.window(win.id, out).slice(1),
            timeoutMs,
          });
          if (runFailed(r)) throw new Error(describeRunFailure(r, direct.tool.name));
          const buf = await readFile(out);
          await unlink(out).catch(() => {});
          return { buf, tool: direct.tool.name, mode, detail: `window "${win.title}" (${win.width}x${win.height})` };
        }
        effective = 'region';
        rect = { x: win.x, y: win.y, width: win.width, height: win.height };
        detail = `window "${win.title}"`;
      } else if (mode === 'display') {
        const displays = await listDisplays(cfg, { timeoutMs });
        const d = matchDisplay(displays, display);
        const byName = pickCapturer('display', { session, installed });
        if (byName.tool && d.name) {
          const argv = byName.tool.display(d.name, out);
          const r = await runArgv(cfg, { file: argv[0], args: argv.slice(1), timeoutMs });
          if (runFailed(r)) throw new Error(describeRunFailure(r, byName.tool.name));
          const buf = await readFile(out);
          await unlink(out).catch(() => {});
          return { buf, tool: byName.tool.name, mode, detail: `display ${d.name}` };
        }
        effective = 'region';
        rect = { x: d.x, y: d.y, width: d.width, height: d.height };
        detail = `display ${d.name ?? d.index}`;
      }

      const chosen = pickCapturer(effective, { session, installed });
      if (!chosen.tool) {
        throw new Error(
          `Cannot capture the ${mode === 'screen' ? 'screen' : mode} on this ${session} session: ${chosen.reason}.` +
          `${chosen.suggest.length ? `\nInstall one of:\n  ${chosen.suggest.join('\n  ')}` : ''}`,
        );
      }
      const argv = effective === 'region' ? chosen.tool.region(rect, out) : chosen.tool.full(out);
      const r = await runArgv(cfg, { file: argv[0], args: argv.slice(1), timeoutMs });
      if (runFailed(r)) throw new Error(describeRunFailure(r, chosen.tool.name));
      tool = chosen.tool.name;
    }

    if (!existsSync(written)) {
      throw new Error(
        `${tool} reported success but ${written} does not exist — the capture may have been cancelled, ` +
        'or the temp directory is not writable.',
      );
    }
    const buf = await readFile(written);
    return { buf, tool, mode, detail };
  } finally {
    await unlink(out).catch(() => {});
    if (written !== out) await unlink(written).catch(() => {});
  }
}

async function resolveDisplayIndex(cfg, display, timeoutMs) {
  if (display === null || display === undefined) return 1;
  if (typeof display === 'number' || /^\d+$/.test(String(display))) return Number(display);
  const displays = await listDisplays(cfg, { timeoutMs });
  return matchDisplay(displays, display).index;
}

function matchDisplay(displays, want) {
  if (want === null || want === undefined) {
    return displays.find((d) => d.primary) ?? displays[0];
  }
  if (typeof want === 'number' || /^\d+$/.test(String(want))) {
    const d = displays.find((x) => x.index === Number(want));
    if (!d) {
      throw new Error(`No display ${want}. There ${displays.length === 1 ? 'is 1' : `are ${displays.length}`}: ${displays.map((x) => `${x.index}=${x.name}`).join(', ')}`);
    }
    return d;
  }
  const needle = String(want).toLowerCase();
  const d = displays.find((x) => String(x.name).toLowerCase().includes(needle));
  if (!d) throw new Error(`No display matching "${want}". Available: ${displays.map((x) => x.name).join(', ')}`);
  return d;
}

/** Match a window by title substring, or by the id a previous list gave out. */
export async function findWindow(cfg, spec, timeoutMs = 15000) {
  if (!spec) throw new Error('Capturing a window needs "window": part of its title, or an id from action "windows"');
  const windows = await listWindows(cfg, { timeoutMs });
  if (!windows.length) throw new Error('No visible windows found');

  const exactId = windows.find((w) => w.id === String(spec));
  if (exactId) return exactId;

  const needle = String(spec).toLowerCase();
  const matches = windows.filter((w) => w.title.toLowerCase().includes(needle));
  if (!matches.length) {
    throw new Error(
      `No window title contains "${spec}". Open windows:\n` +
      windows.slice(0, 25).map((w) => `  ${w.title}`).join('\n'),
    );
  }
  // Prefer the largest match: title substrings hit tooltips and helper windows.
  return matches.sort((a, b) => b.width * b.height - a.width * a.height)[0];
}

// --------------------------------------------------------------------- probe

/**
 * Answer "can this machine be screenshotted, and if not why not" in one call.
 *
 * A capture failure is almost never about the capture. It is about the session
 * the server was started in, or a tool that is not installed — neither of which
 * is visible from the error, and both of which look identical from the outside:
 * listing displays and windows works, every shot fails. So report the facts
 * that decide it, then try the smallest real capture there is.
 */
export async function probe(cfg, { timeoutMs = 20000 } = {}) {
  const session = sessionType();
  const lines = [`platform: ${process.platform}`, `session type: ${session ?? 'none'}`];
  if (!session) {
    lines.push('', noDesktopMessage());
    return lines.join('\n');
  }
  lines.push(`temp dir for captures: ${shotTempDir()}`);

  if (session === 'windows') {
    lines.push(`powershell: ${powershell()}`);
    const fields = {};
    try {
      const out = await runWindows(cfg, ['-Mode', 'probe'], timeoutMs);
      for (const line of out.trim().split(/\r?\n/)) {
        const parts = line.split('\t');
        if (parts[0]) fields[parts[0]] = parts.slice(1);
      }
    } catch (err) {
      lines.push('', `the PowerShell probe itself failed: ${err.message}`);
      return lines.join('\n');
    }
    const one = (k) => (fields[k] ?? []).join(' ').trim();
    const station = one('station');
    lines.push(
      `powershell version: ${one('powershell')}`,
      `windows session id: ${one('winsession')}`,
      `window station: ${station || 'unknown'}` +
        (station === 'WinSta0'
          ? ' (interactive — capture is possible here)'
          : ' (NOT the interactive station: pixels cannot be read from here)'),
      `input desktop reachable: ${one('inputdesktop')}`,
      `displays: ${one('displays')}`,
      `virtual screen: ${one('virtualscreen')}`,
    );
    const cap = fields.copyfromscreen ?? [];
    if (cap[0] === 'ok') {
      lines.push('one-pixel test capture: ok');
    } else {
      lines.push(`one-pixel test capture: FAILED — ${cap.slice(1).join(': ') || 'no detail'}`);
      lines.push('', explainWindowsFailure({ stage: 'copyfromscreen', type: cap[1] ?? '', message: cap[2] ?? '' }));
      return lines.join('\n');
    }
  } else if (session === 'quartz') {
    lines.push(
      `screencapture: ${onPath('screencapture') ? 'present' : 'MISSING — it ships with macOS, so something is very wrong'}`,
    );
  } else {
    const installed = LINUX_CAPTURERS.filter((c) => onPath(c.name)).map((c) => c.name);
    lines.push(`capture tools installed: ${installed.join(', ') || 'none'}`);
    const chosen = pickCapturer('full', { session, installed });
    lines.push(chosen.tool ? `would use: ${chosen.tool.name}` : `cannot capture the screen: ${chosen.reason}`);
    if (!chosen.tool && chosen.suggest.length) lines.push(`install one of: ${chosen.suggest.join('  |  ')}`);
  }

  // The end-to-end test. It exercises more than the platform probe above: the
  // temp directory, the file the capturer writes, and the PNG coming back.
  try {
    const shot = await capture(cfg, {
      mode: 'region',
      region: { x: 0, y: 0, width: 8, height: 8 },
      timeoutMs,
    });
    lines.push(`8x8 end-to-end capture: ok — ${shot.buf.length} bytes via ${shot.tool}`);
    lines.push('', 'Screenshots work on this machine.');
  } catch (err) {
    lines.push('8x8 end-to-end capture: FAILED', '', err.message);
  }
  return lines.join('\n');
}
