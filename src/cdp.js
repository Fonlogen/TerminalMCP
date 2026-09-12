// The Chrome DevTools Protocol, spoken directly.
//
// This is the layer Playwright and Puppeteer are built on. Talking to it
// ourselves costs one hand-written WebSocket client (src/ws.js) and buys the
// whole feature set — navigation, DOM, input, screenshots, network, cookies —
// with no dependency to install, no browser to download, and no version of a
// driver to keep in step with the browser.
//
// It also buys something a bundled driver cannot: this can attach to the
// browser the user already has open, with their profile, their extensions and
// their logged-in sessions.
//
// Chromium family only. Firefox removed most of its CDP surface in favour of
// WebDriver BiDi, which is a different protocol; see the README.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { wsConnect } from './ws.js';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

/** Where browsers install themselves, per platform, best candidate first. */
function candidatePaths() {
  if (IS_WIN) {
    const roots = [
      process.env['PROGRAMFILES'],
      process.env['PROGRAMFILES(X86)'],
      process.env['LOCALAPPDATA'],
    ].filter(Boolean);
    const rel = [
      ['Google\\Chrome\\Application\\chrome.exe', 'chrome'],
      ['Microsoft\\Edge\\Application\\msedge.exe', 'edge'],
      ['BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'brave'],
      ['Chromium\\Application\\chrome.exe', 'chromium'],
      ['Vivaldi\\Application\\vivaldi.exe', 'vivaldi'],
      ['Google\\Chrome Beta\\Application\\chrome.exe', 'chrome-beta'],
    ];
    const out = [];
    for (const r of roots) for (const [p, kind] of rel) out.push([path.join(r, p), kind]);
    return out;
  }

  if (IS_MAC) {
    const apps = [
      ['Google Chrome.app/Contents/MacOS/Google Chrome', 'chrome'],
      ['Chromium.app/Contents/MacOS/Chromium', 'chromium'],
      ['Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'edge'],
      ['Brave Browser.app/Contents/MacOS/Brave Browser', 'brave'],
      ['Vivaldi.app/Contents/MacOS/Vivaldi', 'vivaldi'],
    ];
    const out = [];
    for (const base of ['/Applications', path.join(process.env.HOME || '', 'Applications')]) {
      for (const [p, kind] of apps) out.push([path.join(base, p), kind]);
    }
    return out;
  }

  return [
    ['/usr/bin/google-chrome', 'chrome'],
    ['/usr/bin/google-chrome-stable', 'chrome'],
    ['/opt/google/chrome/chrome', 'chrome'],
    ['/usr/bin/chromium', 'chromium'],
    ['/usr/bin/chromium-browser', 'chromium'],
    ['/snap/bin/chromium', 'chromium'],
    ['/usr/bin/microsoft-edge', 'edge'],
    ['/usr/bin/brave-browser', 'brave'],
    ['/usr/bin/vivaldi', 'vivaldi'],
  ];
}

/**
 * Browsers downloaded by Playwright or Puppeteer.
 *
 * Not a dependency on either tool — just an acknowledgement that a dev machine
 * which has one already has a perfectly good Chromium sitting on disk, and
 * making the user install another would be rude.
 */
function managedPaths() {
  const out = [];
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.PUPPETEER_CACHE_DIR,
    path.join(process.env.HOME || process.env.USERPROFILE || '', '.cache', 'ms-playwright'),
    path.join(process.env.HOME || process.env.USERPROFILE || '', '.cache', 'puppeteer'),
    IS_MAC ? path.join(process.env.HOME || '', 'Library', 'Caches', 'ms-playwright') : null,
    IS_WIN ? path.join(process.env.LOCALAPPDATA || '', 'ms-playwright') : null,
  ].filter(Boolean);

  const leaf = IS_WIN
    ? ['chrome-win\\chrome.exe']
    : IS_MAC
      ? ['chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']
      : ['chrome-linux/chrome', 'chrome-linux64/chrome'];

  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    // Playwright helpfully leaves a plain `chromium` symlink at the root.
    for (const direct of ['chromium', 'chrome']) {
      const p = path.join(root, direct);
      if (existsSync(p)) out.push([p, 'chromium']);
    }
    let entries = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    // Prefer the newest build, and a real browser over a headless shell (the
    // shell cannot show a window, which defeats "attach to what I can see").
    const versioned = entries
      .filter((e) => /^chromium(_headless_shell)?-\d+$/.test(e) || /^chrome\b/.test(e))
      .sort((a, b) => {
        const shell = (s) => (s.includes('headless_shell') ? 1 : 0);
        if (shell(a) !== shell(b)) return shell(a) - shell(b);
        const n = (s) => Number((s.match(/(\d+)/) || [0, 0])[1]);
        return n(b) - n(a);
      });
    for (const dir of versioned) {
      for (const l of leaf) {
        const p = path.join(root, dir, l);
        if (existsSync(p)) out.push([p, 'chromium']);
      }
      // Puppeteer nests one level deeper: chrome/<platform>-<version>/<leaf>.
      let inner = [];
      try {
        inner = readdirSync(path.join(root, dir));
      } catch {
        continue;
      }
      for (const sub of inner.filter((s) => /^(linux|mac|win)/.test(s)).sort().reverse()) {
        for (const l of leaf) {
          const p = path.join(root, dir, sub, l);
          if (existsSync(p)) out.push([p, 'chrome']);
        }
      }
    }
  }
  return out;
}

function onPath(name) {
  const dirs = (process.env.PATH || '').split(IS_WIN ? ';' : ':').filter(Boolean);
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * Find a Chromium-family browser to drive.
 * Returns { path, kind, source } or throws with everything it tried.
 */
export function findBrowser(explicit = null) {
  const envNames = ['TERMINALMCP_BROWSER', 'CHROME_PATH', 'PUPPETEER_EXECUTABLE_PATH', 'CHROME_BIN'];

  if (explicit) {
    if (existsSync(explicit)) return { path: explicit, kind: guessKind(explicit), source: 'configured' };
    const viaPath = onPath(explicit);
    if (viaPath) return { path: viaPath, kind: guessKind(viaPath), source: 'PATH' };
    throw new Error(`Browser not found at "${explicit}"`);
  }

  for (const name of envNames) {
    const v = process.env[name];
    if (v && existsSync(v)) return { path: v, kind: guessKind(v), source: `$${name}` };
  }

  for (const [p, kind] of candidatePaths()) {
    if (existsSync(p)) return { path: p, kind, source: 'installed' };
  }
  for (const [p, kind] of managedPaths()) {
    if (existsSync(p)) return { path: p, kind, source: 'playwright/puppeteer cache' };
  }
  for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
    const p = onPath(name);
    if (p) return { path: p, kind: guessKind(p), source: 'PATH' };
  }

  throw new Error(
    'No Chromium-family browser found. Install Chrome, Chromium, Edge or Brave, ' +
    'or point at one with browser.executable in the config file, --browser-path, ' +
    'or $CHROME_PATH. Already have a browser open? Start it with ' +
    '--remote-debugging-port=9222 and use action "attach" instead — you get its ' +
    'profile and logins too.',
  );
}

function guessKind(p) {
  const b = path.basename(p).toLowerCase();
  if (b.includes('msedge') || b.includes('edge')) return 'edge';
  if (b.includes('brave')) return 'brave';
  if (b.includes('vivaldi')) return 'vivaldi';
  if (b.includes('chromium')) return 'chromium';
  return 'chrome';
}

/** GET a JSON document off the browser's HTTP debugging endpoint. */
export function httpJson(host, port, urlPath, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      // The endpoint rejects requests whose Host header is not a literal IP or
      // "localhost", which is why this is not just any hostname.
      { host, port, path: urlPath, method: 'GET', headers: { Host: `${host}:${port}` }, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode} from ${urlPath}: ${body.slice(0, 200)}`));
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`Not JSON from ${urlPath}: ${body.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

const sleep = (n) => new Promise((r) => setTimeout(r, n));

/** Wait until the debugging endpoint answers, and return its browser WS URL. */
async function waitForEndpoint(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const v = await httpJson(host, port, '/json/version', 2000);
      if (v.webSocketDebuggerUrl) return v;
    } catch (err) {
      last = err;
    }
    await sleep(100);
  }
  throw new Error(
    `No DevTools endpoint on ${host}:${port} after ${timeoutMs}ms${last ? ` (${last.message})` : ''}`,
  );
}

/** Read the port Chrome chose for itself when asked for port 0. */
function readActivePort(userDataDir) {
  const f = path.join(userDataDir, 'DevToolsActivePort');
  if (!existsSync(f)) return null;
  const first = readFileSync(f, 'utf8').split('\n')[0].trim();
  const n = Number(first);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Launch a browser with remote debugging on.
 *
 * Port 0 means "let the browser pick": it writes the real port into
 * DevToolsActivePort in its profile directory, which is race-free, unlike
 * picking a free port here and hoping nothing else takes it first.
 */
export async function launchBrowser({
  executable = null,
  headless = true,
  port = 0,
  userDataDir = null,
  args = [],
  viewport = { width: 1280, height: 800 },
  timeoutMs = 30000,
  env = {},
} = {}) {
  const found = findBrowser(executable);

  let profileDir = userDataDir;
  let temp = false;
  if (!profileDir) {
    profileDir = mkdtempSync(path.join(tmpdir(), 'terminalmcp-browser-'));
    temp = true;
  }

  const flags = [
    `--remote-debugging-port=${port || 0}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // Chrome refuses a WebSocket whose Origin it does not recognise. We send
    // none, but a proxy or a future version might add one.
    '--remote-allow-origins=*',
    `--window-size=${viewport.width},${viewport.height}`,
  ];
  if (headless) flags.push('--headless=new', '--hide-scrollbars');
  // Containers give the browser a 64MB /dev/shm, which crashes renderers, and
  // the sandbox cannot initialise as uid 0. Both are container facts, so
  // detect them rather than asking the user to know about them.
  if (!IS_WIN && !IS_MAC) {
    flags.push('--disable-dev-shm-usage');
    if (typeof process.getuid === 'function' && process.getuid() === 0) flags.push('--no-sandbox');
  }
  flags.push(...args);

  const child = spawn(found.path, flags, {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ...env },
    detached: false,
    windowsHide: true,
  });

  let stderr = '';
  child.stderr?.on('data', (c) => {
    stderr = (stderr + c.toString()).slice(-4000);
  });

  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  // Find the port. When we asked for one we still confirm the endpoint answers.
  const deadline = Date.now() + timeoutMs;
  let realPort = port || null;
  while (!realPort && Date.now() < deadline) {
    if (exited) break;
    realPort = readActivePort(profileDir);
    if (!realPort) await sleep(80);
  }
  if (exited) {
    throw new Error(
      `${path.basename(found.path)} exited immediately (code ${exited.code}${exited.signal ? `, ${exited.signal}` : ''})` +
      `${stderr ? `:\n${stderr.trim().split('\n').slice(-8).join('\n')}` : ''}`,
    );
  }
  if (!realPort) {
    child.kill();
    throw new Error(`Browser did not report a debugging port within ${timeoutMs}ms${stderr ? `:\n${stderr.slice(-500)}` : ''}`);
  }

  const version = await waitForEndpoint('127.0.0.1', realPort, Math.max(2000, deadline - Date.now())).catch((err) => {
    child.kill();
    throw new Error(`${err.message}${stderr ? `\nbrowser stderr:\n${stderr.slice(-500)}` : ''}`);
  });

  return {
    child,
    exe: found,
    host: '127.0.0.1',
    port: realPort,
    wsUrl: version.webSocketDebuggerUrl,
    version,
    userDataDir: profileDir,
    tempProfile: temp,
    headless,
  };
}

/** Common ports people use for --remote-debugging-port, in the order tried. */
export const COMMON_DEBUG_PORTS = [9222, 9223, 9229, 9333, 8315];

/** Attach to a browser that is already running with remote debugging on. */
export async function attachBrowser({ host = '127.0.0.1', port = null, timeoutMs = 5000 } = {}) {
  const ports = port ? [port] : COMMON_DEBUG_PORTS;
  const errors = [];
  for (const p of ports) {
    try {
      const version = await waitForEndpoint(host, p, port ? timeoutMs : 700);
      return {
        child: null,
        exe: { path: version.Browser || 'unknown', kind: guessKind(version.Browser || ''), source: 'attached' },
        host,
        port: p,
        wsUrl: version.webSocketDebuggerUrl,
        version,
        userDataDir: null,
        tempProfile: false,
        headless: false,
      };
    } catch (err) {
      errors.push(`${host}:${p} — ${err.message}`);
    }
  }
  throw new Error(
    `Could not attach to a browser.\n${errors.join('\n')}\n` +
    'Start one with:  chrome --remote-debugging-port=9222\n' +
    'On a browser that is already open, quit it fully first — the flag only ' +
    'takes effect on a cold start.',
  );
}

/**
 * One WebSocket to the browser, many target sessions multiplexed over it.
 *
 * This is CDP's "flat" session mode: every message carries a sessionId, so a
 * dozen tabs cost one socket rather than a dozen.
 */
export class CdpConnection extends EventEmitter {
  constructor(ws, { defaultTimeoutMs = 30000 } = {}) {
    super();
    this.setMaxListeners(0);
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.closed = false;
    this.closeReason = null;

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      this._dispatch(msg);
    });
    ws.on('close', (reason) => {
      this.closed = true;
      this.closeReason = reason;
      for (const [, p] of this.pending) {
        p.reject(new Error(`Browser connection closed (${reason || 'no reason given'})`));
      }
      this.pending.clear();
      this.emit('disconnected', reason);
    });
    // Without a listener an 'error' event would take the process down.
    ws.on('error', (err) => this.emit('ws-error', err));
  }

  static async open(wsUrl, opts = {}) {
    const ws = await wsConnect(wsUrl, { timeoutMs: opts.connectTimeoutMs ?? 15000 });
    return new CdpConnection(ws, opts);
  }

  _dispatch(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject, timer, method } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        const detail = msg.error.data ? ` (${msg.error.data})` : '';
        reject(new Error(`${method}: ${msg.error.message}${detail}`));
      } else {
        resolve(msg.result ?? {});
      }
      return;
    }
    if (msg.method) {
      const sid = msg.sessionId ?? '';
      this.emit('event', msg);
      this.emit(`${sid}/${msg.method}`, msg.params ?? {}, sid);
      this.emit(`*/${msg.method}`, msg.params ?? {}, sid);
    }
  }

  send(method, params = {}, sessionId = null, { timeoutMs } = {}) {
    if (this.closed) {
      return Promise.reject(new Error(`Browser connection is closed${this.closeReason ? ` (${this.closeReason})` : ''}`));
    }
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      const limit = timeoutMs ?? this.defaultTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${limit}ms`));
      }, limit);
      if (timer.unref) timer.unref();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  close() {
    if (this.closed) return;
    try {
      this.ws.close();
    } catch {
      /* going away anyway */
    }
    this.closed = true;
  }
}
