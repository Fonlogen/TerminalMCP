// Mouse and keyboard input: driving a GUI that has no other way in.
//
// This is the other half of `screen`. A capture says what is on the screen; an
// installer with no silent flag, a launcher, a native dialog, a legacy admin
// panel — none of those can be driven by a command, so the loop is: capture,
// decide, click, capture again.
//
// Input is synthesised by the OS, which is worth being precise about, because
// "HID" means two different things:
//
//   * What this file does: SendInput on Windows, xdotool on X11, osascript or
//     cliclick on macOS. The OS injects the event; applications receive it
//     exactly like a real one. Nothing to plug in.
//   * What it cannot do: appear as a physical USB device. A game reading raw
//     input through an anti-cheat layer can refuse injected events, and no
//     amount of software makes an injected event physical. That needs a
//     microcontroller acting as a real HID device, and it is a different
//     backend, not a flag.
//
// The key table and the chord parser are pure and live at the top, because
// "which VK is F13" is exactly the kind of thing that is wrong once and then
// wrong for ever.

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { runArgv, runFailed, describeRunFailure } from './exec.js';
import {
  explainWindowsFailure,
  findWindow,
  findWindowsError,
  onPath,
  powershell,
  sessionType,
  shotTempDir,
} from './screen.js';

/**
 * Keys that have a name rather than a character.
 *
 *   vk       Windows virtual-key code
 *   keysym   X11 keysym, as xdotool spells it
 *   mac      macOS key code, for `osascript ... key code N`
 *   ext      Windows extended key: needs KEYEVENTF_EXTENDEDKEY, and gets the
 *            wrong scan code without it (the arrows and the navigation block
 *            share codes with the numeric keypad)
 */
export const KEYS = {
  enter:       { vk: 0x0d, keysym: 'Return',     mac: 36 },
  tab:         { vk: 0x09, keysym: 'Tab',        mac: 48 },
  space:       { vk: 0x20, keysym: 'space',      mac: 49 },
  backspace:   { vk: 0x08, keysym: 'BackSpace',  mac: 51 },
  escape:      { vk: 0x1b, keysym: 'Escape',     mac: 53 },
  delete:      { vk: 0x2e, keysym: 'Delete',     mac: 117, ext: true },
  insert:      { vk: 0x2d, keysym: 'Insert',     mac: null, ext: true },
  home:        { vk: 0x24, keysym: 'Home',       mac: 115, ext: true },
  end:         { vk: 0x23, keysym: 'End',        mac: 119, ext: true },
  pageup:      { vk: 0x21, keysym: 'Prior',      mac: 116, ext: true },
  pagedown:    { vk: 0x22, keysym: 'Next',       mac: 121, ext: true },
  up:          { vk: 0x26, keysym: 'Up',         mac: 126, ext: true },
  down:        { vk: 0x28, keysym: 'Down',       mac: 125, ext: true },
  left:        { vk: 0x25, keysym: 'Left',       mac: 123, ext: true },
  right:       { vk: 0x27, keysym: 'Right',      mac: 124, ext: true },
  printscreen: { vk: 0x2c, keysym: 'Print',      mac: null, ext: true },
  pause:       { vk: 0x13, keysym: 'Pause',      mac: null },
  capslock:    { vk: 0x14, keysym: 'Caps_Lock',  mac: 57 },
  numlock:     { vk: 0x90, keysym: 'Num_Lock',   mac: null, ext: true },
  scrolllock:  { vk: 0x91, keysym: 'Scroll_Lock', mac: null },
  menu:        { vk: 0x5d, keysym: 'Menu',       mac: null, ext: true },
  f1:  { vk: 0x70, keysym: 'F1',  mac: 122 },
  f2:  { vk: 0x71, keysym: 'F2',  mac: 120 },
  f3:  { vk: 0x72, keysym: 'F3',  mac: 99 },
  f4:  { vk: 0x73, keysym: 'F4',  mac: 118 },
  f5:  { vk: 0x74, keysym: 'F5',  mac: 96 },
  f6:  { vk: 0x75, keysym: 'F6',  mac: 97 },
  f7:  { vk: 0x76, keysym: 'F7',  mac: 98 },
  f8:  { vk: 0x77, keysym: 'F8',  mac: 100 },
  f9:  { vk: 0x78, keysym: 'F9',  mac: 101 },
  f10: { vk: 0x79, keysym: 'F10', mac: 109 },
  f11: { vk: 0x7a, keysym: 'F11', mac: 103 },
  f12: { vk: 0x7b, keysym: 'F12', mac: 111 },
  f13: { vk: 0x7c, keysym: 'F13', mac: 105 },
  f14: { vk: 0x7d, keysym: 'F14', mac: 107 },
  f15: { vk: 0x7e, keysym: 'F15', mac: 113 },
  f16: { vk: 0x7f, keysym: 'F16', mac: 106 },
  f17: { vk: 0x80, keysym: 'F17', mac: 64 },
  f18: { vk: 0x81, keysym: 'F18', mac: 79 },
  f19: { vk: 0x82, keysym: 'F19', mac: 80 },
  f20: { vk: 0x83, keysym: 'F20', mac: 90 },
  f21: { vk: 0x84, keysym: 'F21', mac: null },
  f22: { vk: 0x85, keysym: 'F22', mac: null },
  f23: { vk: 0x86, keysym: 'F23', mac: null },
  f24: { vk: 0x87, keysym: 'F24', mac: null },
};

/** Names people actually type, mapped to the canonical one. */
export const KEY_ALIASES = {
  return: 'enter', ret: 'enter', cr: 'enter', newline: 'enter',
  esc: 'escape',
  del: 'delete', forwarddelete: 'delete',
  bs: 'backspace', back: 'backspace',
  ins: 'insert',
  pgup: 'pageup', pageu: 'pageup', prior: 'pageup',
  pgdn: 'pagedown', pgdown: 'pagedown', next: 'pagedown',
  arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
  spacebar: 'space', ' ': 'space',
  prtsc: 'printscreen', printscr: 'printscreen',
  caps: 'capslock', apps: 'menu', contextmenu: 'menu',
};

/**
 * Modifiers, and every name a caller might reach for.
 *
 * `win` is the canonical name for the key between ctrl and alt, whatever the
 * platform paints on it: Windows logo, Command, Super. A chord written
 * `cmd+c` on a Mac and `ctrl+c` on Windows is the caller's business, not this
 * table's — it does not silently translate one into the other.
 */
export const MODIFIERS = {
  ctrl:    { vk: 0x11, keysym: 'ctrl',  mac: 'control' },
  shift:   { vk: 0x10, keysym: 'shift', mac: 'shift' },
  alt:     { vk: 0x12, keysym: 'alt',   mac: 'option' },
  win:     { vk: 0x5b, keysym: 'super', mac: 'command', ext: true },
};

export const MODIFIER_ALIASES = {
  control: 'ctrl', ctl: 'ctrl',
  option: 'alt', opt: 'alt', meta: 'alt',
  cmd: 'win', command: 'win', super: 'win', windows: 'win', os: 'win',
};

function canonicalKey(name) {
  const k = String(name).toLowerCase();
  return KEY_ALIASES[k] ?? k;
}

function canonicalModifier(name) {
  const m = String(name).toLowerCase();
  return MODIFIER_ALIASES[m] ?? m;
}

/** Names close enough to what was asked for to be worth suggesting. */
function nearestKeys(want) {
  const all = [...Object.keys(KEYS), ...Object.keys(KEY_ALIASES)];
  const w = String(want).toLowerCase();
  const near = all.filter((n) => n.startsWith(w.slice(0, 2)) || n.includes(w) || w.includes(n));
  return [...new Set(near)].slice(0, 6);
}

/**
 * Parse one chord: "ctrl+shift+p", "F5", "enter", "a", "+".
 *
 * Returns { mods, key, vk, keysym, mac, ext, char } where `char` is set when
 * the key is a plain character rather than a named key — those cannot be given
 * a virtual-key code here, because which key produces "+" depends on the
 * keyboard layout, and only the machine holding the keyboard knows that.
 */
export function parseChord(spec) {
  const raw = String(spec ?? '').trim();
  if (!raw) throw new Error('a key chord cannot be empty — try "enter", "ctrl+s" or "F5"');

  // Split on + but keep a trailing "+" as the key itself: "ctrl++" is ctrl
  // and the plus key, and "+" alone is just the plus key.
  const parts = [];
  let buf = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '+' && buf !== '') { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf !== '') parts.push(buf);
  if (!parts.length) parts.push('+');

  const keyPart = parts.pop();
  const mods = [];
  for (const p of parts) {
    const m = canonicalModifier(p);
    if (!MODIFIERS[m]) {
      throw new Error(
        `"${p}" is not a modifier in "${raw}". Modifiers: ${Object.keys(MODIFIERS).join(', ')} ` +
        `(aliases: ${Object.keys(MODIFIER_ALIASES).join(', ')}).`,
      );
    }
    if (!mods.includes(m)) mods.push(m);
  }

  const name = canonicalKey(keyPart);
  if (KEYS[name]) {
    const k = KEYS[name];
    return { mods, key: name, vk: k.vk, keysym: k.keysym, mac: k.mac, ext: Boolean(k.ext), char: null };
  }
  // A modifier on its own is a legitimate thing to press and hold.
  if (MODIFIERS[canonicalModifier(keyPart)] && !mods.length) {
    const m = canonicalModifier(keyPart);
    const k = MODIFIERS[m];
    return { mods: [], key: m, vk: k.vk, keysym: k.keysym, mac: null, ext: Boolean(k.ext), char: null };
  }
  if ([...keyPart].length === 1) {
    return { mods, key: keyPart, vk: null, keysym: keyPart, mac: null, ext: false, char: keyPart };
  }
  const near = nearestKeys(keyPart).filter((n) => n.length > 1);
  throw new Error(
    `"${keyPart}" is not a key this understands (in "${raw}"). ` +
    `${near.length ? `Did you mean ${near.join(', ')}? ` : ''}` +
    'Named keys are enter, tab, space, backspace, escape, delete, insert, home, end, ' +
    'pageup, pagedown, up, down, left, right, f1-f24 and the lock keys; anything else ' +
    'must be a single character. To send words, use action "type" instead.',
  );
}

/** Parse a sequence: "ctrl+a ctrl+c" is two chords, pressed in order. */
export function parseChords(spec) {
  const items = String(spec ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!items.length) throw new Error('no keys given — try keys: "ctrl+s" or keys: "alt+f x"');
  return items.map(parseChord);
}

/** Canonical spelling, for echoing back what was actually pressed. */
export function describeChord(chord) {
  return [...chord.mods, chord.key].join('+');
}

export const BUTTONS = { left: 1, middle: 2, right: 3 };

function buttonNumber(name) {
  const b = String(name ?? 'left').toLowerCase();
  if (!BUTTONS[b]) throw new Error(`Unknown mouse button "${name}". Use left, middle or right.`);
  return BUTTONS[b];
}

/**
 * X11 spells punctuation with keysym names, not the character itself.
 * `xdotool key ctrl++` is a parse error; `xdotool key ctrl+plus` is not.
 */
export const X11_KEYSYMS = {
  ' ': 'space', '+': 'plus', '-': 'minus', '=': 'equal', '.': 'period', ',': 'comma',
  '/': 'slash', '\\': 'backslash', ';': 'semicolon', "'": 'apostrophe', '`': 'grave',
  '[': 'bracketleft', ']': 'bracketright', '<': 'less', '>': 'greater', '?': 'question',
  '!': 'exclam', '@': 'at', '#': 'numbersign', '$': 'dollar', '%': 'percent',
  '^': 'asciicircum', '&': 'ampersand', '*': 'asterisk', '(': 'parenleft',
  ')': 'parenright', '_': 'underscore', '{': 'braceleft', '}': 'braceright',
  '|': 'bar', ':': 'colon', '"': 'quotedbl', '~': 'asciitilde',
};

/** One chord, spelled the way xdotool wants it. */
export function xdotoolChord(chord) {
  const key = chord.char ? (X11_KEYSYMS[chord.char] ?? chord.char) : chord.keysym;
  return [...chord.mods.map((m) => MODIFIERS[m].keysym), key].join('+');
}

/** One chord, spelled for AppleScript's System Events. */
export function appleScriptChord(chord) {
  const using = chord.mods.map((m) => `${MODIFIERS[m].mac} down`);
  const suffix = using.length ? ` using {${using.join(', ')}}` : '';
  if (chord.char) return `keystroke ${quoteAppleScript(chord.char)}${suffix}`;
  if (chord.mac === null || chord.mac === undefined) {
    throw new Error(`macOS has no key code for "${chord.key}" in this table, so it cannot be pressed here.`);
  }
  return `key code ${chord.mac}${suffix}`;
}

function quoteAppleScript(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// ------------------------------------------------------------------- Windows

/**
 * SendInput, wrapped in just enough PowerShell to be callable.
 *
 * SendInput rather than the older mouse_event/keybd_event: it is the API that
 * still works for applications which read input through raw input or a low
 * level hook, and it delivers a batch atomically, so a modifier cannot be
 * observed as stuck between two calls.
 *
 * Keys carry both a virtual-key code and the scan code MapVirtualKey gives for
 * it. Plenty of software — anything reading DirectInput, which includes most
 * games — looks at the scan code and ignores the virtual key, so sending only
 * the latter produces a keystroke that the OS agrees happened and the
 * application never notices.
 */
export const WINDOWS_INPUT_SCRIPT = `param(
  [string]$Mode = 'probe',
  [int]$X = -2147483648, [int]$Y = -2147483648,
  [int]$DeltaX = 0, [int]$DeltaY = 0,
  [int]$ToX = -2147483648, [int]$ToY = -2147483648,
  [int]$Button = 1,
  [int]$Count = 1,
  [int]$Amount = 0,
  [int]$Horizontal = 0,
  [string]$Text = '',
  [string]$Chords = '[]',
  [int]$HoldMs = 0,
  [int]$IntervalMs = 0,
  [int]$Steps = 12,
  [string]$Title = ''
)
$ErrorActionPreference = 'Stop'

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
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class TMcpInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  public struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public UNION u; }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern short VkKeyScan(char ch);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);

  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint MOVE = 0x0001, ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000, WHEEL = 0x0800, HWHEEL = 0x1000;
  const uint KEYUP = 0x0002, UNICODE = 0x0004, EXTENDED = 0x0001;

  static void Send(INPUT[] inputs) {
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != inputs.Length) {
      int err = Marshal.GetLastWin32Error();
      throw new System.ComponentModel.Win32Exception(err,
        "SendInput delivered " + sent + " of " + inputs.Length + " events (error " + err + ")");
    }
  }

  // Absolute coordinates are normalised over the whole virtual desktop, so a
  // second monitor to the left (negative X) works without special cases.
  static INPUT MouseAt(int x, int y, uint extraFlags, uint data) {
    int left = GetSystemMetrics(76), top = GetSystemMetrics(77);
    int width = GetSystemMetrics(78), height = GetSystemMetrics(79);
    if (width < 2) width = 2;
    if (height < 2) height = 2;
    var i = new INPUT();
    i.type = INPUT_MOUSE;
    i.u.mi.dx = (int)(((long)(x - left) * 65535) / (width - 1));
    i.u.mi.dy = (int)(((long)(y - top) * 65535) / (height - 1));
    i.u.mi.mouseData = data;
    i.u.mi.dwFlags = MOVE | ABSOLUTE | VIRTUALDESK | extraFlags;
    return i;
  }

  static INPUT MouseFlag(uint flags, uint data) {
    var i = new INPUT();
    i.type = INPUT_MOUSE;
    i.u.mi.dwFlags = flags;
    i.u.mi.mouseData = data;
    return i;
  }

  public static POINT Where() { POINT p; GetCursorPos(out p); return p; }

  public static void MoveTo(int x, int y) { Send(new INPUT[] { MouseAt(x, y, 0, 0) }); }

  static uint DownFlag(int button) { return button == 3 ? 0x0008u : button == 2 ? 0x0020u : 0x0002u; }
  static uint UpFlag(int button)   { return button == 3 ? 0x0010u : button == 2 ? 0x0040u : 0x0004u; }

  public static void Click(int button, int count) {
    for (int n = 0; n < count; n++) {
      Send(new INPUT[] { MouseFlag(DownFlag(button), 0), MouseFlag(UpFlag(button), 0) });
    }
  }

  public static void Down(int button) { Send(new INPUT[] { MouseFlag(DownFlag(button), 0) }); }
  public static void Up(int button) { Send(new INPUT[] { MouseFlag(UpFlag(button), 0) }); }

  public static void Wheel(int amount, bool horizontal) {
    Send(new INPUT[] { MouseFlag(horizontal ? HWHEEL : WHEEL, unchecked((uint)(amount * 120))) });
  }

  static INPUT Key(ushort vk, ushort scan, bool up, bool extended, bool unicode) {
    var i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.u.ki.wVk = unicode ? (ushort)0 : vk;
    i.u.ki.wScan = scan;
    uint flags = 0;
    if (up) flags |= KEYUP;
    if (unicode) flags |= UNICODE;
    if (extended) flags |= EXTENDED;
    i.u.ki.dwFlags = flags;
    return i;
  }

  public static void KeyStroke(int vk, bool extended, bool up) {
    ushort scan = (ushort)MapVirtualKey((uint)vk, 0);
    Send(new INPUT[] { Key((ushort)vk, scan, up, extended, false) });
  }

  /** The VK and shift state a character needs on the CURRENT layout. */
  public static int[] ForChar(char ch) {
    short r = VkKeyScan(ch);
    if (r == -1) return new int[] { -1, 0 };
    return new int[] { r & 0xff, (r >> 8) & 0xff };
  }

  /** Type text as raw UTF-16: no layout, no dead keys, no lost accents. */
  public static void TypeUnicode(string text, int intervalMs) {
    foreach (char ch in text) {
      if (ch == '\\n' || ch == '\\r') {
        KeyStroke(0x0D, false, false);
        KeyStroke(0x0D, false, true);
      } else {
        Send(new INPUT[] { Key(0, (ushort)ch, false, false, true), Key(0, (ushort)ch, true, false, true) });
      }
      if (intervalMs > 0) System.Threading.Thread.Sleep(intervalMs);
    }
  }

  /** The first visible window whose title contains the needle. */
  public static IntPtr Find(string want) {
    IntPtr found = IntPtr.Zero;
    string needle = want.ToLowerInvariant();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (found != IntPtr.Zero || !IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len == 0) return true;
      var sb = new System.Text.StringBuilder(len + 2);
      GetWindowText(h, sb, sb.Capacity);
      if (sb.ToString().ToLowerInvariant().Contains(needle)) found = h;
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static bool Raise(IntPtr h) {
    ShowWindow(h, 9);
    return SetForegroundWindow(h);
  }

  public static string Foreground() {
    var sb = new System.Text.StringBuilder(512);
    GetWindowText(GetForegroundWindow(), sb, 512);
    return sb.ToString();
  }
}
'@
} catch { Fail 'compile' $_ }

try { [TMcpInput]::SetProcessDPIAware() | Out-Null } catch { }

function PressChord($chord, $holdMs) {
  $downs = @()
  foreach ($m in $chord.mods) { $downs += [int]$m }
  $vk = -1
  $shifted = $false
  if ($chord.PSObject.Properties.Name -contains 'vk' -and $chord.vk -ne $null) {
    $vk = [int]$chord.vk
  } else {
    $r = [TMcpInput]::ForChar([char]$chord.char)
    $vk = $r[0]
    if ($vk -lt 0) { Fail 'layout' ("the current keyboard layout cannot produce '" + $chord.char + "' with a single key — send it with action type instead") }
    if (($r[1] -band 1) -ne 0) { $shifted = $true }
    if (($r[1] -band 2) -ne 0) { $downs += 17 }
    if (($r[1] -band 4) -ne 0) { $downs += 18 }
  }
  if ($shifted -and ($downs -notcontains 16)) { $downs += 16 }

  foreach ($m in $downs) { [TMcpInput]::KeyStroke($m, $false, $false) }
  [TMcpInput]::KeyStroke($vk, [bool]$chord.ext, $false)
  if ($holdMs -gt 0) { Start-Sleep -Milliseconds $holdMs }
  [TMcpInput]::KeyStroke($vk, [bool]$chord.ext, $true)
  [array]::Reverse($downs)
  foreach ($m in $downs) { [TMcpInput]::KeyStroke($m, $false, $true) }
}

try {
  switch ($Mode) {
    'position' {
      $p = [TMcpInput]::Where()
      Write-Output ("OK\`t" + $p.X + "\`t" + $p.Y)
    }
    'move' {
      if ($X -eq -2147483648) {
        $p = [TMcpInput]::Where()
        [TMcpInput]::MoveTo($p.X + $DeltaX, $p.Y + $DeltaY)
      } else {
        [TMcpInput]::MoveTo($X, $Y)
      }
      $p = [TMcpInput]::Where()
      Write-Output ("OK\`t" + $p.X + "\`t" + $p.Y)
    }
    'click' {
      if ($X -ne -2147483648) { [TMcpInput]::MoveTo($X, $Y); Start-Sleep -Milliseconds 20 }
      [TMcpInput]::Click($Button, $Count)
      $p = [TMcpInput]::Where()
      Write-Output ("OK\`t" + $p.X + "\`t" + $p.Y)
    }
    'drag' {
      if ($X -ne -2147483648) { [TMcpInput]::MoveTo($X, $Y); Start-Sleep -Milliseconds 30 }
      $from = [TMcpInput]::Where()
      [TMcpInput]::Down($Button)
      Start-Sleep -Milliseconds 40
      # Intermediate moves on purpose: a drag that teleports is ignored by
      # anything that starts dragging on the first motion event.
      if ($Steps -lt 1) { $Steps = 1 }
      for ($i = 1; $i -le $Steps; $i++) {
        $nx = [int]($from.X + (($ToX - $from.X) * $i / $Steps))
        $ny = [int]($from.Y + (($ToY - $from.Y) * $i / $Steps))
        [TMcpInput]::MoveTo($nx, $ny)
        Start-Sleep -Milliseconds 12
      }
      Start-Sleep -Milliseconds 40
      [TMcpInput]::Up($Button)
      $p = [TMcpInput]::Where()
      Write-Output ("OK\`t" + $p.X + "\`t" + $p.Y)
    }
    'scroll' {
      if ($X -ne -2147483648) { [TMcpInput]::MoveTo($X, $Y); Start-Sleep -Milliseconds 20 }
      [TMcpInput]::Wheel($Amount, ($Horizontal -ne 0))
      $p = [TMcpInput]::Where()
      Write-Output ("OK\`t" + $p.X + "\`t" + $p.Y)
    }
    'type' {
      [TMcpInput]::TypeUnicode($Text, $IntervalMs)
      Write-Output ("OK\`t" + $Text.Length)
    }
    'keys' {
      $list = @()
      try { $list = @(ConvertFrom-Json $Chords) } catch { Fail 'args' $_ }
      foreach ($c in $list) {
        PressChord $c $HoldMs
        if ($IntervalMs -gt 0) { Start-Sleep -Milliseconds $IntervalMs }
      }
      Write-Output ("OK\`t" + $list.Count)
    }
    'focus' {
      $h = [TMcpInput]::Find($Title)
      if ($h -eq [IntPtr]::Zero) { Fail 'window' "no visible window has '$Title' in its title" }
      [TMcpInput]::Raise($h) | Out-Null
      Start-Sleep -Milliseconds 250
      Write-Output ("OK\`t" + [TMcpInput]::Foreground())
    }
    'probe' {
      $p = [TMcpInput]::Where()
      Write-Output ("pointer\`t" + $p.X + "\`t" + $p.Y)
      Write-Output ("foreground\`t" + [TMcpInput]::Foreground())
      Write-Output ("virtualscreen\`t" + [TMcpInput]::GetSystemMetrics(78) + "x" + [TMcpInput]::GetSystemMetrics(79))
      # Move the pointer one pixel and back: the smallest injected event there
      # is, and the only way to know SendInput is allowed at all.
      try {
        [TMcpInput]::MoveTo($p.X + 1, $p.Y)
        Start-Sleep -Milliseconds 30
        $after = [TMcpInput]::Where()
        [TMcpInput]::MoveTo($p.X, $p.Y)
        Write-Output ("sendinput\`t" + $(if ($after.X -ne $p.X) { "ok" } else { "accepted but the pointer did not move" }))
      } catch {
        Write-Output ("sendinput\`tfailed\`t" + $_.Exception.GetType().FullName + "\`t" + $_.Exception.Message)
      }
    }
    default { Fail 'args' "unknown mode '$Mode'" }
  }
} catch { Fail 'unexpected' $_ }
`;

// ------------------------------------------------------------------ backends

let scriptPath = null;

async function windowsScript() {
  if (scriptPath && existsSync(scriptPath)) return scriptPath;
  const p = path.join(shotTempDir(), `terminalmcp-input-${process.pid}.ps1`);
  // The BOM makes PowerShell 5 read it as UTF-8 rather than the ANSI codepage.
  await writeFile(p, `﻿${WINDOWS_INPUT_SCRIPT}`, 'utf8');
  scriptPath = p;
  return p;
}

async function runWindowsInput(cfg, args, timeoutMs = 20000) {
  const script = await windowsScript();
  const r = await runArgv(cfg, {
    file: powershell(),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    timeoutMs,
  });
  const reported = findWindowsError(r.stdout);
  if (reported) throw new Error(explainWindowsFailure(reported, { what: 'Input' }));
  if (runFailed(r)) throw new Error(describeRunFailure(r, 'PowerShell'));
  return r.stdout;
}

/**
 * A UTF-8 locale for xdotool.
 *
 * `xdotool type` decodes its argument using the current locale, so under the C
 * locale — which is what a service or a bare shell inherits — anything but
 * ASCII fails with "Invalid multi-byte sequence encountered" and nothing is
 * typed at all. An accented character is not an edge case in Italian.
 */
function utf8Env() {
  const current = `${process.env.LC_ALL ?? ''}${process.env.LC_CTYPE ?? ''}${process.env.LANG ?? ''}`;
  return /utf-?8/i.test(current) ? {} : { LC_ALL: 'C.UTF-8' };
}

async function xdotool(cfg, args, timeoutMs = 20000, env = {}) {
  if (!onPath('xdotool')) {
    throw new Error(
      'Input on X11 needs xdotool, which is not installed (apt install xdotool). ' +
      'It is the same kind of dependency as the screenshot back ends: a small program ' +
      'that already knows how to talk to X.',
    );
  }
  const r = await runArgv(cfg, { file: 'xdotool', args, timeoutMs, env });
  if (runFailed(r)) throw new Error(describeRunFailure(r, 'xdotool'));
  return r.stdout;
}

/**
 * Pointer events on macOS, posted through CoreGraphics.
 *
 * The obvious route — `tell application "System Events" to click at {x, y}` —
 * does not work. It is an accessibility command that asks the *application* to
 * perform a click, and when the point does not resolve to a UI element it can
 * simply never answer: the Apple event sits there until something kills it, no
 * error, no TCC prompt, nothing on stderr. Accessibility being granted makes no
 * difference, which is what makes it so confusing to diagnose.
 *
 * CGEventPost is what a click actually is: an event posted to the HID event
 * tap, the same path a real mouse takes. No Apple events, nothing to wait for.
 * JavaScript for Automation reaches it through the Objective-C bridge, so this
 * needs nothing installed — `osascript -l JavaScript` ships with macOS.
 */
export function jxaPointerScript(op) {
  // The payload is numbers and a button name — no free text reaches this
  // script, so JSON is a safe JavaScript literal to paste into it.
  const json = JSON.stringify(op);
  return `let out;
try {
  ObjC.import('CoreGraphics');
  ObjC.import('Foundation');
  const o = ${json};
  const P = (x, y) => ({ x: x, y: y });
  const K = {
    left:   { down: $.kCGEventLeftMouseDown,  up: $.kCGEventLeftMouseUp,  drag: $.kCGEventLeftMouseDragged,  b: $.kCGMouseButtonLeft },
    right:  { down: $.kCGEventRightMouseDown, up: $.kCGEventRightMouseUp, drag: $.kCGEventRightMouseDragged, b: $.kCGMouseButtonRight },
    middle: { down: $.kCGEventOtherMouseDown, up: $.kCGEventOtherMouseUp, drag: $.kCGEventOtherMouseDragged, b: $.kCGMouseButtonCenter },
  };
  const sleep = (ms) => $.NSThread.sleepForTimeInterval(ms / 1000);
  const where = () => {
    const p = $.CGEventGetLocation($.CGEventCreate($()));
    return { x: Math.round(p.x), y: Math.round(p.y) };
  };
  const post = (type, x, y, button, clicks) => {
    const e = $.CGEventCreateMouseEvent($(), type, P(x, y), button);
    if (clicks) $.CGEventSetIntegerValueField(e, $.kCGMouseEventClickState, clicks);
    $.CGEventPost($.kCGHIDEventTap, e);
  };

  if (o.op === 'position') {
    out = { ok: true, at: where() };
  } else if (o.op === 'move') {
    const to = o.absolute ? P(o.x, o.y) : (() => { const c = where(); return P(c.x + o.dx, c.y + o.dy); })();
    post($.kCGEventMouseMoved, to.x, to.y, $.kCGMouseButtonLeft, 0);
    sleep(20);
    out = { ok: true, at: { x: Math.round(to.x), y: Math.round(to.y) } };
  } else if (o.op === 'click') {
    const B = K[o.button] || K.left;
    const at = o.absolute ? P(o.x, o.y) : where();
    if (o.absolute) { post($.kCGEventMouseMoved, at.x, at.y, B.b, 0); sleep(30); }
    for (let i = 1; i <= o.count; i++) {
      post(B.down, at.x, at.y, B.b, i);
      sleep(20);
      post(B.up, at.x, at.y, B.b, i);
      if (i < o.count) sleep(60);
    }
    out = { ok: true, at: { x: Math.round(at.x), y: Math.round(at.y) } };
  } else if (o.op === 'drag') {
    const B = K[o.button] || K.left;
    const from = o.absolute ? P(o.x, o.y) : where();
    post($.kCGEventMouseMoved, from.x, from.y, B.b, 0);
    sleep(40);
    post(B.down, from.x, from.y, B.b, 1);
    sleep(60);
    // Intermediate moves on purpose: a drag that teleports is ignored by
    // anything that starts dragging on the first motion event.
    for (let i = 1; i <= o.steps; i++) {
      const nx = from.x + ((o.toX - from.x) * i) / o.steps;
      const ny = from.y + ((o.toY - from.y) * i) / o.steps;
      post(B.drag, nx, ny, B.b, 1);
      sleep(12);
    }
    sleep(40);
    post(B.up, o.toX, o.toY, B.b, 1);
    out = { ok: true, at: { x: Math.round(o.toX), y: Math.round(o.toY) } };
  } else if (o.op === 'scroll') {
    if (o.absolute) { post($.kCGEventMouseMoved, o.x, o.y, $.kCGMouseButtonLeft, 0); sleep(20); }
    const e = o.horizontal
      ? $.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, 2, 0, -o.amount)
      : $.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, 1, -o.amount);
    $.CGEventPost($.kCGHIDEventTap, e);
    out = { ok: true };
  } else {
    out = { ok: false, error: 'unknown pointer op ' + o.op };
  }
} catch (e) {
  out = { ok: false, error: String((e && e.message) || e) };
}
JSON.stringify(out);`;
}

/** Run one of those, and turn whatever comes back into an answer or a reason. */
async function jxaPointer(cfg, op, timeoutMs = 15000) {
  const r = await runArgv(cfg, {
    file: 'osascript',
    args: ['-l', 'JavaScript', '-e', jxaPointerScript(op)],
    timeoutMs,
  });
  if (runFailed(r)) {
    throw new Error(
      `${describeRunFailure(r, 'osascript (JavaScript)')}\n` +
      'This posts the event through CoreGraphics rather than asking an application to ' +
      'click for itself. If it is refused, the process running this server needs ' +
      'Accessibility permission: System Settings -> Privacy & Security -> Accessibility, ' +
      'and the app to add is the one that launched the server (Terminal, iTerm, the Claude ' +
      'app), not node. Installing cliclick (brew install cliclick) is the other way through.',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout.trim());
  } catch {
    throw new Error(`osascript answered something unexpected: ${r.stdout.trim().slice(0, 200)}`);
  }
  if (!parsed.ok) {
    throw new Error(
      `CoreGraphics refused the event: ${parsed.error}\n` +
      'Install cliclick (brew install cliclick) and this tool will use it instead.',
    );
  }
  return parsed;
}

async function osascript(cfg, script, timeoutMs = 20000) {
  // An Apple event waits two minutes for a reply by default, so a System
  // Events call that never answers looks exactly like a hang. Give it a
  // deadline of its own, inside the script, so it comes back as an error.
  const seconds = Math.max(2, Math.round((timeoutMs - 2000) / 1000));
  const guarded = `with timeout of ${seconds} seconds\n${script}\nend timeout`;
  const r = await runArgv(cfg, { file: 'osascript', args: ['-e', guarded], timeoutMs });
  if (runFailed(r)) {
    const both = `${r.stderr}${r.stdout}`;
    const denied = /not allowed|assistive|1743|accessibility/i.test(both);
    const timedOut = r.timedOut || /timed out|-1712/.test(both);
    throw new Error(
      denied
        ? 'macOS refused the input: this process needs Accessibility permission. ' +
          'System Settings -> Privacy & Security -> Accessibility, and add the app that ' +
          'launched this server (Terminal, iTerm, the Claude app) — not node itself. ' +
          'Nothing can be clicked or typed until then.'
        : timedOut
          ? `${describeRunFailure(r, 'osascript')}\n` +
            'System Events accepted the command and never answered. That is not usually a ' +
            'permission problem — a refusal is immediate and says so. Check with: ' +
            `osascript -e 'tell application "System Events" to return UI elements enabled'`
          : describeRunFailure(r, 'osascript'),
    );
  }
  return r.stdout;
}

/** ydotool and wtype are the only way in on Wayland, and both are optional. */
function waylandTool(kind) {
  const name = kind === 'keyboard' ? 'wtype' : 'ydotool';
  if (onPath(name)) return name;
  throw new Error(
    `Wayland does not let an application inject input, by design, so this needs ${name}, ` +
    `which is not installed.\\n` +
    `${kind === 'keyboard'
      ? 'apt install wtype — it speaks keysyms, so key chords work as written.'
      : 'apt install ydotool — it also needs its daemon running and access to /dev/uinput.'}\\n` +
    'An X11 session needs only xdotool and has none of these caveats.',
  );
}

function requireSession() {
  const session = sessionType();
  if (!session) {
    throw new Error(
      'No graphical session: DISPLAY and WAYLAND_DISPLAY are both unset, so there is no ' +
      'pointer to move and no window to type into. This is normal on a server, in a ' +
      'container and over plain SSH. To drive a web page here, use the browser tool — ' +
      'it clicks and types through the page itself and needs no desktop.',
    );
  }
  return session;
}

function parseOk(stdout) {
  const last = String(stdout).trim().split(/\r?\n/).pop() ?? '';
  const parts = last.split('\t');
  return parts[0] === 'OK' ? parts.slice(1) : null;
}

// ------------------------------------------------------------------- pointer

/** Where the pointer is now. */
export async function pointerPosition(cfg, { timeoutMs = 10000 } = {}) {
  const session = requireSession();

  if (session === 'windows') {
    const ok = parseOk(await runWindowsInput(cfg, ['-Mode', 'position'], timeoutMs));
    if (!ok) throw new Error('PowerShell did not report the pointer position');
    return { x: Number(ok[0]), y: Number(ok[1]) };
  }
  if (session === 'x11') {
    const out = await xdotool(cfg, ['getmouselocation', '--shell'], timeoutMs);
    const f = Object.fromEntries(out.trim().split(/\r?\n/).map((l) => l.split('=')));
    return { x: Number(f.X), y: Number(f.Y) };
  }
  if (session === 'quartz') {
    if (onPath('cliclick')) {
      const r = await runArgv(cfg, { file: 'cliclick', args: ['p'], timeoutMs });
      if (runFailed(r)) throw new Error(describeRunFailure(r, 'cliclick'));
      const [x, y] = r.stdout.trim().split(/[,\s]+/);
      return { x: Number(x), y: Number(y) };
    }
    return (await jxaPointer(cfg, { op: 'position' }, timeoutMs)).at;
  }
  throw new Error(
    'Wayland does not tell an application where the pointer is, by design, and no helper ' +
    'changes that. Move it to a known position instead of asking where it is, or run the ' +
    'session on X11.',
  );
}

/** Move the pointer, either to a point or by an offset. */
export async function movePointer(cfg, { x = null, y = null, dx = 0, dy = 0, timeoutMs = 10000 } = {}) {
  const session = requireSession();
  const absolute = x !== null && y !== null;

  if (session === 'windows') {
    const args = absolute
      ? ['-Mode', 'move', '-X', String(Math.round(x)), '-Y', String(Math.round(y))]
      : ['-Mode', 'move', '-DeltaX', String(Math.round(dx)), '-DeltaY', String(Math.round(dy))];
    const ok = parseOk(await runWindowsInput(cfg, args, timeoutMs));
    return { x: Number(ok?.[0]), y: Number(ok?.[1]) };
  }
  if (session === 'x11') {
    // Work out the destination before moving, and report that rather than
    // asking afterwards: --sync means X has acknowledged the motion, while the
    // pointer *query* is not always in step with it (Xvfb keeps answering with
    // the old position), and a tool that reports a position it did not move to
    // is worse than one that reports nothing.
    const before = absolute ? null : await pointerPosition(cfg, { timeoutMs }).catch(() => null);
    const target = absolute
      ? { x: Math.round(x), y: Math.round(y) }
      : before
        ? { x: before.x + Math.round(dx), y: before.y + Math.round(dy) }
        : null;
    await xdotool(
      cfg,
      absolute
        ? ['mousemove', '--sync', String(Math.round(x)), String(Math.round(y))]
        : ['mousemove_relative', '--sync', '--', String(Math.round(dx)), String(Math.round(dy))],
      timeoutMs,
    );
    return target ?? { x: null, y: null };
  }
  if (session === 'quartz') {
    if (onPath('cliclick')) {
      const arg = absolute ? `m:${Math.round(x)},${Math.round(y)}` : `m:+${Math.round(dx)},+${Math.round(dy)}`;
      const r = await runArgv(cfg, { file: 'cliclick', args: [arg], timeoutMs });
      if (runFailed(r)) throw new Error(describeRunFailure(r, 'cliclick'));
      return absolute ? { x: Math.round(x), y: Math.round(y) } : pointerPosition(cfg, { timeoutMs });
    }
    const moved = await jxaPointer(
      cfg,
      { op: 'move', absolute, x: Math.round(x ?? 0), y: Math.round(y ?? 0), dx: Math.round(dx), dy: Math.round(dy) },
      timeoutMs,
    );
    return moved.at;
  }
  const tool = waylandTool('pointer');
  const args = absolute
    ? ['mousemove', '--absolute', '--', String(Math.round(x)), String(Math.round(y))]
    : ['mousemove', '--', String(Math.round(dx)), String(Math.round(dy))];
  const r = await runArgv(cfg, { file: tool, args, timeoutMs });
  if (runFailed(r)) throw new Error(describeRunFailure(r, tool));
  return absolute ? { x: Math.round(x), y: Math.round(y) } : { x: null, y: null };
}

/** Click, optionally moving there first. */
export async function clickPointer(cfg, { x = null, y = null, button = 'left', count = 1, timeoutMs = 15000 } = {}) {
  const b = buttonNumber(button);
  const session = requireSession();
  const at = x !== null && y !== null;
  const times = Math.max(1, Math.min(10, Math.round(count)));

  if (session === 'windows') {
    const args = ['-Mode', 'click', '-Button', String(b), '-Count', String(times)];
    if (at) args.push('-X', String(Math.round(x)), '-Y', String(Math.round(y)));
    const ok = parseOk(await runWindowsInput(cfg, args, timeoutMs));
    return { x: Number(ok?.[0]), y: Number(ok?.[1]), button, count: times };
  }
  if (session === 'x11') {
    const args = [];
    if (at) args.push('mousemove', '--sync', String(Math.round(x)), String(Math.round(y)));
    args.push('click', '--repeat', String(times), '--delay', '80', String(b));
    await xdotool(cfg, args, timeoutMs);
    // Where we clicked is where we told it to click; see movePointer.
    return { x: at ? Math.round(x) : null, y: at ? Math.round(y) : null, button, count: times };
  }
  if (session === 'quartz') {
    if (onPath('cliclick')) {
      const prefix = button === 'right' ? 'rc' : times >= 2 ? 'dc' : 'c';
      const arg = at ? `${prefix}:${Math.round(x)},${Math.round(y)}` : `${prefix}:.`;
      const r = await runArgv(cfg, { file: 'cliclick', args: [arg], timeoutMs });
      if (runFailed(r)) throw new Error(describeRunFailure(r, 'cliclick'));
      return { x: at ? Math.round(x) : null, y: at ? Math.round(y) : null, button, count: times };
    }
    const clicked = await jxaPointer(
      cfg,
      { op: 'click', absolute: at, x: Math.round(x ?? 0), y: Math.round(y ?? 0), button, count: times },
      timeoutMs,
    );
    return { x: clicked.at?.x ?? null, y: clicked.at?.y ?? null, button, count: times };
  }
  const tool = waylandTool('pointer');
  if (at) await movePointer(cfg, { x, y, timeoutMs });
  const code = button === 'right' ? '0xC1' : button === 'middle' ? '0xC2' : '0xC0';
  const r = await runArgv(cfg, { file: tool, args: ['click', '--repeat', String(times), code], timeoutMs });
  if (runFailed(r)) throw new Error(describeRunFailure(r, tool));
  return { x: at ? Math.round(x) : null, y: at ? Math.round(y) : null, button, count: times };
}

/** Press, move, release — with the moves in between that make it a drag. */
export async function dragPointer(cfg, { x = null, y = null, toX, toY, button = 'left', steps = 12, timeoutMs = 20000 } = {}) {
  const b = buttonNumber(button);
  if (toX === undefined || toY === undefined || toX === null || toY === null) {
    throw new Error('drag needs to_x and to_y — where the drag ends');
  }
  const session = requireSession();
  const from = x !== null && y !== null ? { x: Math.round(x), y: Math.round(y) } : await pointerPosition(cfg, { timeoutMs });
  const n = Math.max(1, Math.min(60, Math.round(steps)));

  if (session === 'windows') {
    const ok = parseOk(await runWindowsInput(cfg, [
      '-Mode', 'drag',
      '-X', String(from.x), '-Y', String(from.y),
      '-ToX', String(Math.round(toX)), '-ToY', String(Math.round(toY)),
      '-Button', String(b), '-Steps', String(n),
    ], timeoutMs));
    return { from, to: { x: Number(ok?.[0]), y: Number(ok?.[1]) }, button };
  }
  if (session === 'x11') {
    const args = ['mousemove', '--sync', String(from.x), String(from.y), 'mousedown', String(b)];
    for (let i = 1; i <= n; i++) {
      args.push(
        'mousemove', '--sync',
        String(Math.round(from.x + ((Math.round(toX) - from.x) * i) / n)),
        String(Math.round(from.y + ((Math.round(toY) - from.y) * i) / n)),
        'sleep', '0.012',
      );
    }
    args.push('mouseup', String(b));
    await xdotool(cfg, args, timeoutMs);
    return { from, to: { x: Math.round(toX), y: Math.round(toY) }, button };
  }
  if (session === 'quartz') {
    if (!onPath('cliclick')) {
      await jxaPointer(
        cfg,
        { op: 'drag', absolute: true, x: from.x, y: from.y, toX: Math.round(toX), toY: Math.round(toY), button, steps: n },
        timeoutMs,
      );
      return { from, to: { x: Math.round(toX), y: Math.round(toY) }, button };
    }
    const r = await runArgv(cfg, {
      file: 'cliclick',
      args: [`dd:${from.x},${from.y}`, `m:${Math.round(toX)},${Math.round(toY)}`, `du:${Math.round(toX)},${Math.round(toY)}`],
      timeoutMs,
    });
    if (runFailed(r)) throw new Error(describeRunFailure(r, 'cliclick'));
    return { from, to: { x: Math.round(toX), y: Math.round(toY) }, button };
  }
  throw new Error('Dragging is not supported on Wayland here: ydotool has no press-move-release sequence that survives a compositor grab.');
}

/** Turn the wheel. Positive scrolls down, the way a page moves. */
export async function scrollWheel(cfg, { x = null, y = null, amount = 3, horizontal = false, timeoutMs = 15000 } = {}) {
  const clicks = Math.round(amount);
  if (!clicks) throw new Error('scroll needs a non-zero amount — positive scrolls down, negative up');
  const session = requireSession();
  const at = x !== null && y !== null;

  if (session === 'windows') {
    const args = ['-Mode', 'scroll', '-Amount', String(-clicks), '-Horizontal', horizontal ? '1' : '0'];
    if (at) args.push('-X', String(Math.round(x)), '-Y', String(Math.round(y)));
    await runWindowsInput(cfg, args, timeoutMs);
    return { amount: clicks, horizontal };
  }
  if (session === 'x11') {
    const args = [];
    if (at) args.push('mousemove', '--sync', String(Math.round(x)), String(Math.round(y)));
    // X11 has no wheel axis: scrolling is buttons 4/5 up/down and 6/7 left/right.
    const button = horizontal ? (clicks > 0 ? 7 : 6) : clicks > 0 ? 5 : 4;
    args.push('click', '--repeat', String(Math.abs(clicks)), '--delay', '30', String(button));
    await xdotool(cfg, args, timeoutMs);
    return { amount: clicks, horizontal };
  }
  if (session === 'quartz') {
    await jxaPointer(
      cfg,
      { op: 'scroll', absolute: at, x: Math.round(x ?? 0), y: Math.round(y ?? 0), amount: clicks, horizontal },
      timeoutMs,
    );
    return { amount: clicks, horizontal };
  }
  const tool = waylandTool('pointer');
  const r = await runArgv(cfg, { file: tool, args: ['mousemove', '--wheel', '--', '0', String(clicks)], timeoutMs });
  if (runFailed(r)) throw new Error(describeRunFailure(r, tool));
  return { amount: clicks, horizontal };
}

// ------------------------------------------------------------------ keyboard

/** Type text into whatever has focus. */
export async function typeText(cfg, { text, intervalMs = 0, timeoutMs = 60000 } = {}) {
  if (typeof text !== 'string' || text === '') throw new Error('type needs "text"');
  const session = requireSession();
  const delay = Math.max(0, Math.min(500, Math.round(intervalMs)));

  if (session === 'windows') {
    await runWindowsInput(cfg, ['-Mode', 'type', '-Text', text, '-IntervalMs', String(delay)], timeoutMs);
    return { chars: [...text].length };
  }
  if (session === 'x11') {
    await xdotool(cfg, ['type', '--clearmodifiers', '--delay', String(delay || 12), '--', text], timeoutMs, utf8Env());
    return { chars: [...text].length };
  }
  if (session === 'quartz') {
    await osascript(cfg, `tell application "System Events" to keystroke ${quoteAppleScript(text)}`, timeoutMs);
    return { chars: [...text].length };
  }
  const tool = waylandTool('keyboard');
  const r = await runArgv(cfg, { file: tool, args: ['--', text], timeoutMs });
  if (runFailed(r)) throw new Error(describeRunFailure(r, tool));
  return { chars: [...text].length };
}

/** Press key chords in order, optionally holding each one. */
export async function pressKeys(cfg, { keys, holdMs = 0, intervalMs = 0, timeoutMs = 30000 } = {}) {
  const chords = parseChords(keys);
  const session = requireSession();
  const hold = Math.max(0, Math.min(10000, Math.round(holdMs)));
  const gap = Math.max(0, Math.min(2000, Math.round(intervalMs)));

  if (session === 'windows') {
    const payload = JSON.stringify(
      chords.map((c) => ({
        mods: c.mods.map((m) => MODIFIERS[m].vk),
        vk: c.vk,
        char: c.char,
        ext: c.ext,
      })),
    );
    await runWindowsInput(
      cfg,
      ['-Mode', 'keys', '-Chords', payload, '-HoldMs', String(hold), '-IntervalMs', String(gap)],
      timeoutMs,
    );
    return { chords: chords.map(describeChord) };
  }
  if (session === 'x11') {
    if (hold) {
      // A held key has to be down and up separately; xdotool key does both.
      for (const c of chords) {
        const spec = xdotoolChord(c);
        await xdotool(cfg, ['keydown', '--clearmodifiers', spec], timeoutMs);
        await new Promise((r) => setTimeout(r, hold));
        await xdotool(cfg, ['keyup', '--clearmodifiers', spec], timeoutMs);
      }
    } else {
      await xdotool(
        cfg,
        ['key', '--clearmodifiers', '--delay', String(gap || 30), ...chords.map(xdotoolChord)],
        timeoutMs,
      );
    }
    return { chords: chords.map(describeChord) };
  }
  if (session === 'quartz') {
    const lines = chords.map((c) => `  ${appleScriptChord(c)}`).join('\n');
    await osascript(cfg, `tell application "System Events"\n${lines}\nend tell`, timeoutMs);
    return { chords: chords.map(describeChord), note: hold ? 'holdMs is ignored on macOS: System Events has no press-and-hold' : null };
  }
  const tool = waylandTool('keyboard');
  for (const c of chords) {
    const args = [];
    const mods = c.mods.map((m) => (m === 'win' ? 'logo' : m));
    for (const m of mods) args.push('-M', m);
    args.push('-k', c.char ? (X11_KEYSYMS[c.char] ?? c.char) : c.keysym);
    for (const m of mods) args.push('-m', m);
    const r = await runArgv(cfg, { file: tool, args, timeoutMs });
    if (runFailed(r)) throw new Error(describeRunFailure(r, tool));
  }
  return { chords: chords.map(describeChord) };
}

/** Bring a window to the front, so input goes where it is meant to. */
export async function focusWindow(cfg, { window: spec, timeoutMs = 15000 } = {}) {
  const session = requireSession();
  const win = await findWindow(cfg, spec, timeoutMs);

  if (session === 'windows') {
    await runWindowsInput(cfg, ['-Mode', 'focus', '-Title', String(spec)], timeoutMs);
    return win;
  }
  if (session === 'x11') {
    try {
      await xdotool(cfg, ['windowactivate', '--sync', String(win.id)], timeoutMs);
    } catch (err) {
      // windowactivate asks the window manager to do it, so it fails outright
      // when there is no window manager — a kiosk, a bare X session, a virtual
      // display. windowfocus goes to the X server instead, which always works
      // but does not raise the window above others.
      await xdotool(cfg, ['windowfocus', '--sync', String(win.id)], timeoutMs);
      return { ...win, note: `focused but not raised: no window manager answered (${err.message.split('\n')[0]})` };
    }
    return win;
  }
  if (session === 'quartz') {
    const app = String(win.title).split(' — ')[0];
    await osascript(cfg, `tell application "System Events" to set frontmost of every process whose name is ${quoteAppleScript(app)} to true`, timeoutMs);
    return win;
  }
  throw new Error('Wayland does not let one application raise another window, by design.');
}

/** What input can and cannot do on this machine, and whether it works at all. */
export async function inputProbe(cfg, { timeoutMs = 20000 } = {}) {
  const session = sessionType();
  const lines = [`platform: ${process.platform}`, `session type: ${session ?? 'none'}`];
  if (!session) {
    lines.push('', 'No graphical session, so there is nothing to click. The browser tool works headlessly.');
    return lines.join('\n');
  }

  if (session === 'windows') {
    lines.push(`powershell: ${powershell()}`);
    let out;
    try {
      out = await runWindowsInput(cfg, ['-Mode', 'probe'], timeoutMs);
    } catch (err) {
      lines.push('', `the PowerShell probe itself failed: ${err.message}`);
      return lines.join('\n');
    }
    const fields = {};
    for (const line of out.trim().split(/\r?\n/)) {
      const parts = line.split('\t');
      if (parts[0]) fields[parts[0]] = parts.slice(1);
    }
    const one = (k) => (fields[k] ?? []).join(' ').trim();
    lines.push(
      `pointer now at: ${one('pointer').replace('\t', ',')}`,
      `foreground window: ${one('foreground') || '(none)'}`,
      `virtual screen: ${one('virtualscreen')}`,
      `SendInput: ${one('sendinput')}`,
      '',
      'Injected input is delivered by the OS, so applications cannot tell it from a real',
      'keyboard — except software that reads raw HID and deliberately checks, which is what',
      'anti-cheat does. If a game ignores this, no software setting will fix it.',
    );
    return lines.join('\n');
  }

  if (session === 'x11') {
    lines.push(`xdotool: ${onPath('xdotool') ? 'installed' : 'MISSING — apt install xdotool'}`);
    if (onPath('xdotool')) {
      try {
        const p = await pointerPosition(cfg, { timeoutMs });
        lines.push(`pointer now at: ${p.x},${p.y}`);
        await movePointer(cfg, { x: p.x + 1, y: p.y, timeoutMs });
        const after = await pointerPosition(cfg, { timeoutMs });
        await movePointer(cfg, { x: p.x, y: p.y, timeoutMs });
        lines.push(
          after.x !== p.x
            ? 'one-pixel test move: ok'
            : 'one-pixel test move: X accepted it but still reports the old position. That is a ' +
              'quirk of some servers (Xvfb does it) and does not mean the pointer is stuck: ' +
              'clicks still land where you aim them, but "position" cannot be trusted here.',
        );
      } catch (err) {
        lines.push(`test move FAILED: ${err.message}`);
      }
    }
    return lines.join('\n');
  }

  if (session === 'quartz') {
    lines.push(
      `cliclick: ${onPath('cliclick') ? 'installed — used for the pointer' : 'not installed (optional: CoreGraphics is used instead)'}`,
      'pointer events: CGEventPost through osascript -l JavaScript',
      'keyboard and focus: System Events',
    );

    // The Accessibility flag, asked the way AppleScript itself asks it. A
    // refusal here is immediate, which is the point: a hang means something
    // else is wrong.
    try {
      const enabled = (await osascript(cfg, 'tell application "System Events" to return UI elements enabled', 8000)).trim();
      lines.push(`Accessibility (UI elements enabled): ${enabled || 'no answer'}`);
    } catch (err) {
      lines.push(`Accessibility check FAILED: ${err.message.split('\n')[0]}`);
    }

    // The real test: post an event and see whether the pointer moved.
    try {
      const before = await pointerPosition(cfg, { timeoutMs });
      lines.push(`pointer now at: ${before.x},${before.y}`);
      await movePointer(cfg, { x: before.x + 1, y: before.y, timeoutMs });
      const after = await pointerPosition(cfg, { timeoutMs });
      await movePointer(cfg, { x: before.x, y: before.y, timeoutMs });
      lines.push(
        after.x !== before.x
          ? 'one-pixel test move: ok — injected input works on this machine'
          : 'one-pixel test move: the event was accepted but the pointer did not move. ' +
            'That is what a missing Accessibility grant looks like from here: macOS drops ' +
            'posted events silently rather than refusing them.',
      );
    } catch (err) {
      lines.push(`one-pixel test move FAILED: ${err.message}`);
    }

    lines.push(
      '',
      'Accessibility must be granted to the application that launched this server — the ' +
      'terminal, the editor, or the Claude app — not to node, which inherits it. If clicks ' +
      'do nothing, that grant is the first thing to check, and toggling it off and on again ' +
      'is what usually makes macOS notice a rebuilt binary.',
    );
    return lines.join('\n');
  }

  lines.push(
    `ydotool (pointer): ${onPath('ydotool') ? 'installed' : 'not installed'}`,
    `wtype (keyboard): ${onPath('wtype') ? 'installed' : 'not installed'}`,
    '',
    'Wayland does not allow input injection by design; these two work around it with ' +
    '/dev/uinput and the virtual-keyboard protocol respectively. An X11 session needs only xdotool.',
  );
  return lines.join('\n');
}
