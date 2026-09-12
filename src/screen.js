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
import { runArgv } from './exec.js';

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
  [string]$Out = '',
  [int]$X = 0, [int]$Y = 0, [int]$W = 0, [int]$H = 0,
  [int]$Display = 0,
  [string]$Title = '',
  [switch]$Activate
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
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
}
'@

# Without this, a scaled display is captured at the wrong size.
try { [TMcpWin]::SetProcessDPIAware() | Out-Null } catch { }

function Grab($x, $y, $w, $h, $out) {
  if ($w -lt 1 -or $h -lt 1) { throw "Capture area is empty ($w x $h)" }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output ("OK\`t" + $x + "\`t" + $y + "\`t" + $w + "\`t" + $h)
}

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
  'full' {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    Grab $b.X $b.Y $b.Width $b.Height $Out
  }
  'display' {
    $all = [System.Windows.Forms.Screen]::AllScreens
    if ($Display -lt 1 -or $Display -gt $all.Length) { throw "No display $Display; there are $($all.Length)" }
    $b = $all[$Display - 1].Bounds
    Grab $b.X $b.Y $b.Width $b.Height $Out
  }
  'region' { Grab $X $Y $W $H $Out }
  'window' {
    $h = [TMcpWin]::Find($Title)
    if ($h -eq [IntPtr]::Zero) { throw "No visible window whose title contains '$Title'" }
    if ($Activate) {
      [TMcpWin]::ShowWindow($h, 9) | Out-Null
      [TMcpWin]::SetForegroundWindow($h) | Out-Null
      Start-Sleep -Milliseconds 350
    }
    $r = [TMcpWin]::RectOf($h)
    Grab $r[0] $r[1] $r[2] $r[3] $Out
  }
  default { throw "Unknown mode '$Mode'" }
}
`;

let windowsScriptPath = null;

async function windowsScript() {
  if (windowsScriptPath && existsSync(windowsScriptPath)) return windowsScriptPath;
  const p = path.join(tmpdir(), `terminalmcp-screen-${process.pid}.ps1`);
  // The BOM makes PowerShell 5 read it as UTF-8 rather than the ANSI codepage.
  await writeFile(p, `﻿${WINDOWS_SCRIPT}`, 'utf8');
  windowsScriptPath = p;
  return p;
}

function powershell() {
  return onPath('pwsh') ? 'pwsh' : 'powershell';
}

async function runWindows(cfg, args, timeoutMs) {
  const script = await windowsScript();
  const r = await runArgv(cfg, {
    file: powershell(),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    timeoutMs,
  });
  if (r.code !== 0) {
    throw new Error(
      `Screen capture failed: ${(r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n').slice(0, 4).join(' ')}`,
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
    if (r.code !== 0) {
      const denied = /not allowed assistive|1743|accessibility/i.test(r.stderr || '');
      throw new Error(
        denied
          ? 'macOS refused the window list: this process needs Accessibility permission. ' +
            'System Settings → Privacy & Security → Accessibility, and add the app running this server ' +
            '(Terminal, iTerm, VS Code…). Region capture with x/y/width/height needs no permission.'
          : `Could not list windows: ${(r.stderr || r.stdout).trim().split('\n')[0]}`,
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
    return r.stdout
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

  const out = path.join(tmpdir(), `terminalmcp-shot-${process.pid}-${Date.now()}.png`);
  mkdirSync(path.dirname(out), { recursive: true });
  let tool = session;
  let detail = '';

  try {
    if (session === 'windows') {
      const args =
        mode === 'region'
          ? ['-Mode', 'region', '-X', String(region.x), '-Y', String(region.y), '-W', String(region.width), '-H', String(region.height)]
          : mode === 'display'
            ? ['-Mode', 'display', '-Display', String(await resolveDisplayIndex(cfg, display, timeoutMs))]
            : mode === 'window'
              ? ['-Mode', 'window', '-Title', String(windowSpec), ...(activate ? ['-Activate'] : [])]
              : ['-Mode', 'full'];
      const stdout = await runWindows(cfg, [...args, '-Out', out], timeoutMs);
      tool = `${powershell()} + System.Drawing`;
      const ok = stdout.trim().split(/\r?\n/).pop().split('\t');
      if (ok[0] === 'OK') detail = `${ok[3]}x${ok[4]} at ${ok[1]},${ok[2]}`;
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
      if (r.code !== 0) {
        const denied = /not authorized|permission/i.test(`${r.stderr}${r.stdout}`);
        throw new Error(
          denied
            ? 'macOS refused the capture: grant Screen Recording permission in ' +
              'System Settings → Privacy & Security → Screen Recording to the app running this server.'
            : `screencapture failed: ${(r.stderr || r.stdout || `exit ${r.code}`).trim()}`,
        );
      }
      tool = 'screencapture';
    } else {
      const installed = LINUX_CAPTURERS.map((c) => c.name).filter((n) => onPath(n));
      // A window or a display can always be done as a region, given geometry,
      // so fall back to that rather than refusing.
      let effective = mode;
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
          if (r.code !== 0) throw new Error(`${direct.tool.name} failed: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
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
          if (r.code !== 0) throw new Error(`${byName.tool.name} failed: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
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
      if (r.code !== 0) {
        throw new Error(`${chosen.tool.name} failed: ${(r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n')[0]}`);
      }
      tool = chosen.tool.name;
    }

    if (!existsSync(out)) {
      throw new Error(`${tool} reported success but wrote no file — it may have been cancelled`);
    }
    const buf = await readFile(out);
    return { buf, tool, mode, detail };
  } finally {
    await unlink(out).catch(() => {});
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
