// Page-level browser control, on top of raw CDP.
//
// The thing that matters most here is `snapshot`. Handing a model 400KB of
// HTML to find a login button is the browser equivalent of `cat`-ing a whole
// file to find one function: it works, and it is enormously wasteful. So the
// primary way to read a page is a compact list of the elements you can
// actually act on, each with a short ref:
//
//   e14  button  "Sign in"
//
// followed by `click { ref: "e14" }`. That is a few hundred tokens for a page
// instead of tens of thousands, and it survives a redesign of the markup —
// which a brittle CSS selector does not.
//
// Refs live in the page as `window.__tmcpRefs`, so they are invalidated by
// navigation exactly when they should be, and a stale ref says so rather than
// clicking the wrong thing.

import { existsSync, mkdirSync } from 'node:fs';
import { rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { attachBrowser, launchBrowser, CdpConnection } from './cdp.js';
import { truncateMiddle, ms } from './format.js';

const sleep = (n) => new Promise((r) => setTimeout(r, n));

/** Helpers injected into the page for element resolution and naming. */
const HELPERS = `
const __vis = (el) => {
  if (!el || !el.getBoundingClientRect) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 1 && r.height < 1) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
};
const __name = (el) => {
  const attr = (n) => (el.getAttribute && el.getAttribute(n)) || '';
  let t = attr('aria-label') || attr('alt') || attr('title');
  if (!t && el.labels && el.labels[0]) t = el.labels[0].innerText || '';
  if (!t && attr('aria-labelledby')) {
    const l = document.getElementById(attr('aria-labelledby'));
    if (l) t = l.innerText || '';
  }
  if (!t) t = (el.innerText || el.textContent || '').trim();
  if (!t && el.value && el.type !== 'password') t = String(el.value);
  if (!t) t = attr('placeholder') || attr('name');
  return t.replace(/\\s+/g, ' ').trim().slice(0, 120);
};
/** Lower is a better target: actionable beats decorative, inner beats outer. */
const __rank = (el) => {
  const tag = el.tagName.toLowerCase();
  let score = 0;
  if (/^(a|button|input|select|textarea|summary|option)$/.test(tag) || el.getAttribute('role') || el.isContentEditable) {
    score -= 1000;
  } else if (tag === 'label') {
    // A label is not itself interactive, but clicking one activates its
    // control, so it is a better target than a plain wrapper.
    score -= 500;
  }
  let depth = 0;
  for (let p = el; p; p = p.parentElement) depth++;
  return score - depth;
};
const __resolve = (spec) => {
  if (spec.ref) {
    const arr = window.__tmcpRefs;
    if (!arr) throw new Error('No refs in this page: the page navigated or reloaded since the last snapshot. Call snapshot again.');
    const el = arr[Number(String(spec.ref).replace(/^e/, ''))];
    if (!el) throw new Error('Unknown ref ' + spec.ref + '. Call snapshot again.');
    if (!el.isConnected) throw new Error('Ref ' + spec.ref + ' points at an element the page has since removed. Call snapshot again.');
    return el;
  }
  if (spec.selector) {
    const el = document.querySelector(spec.selector);
    if (!el) throw new Error('No element matches selector ' + JSON.stringify(spec.selector));
    return el;
  }
  if (spec.text) {
    const want = String(spec.text).toLowerCase();
    // Broad on purpose: "wait for the words 'Order confirmed'" is as common a
    // request as "click the button labelled X", and that text usually lives in
    // a <p> or a heading rather than in anything interactive.
    const all = document.querySelectorAll(
      'a,button,input,select,textarea,[role],[aria-label],label,summary,option,' +
      'h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,figcaption,legend,strong,b,em,i,small,code,span,div'
    );

    const matches = [];
    for (const el of all) {
      if (!__vis(el)) continue;
      const n = __name(el).toLowerCase();
      if (!n) continue;
      const exact = n === want;
      if (!exact && !n.includes(want)) continue;
      matches.push({ el, exact: exact ? 1 : 0, len: n.length, rank: __rank(el) });
    }
    if (!matches.length) throw new Error('No visible element found with text ' + JSON.stringify(spec.text));

    // Several elements legitimately carry the same text: a <p> wrapping a
    // <label> wrapping the checkbox all read "Remember me", and a heading can
    // repeat its button's words. Prefer an exact match, then the thing you can
    // actually act on, then the innermost — not simply the first in the
    // document, which is usually the outermost container.
    matches.sort((a, b) => b.exact - a.exact || a.rank - b.rank || a.len - b.len);
    return matches[0].el;
  }
  throw new Error('Nothing to act on: pass selector, ref or text');
};
`;

/** A physical key, as CDP wants it described. */
const KEYS = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

const MODIFIER_BITS = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

/** Parse "Control+Shift+A" into a CDP key description plus a modifier mask. */
function parseKey(spec) {
  const parts = String(spec).split('+').map((s) => s.trim()).filter(Boolean);
  const name = parts.pop() ?? '';
  let modifiers = 0;
  for (const p of parts) {
    const bit = MODIFIER_BITS[p.toLowerCase()];
    if (!bit) throw new Error(`Unknown modifier "${p}". Use Control, Shift, Alt or Meta.`);
    modifiers |= bit;
  }

  const known = KEYS[name.toLowerCase()];
  if (known) return { ...known, modifiers };

  if (/^f([1-9]|1[0-2])$/i.test(name)) {
    const n = Number(name.slice(1));
    return { key: `F${n}`, code: `F${n}`, keyCode: 111 + n, modifiers };
  }
  if ([...name].length === 1) {
    const ch = name;
    const upper = ch.toUpperCase();
    return {
      key: ch,
      code: /[a-z]/i.test(ch) ? `Key${upper}` : /[0-9]/.test(ch) ? `Digit${ch}` : undefined,
      keyCode: upper.charCodeAt(0),
      // With Control or Meta held, a key is a shortcut, not typed input.
      text: modifiers & (MODIFIER_BITS.control | MODIFIER_BITS.meta) ? undefined : ch,
      modifiers,
    };
  }
  throw new Error(
    `Unknown key "${name}". Single characters, F1-F12, or: ${Object.keys(KEYS).join(', ')}.`,
  );
}

function ringPush(arr, item, cap) {
  arr.push(item);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

/** One attached page target, plus what it has been telling us. */
class Page {
  constructor(manager, targetInfo, sessionId) {
    this.manager = manager;
    this.targetId = targetInfo.targetId;
    this.sessionId = sessionId;
    this.url = targetInfo.url;
    this.title = targetInfo.title ?? '';
    this.console = [];
    this.network = [];
    this.dialogs = [];
    // Request ids still open, not a counter. A redirect reports
    // requestWillBeSent twice for the same id, and a request can be cancelled
    // without any terminal event at all, so counting up and down leaks — and a
    // leaked count means "wait until network idle" never returns.
    this.pending = new Map();
    this.lastActivity = Date.now();
    this.createdAt = Date.now();
  }

  /**
   * How many requests are genuinely outstanding.
   *
   * Anything older than the stall window is not counted: a server-sent-event
   * stream or a long-poll never finishes by design, and a page that uses one
   * would otherwise never be considered idle.
   */
  inflightCount(stallMs = 10000) {
    const now = Date.now();
    let n = 0;
    for (const startedAt of this.pending.values()) if (now - startedAt < stallMs) n++;
    return n;
  }

  get inflight() {
    return this.inflightCount();
  }

  get conn() {
    return this.manager.conn;
  }

  send(method, params, opts) {
    return this.conn.send(method, params, this.sessionId, opts);
  }

  /** Evaluate a function in the page. Args are serialised, not referenced. */
  async evaluate(fnBody, arg = null, { helpers = false, timeoutMs } = {}) {
    const expression = `(() => { ${helpers ? HELPERS : ''}
      const __arg = ${JSON.stringify(arg)};
      return (${fnBody})(__arg);
    })()`;

    const r = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      { timeoutMs },
    );
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const msg = d.exception?.description || d.exception?.value || d.text || 'evaluation failed';
      throw new Error(String(msg).split('\n')[0]);
    }
    return r.result?.value;
  }
}

/**
 * Owns the browser process (or the connection to someone else's) and the
 * attached pages.
 *
 * One browser per server, on purpose: the server drives one machine, in the
 * same way the job registry and the variable store are single and shared.
 */
export class BrowserManager {
  constructor(cfg) {
    this.cfg = cfg;
    this.handle = null;
    this.conn = null;
    this.pages = new Map();
    // Registrations in flight, keyed by targetId. Without this, auto-attach
    // and an explicit attach race each other and a page ends up with two
    // sessions — one of which has not finished Page.enable, so the next
    // navigation misses its load event and waits out the whole timeout.
    this.registering = new Map();
    this.activeId = null;
    this.startedAt = null;
    // Downloads, keyed by the GUID Chromium gives each one. `downloadSeq` is
    // what lets a caller wait for only the downloads its own click started.
    this.downloads = new Map();
    this.downloadSeq = 0;
    this.downloadEvents = false;
    this.downloadError = null;
  }

  get running() {
    return Boolean(this.conn && !this.conn.closed);
  }

  options() {
    return { ...(this.cfg.browser ?? {}) };
  }

  assertRunning() {
    if (!this.running) {
      throw new Error(
        'No browser is running. Start one with action "launch", or attach to one you ' +
        'already have open with action "attach" (start it with --remote-debugging-port=9222).',
      );
    }
  }

  async start(kind, opts) {
    if (this.running) {
      return { reused: true, ...this.describe() };
    }
    const o = this.options();
    this.handle =
      kind === 'attach'
        ? await attachBrowser({ host: opts.host ?? '127.0.0.1', port: opts.port ?? null })
        : await launchBrowser({
            executable: opts.executable ?? o.executable ?? null,
            headless: opts.headless ?? o.headless ?? true,
            port: opts.port ?? o.port ?? 0,
            userDataDir: opts.userDataDir ?? o.userDataDir ?? null,
            args: [...(o.args ?? []), ...(opts.args ?? [])],
            viewport: opts.viewport ?? o.viewport ?? { width: 1280, height: 800 },
            timeoutMs: opts.timeoutMs ?? o.launchTimeoutMs ?? 30000,
          });

    this.conn = await CdpConnection.open(this.handle.wsUrl, {
      defaultTimeoutMs: o.commandTimeoutMs ?? 30000,
    });
    this.startedAt = Date.now();

    // Pages the browser opens on its own (target=_blank, a restored session)
    // should be usable without the caller having to discover them.
    this.conn.on('*/Target.attachedToTarget', (params) => {
      if (params.targetInfo?.type !== 'page') return;
      this._registerOnce(params.targetInfo, params.sessionId).catch(() => {});
    });
    this.conn.on('*/Target.detachedFromTarget', (params) => {
      for (const [id, p] of this.pages) {
        if (p.sessionId === params.sessionId) this.pages.delete(id);
      }
      if (!this.pages.has(this.activeId)) this.activeId = [...this.pages.keys()][0] ?? null;
    });
    this.conn.on('disconnected', () => {
      this.pages.clear();
      this.activeId = null;
    });
    await this.conn.send('Target.setDiscoverTargets', { discover: true });
    // Auto-attach fires attachedToTarget for pages that already exist, so the
    // registrations it starts must finish before anything navigates.
    await this.conn.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    await this.settle();

    await this.enableDownloads();

    await this.syncTargets();
    if (!this.pages.size) await this.newPage('about:blank');
    return { reused: false, ...this.describe() };
  }

  downloadDir() {
    return this.cfg.browser?.downloadDir ?? path.join(this.cfg.cwd, '.terminalmcp', 'downloads');
  }

  /**
   * Make downloads land where the file tools can reach them — and, more to the
   * point, make them observable.
   *
   * Setting a download path was never the missing piece — that was already
   * here. What was missing is that nothing listened: the bytes went somewhere,
   * but nothing said when a download started, when it finished, or what the
   * file ended up being called, so the only way to find out was to guess a
   * filename and poll the directory.
   *
   * `allowAndName` writes each file under its download GUID and leaves the
   * naming to us. That is what makes the rest honest: two downloads of
   * "data.zip" cannot overwrite each other, and a half-written file is never
   * mistaken for a finished one, because the rename to the real name IS the
   * completion signal.
   */
  async enableDownloads() {
    const downloadPath = this.downloadDir();
    try {
      mkdirSync(downloadPath, { recursive: true });
    } catch (err) {
      this.downloadError = `${downloadPath} cannot be created: ${err.message}`;
    }
    this.conn.on('*/Browser.downloadWillBegin', (p) => this._downloadStarted(p));
    this.conn.on('*/Browser.downloadProgress', (p) => this._downloadProgress(p));

    try {
      await this.conn.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath,
        eventsEnabled: true,
      });
      this.downloadEvents = true;
    } catch (err) {
      // An older Chromium has no eventsEnabled, and a browser we merely
      // attached to may refuse to have its download policy changed at all.
      // Downloads can still work; we just cannot watch them, and saying so is
      // better than reporting a download that finished when we cannot know.
      this.downloadEvents = false;
      this.downloadError = err.message;
      try {
        await this.conn.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath });
      } catch {
        /* leave the browser's own policy alone */
      }
    }
  }

  _downloadStarted({ guid, url, suggestedFilename }) {
    if (!guid || this.downloads.has(guid)) return;
    const entry = {
      guid,
      index: ++this.downloadSeq,
      url: url ?? '',
      name: suggestedFilename || 'download',
      state: 'inProgress',
      received: 0,
      total: 0,
      path: null,
      error: null,
      startedAt: Date.now(),
      endedAt: null,
    };
    this.downloads.set(guid, entry);
    // A long session must not accumulate history for ever; finished entries
    // are the ones nobody is waiting on.
    if (this.downloads.size > 200) {
      for (const [g, d] of this.downloads) {
        if (d.state !== 'inProgress') { this.downloads.delete(g); break; }
      }
    }
  }

  _downloadProgress({ guid, totalBytes, receivedBytes, state }) {
    const d = this.downloads.get(guid);
    if (!d || d.state !== 'inProgress') return;
    if (totalBytes) d.total = totalBytes;
    if (receivedBytes !== undefined) d.received = receivedBytes;
    if (state === 'inProgress') return;

    d.endedAt = Date.now();
    if (state === 'canceled') {
      d.state = 'canceled';
      d.error = 'the browser cancelled it';
      return;
    }
    // Completed. The file still has to be given its name, and that is async,
    // so the entry stays 'inProgress' until the rename lands — otherwise a
    // waiter could be told the download is done before the file exists.
    d.finishing = this._finishDownload(d).catch((err) => {
      d.state = 'failed';
      d.error = err.message;
    });
  }

  async _finishDownload(d) {
    const dir = this.downloadDir();
    const from = path.join(dir, d.guid);
    const wanted = path.join(dir, safeDownloadName(d.name));

    if (existsSync(from)) {
      const to = await uniquePath(wanted);
      await rename(from, to);
      d.path = to;
      d.name = path.basename(to);
    } else if (existsSync(wanted)) {
      // `allow` rather than `allowAndName`: Chromium already named it.
      d.path = wanted;
    } else {
      d.state = 'failed';
      d.error = `the browser reported it finished, but neither ${from} nor ${wanted} exists`;
      return;
    }

    const st = await stat(d.path).catch(() => null);
    if (st) {
      d.received = st.size;
      if (!d.total) d.total = st.size;
    }
    d.state = 'completed';
  }

  /** Downloads still running, oldest first. */
  pendingDownloads() {
    return [...this.downloads.values()].filter((d) => d.state === 'inProgress');
  }

  /** Every download this session knows about, oldest first. */
  downloadList() {
    return [...this.downloads.values()].sort((a, b) => a.index - b.index);
  }

  /**
   * Wait for downloads to reach a terminal state.
   *
   * `since` is a download index: pass the value of `downloadSeq` from before
   * the click or navigation, and only what that action started is waited on.
   * Without it, a download already in flight from earlier would satisfy the
   * wait and the caller would be handed the wrong file.
   */
  async waitForDownloads({ since = 0, timeoutMs = 120000, need = 1 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const mine = this.downloadList().filter((d) => d.index > since);
      const settled = mine.filter((d) => d.state !== 'inProgress');
      if (mine.length >= need && settled.length === mine.length) {
        await Promise.allSettled(mine.map((d) => d.finishing).filter(Boolean));
        return mine;
      }
      if (Date.now() >= deadline) {
        return mine.length ? mine : null;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Wait for every in-flight page registration to finish. */
  async settle() {
    while (this.registering.size) {
      await Promise.allSettled([...this.registering.values()]);
    }
  }

  /** Adopt every page target the browser currently has. */
  async syncTargets() {
    const { targetInfos } = await this.conn.send('Target.getTargets');
    for (const info of targetInfos) {
      if (info.type !== 'page' || this.pages.has(info.targetId) || this.registering.has(info.targetId)) continue;
      const { sessionId } = await this.conn.send('Target.attachToTarget', {
        targetId: info.targetId,
        flatten: true,
      });
      await this._registerOnce(info, sessionId);
    }
    await this.settle();
    for (const id of [...this.pages.keys()]) {
      if (!targetInfos.some((t) => t.targetId === id)) this.pages.delete(id);
    }
    if (!this.pages.has(this.activeId)) this.activeId = [...this.pages.keys()][0] ?? null;
  }

  /** Register a target exactly once, whoever notices it first. */
  _registerOnce(info, sessionId) {
    const id = info.targetId;
    if (this.pages.has(id)) return Promise.resolve(this.pages.get(id));
    const already = this.registering.get(id);
    if (already) return already;

    const p = this._register(info, sessionId).finally(() => this.registering.delete(id));
    this.registering.set(id, p);
    return p;
  }

  async _register(info, sessionId) {
    const page = new Page(this, info, sessionId);
    this.pages.set(page.targetId, page);
    if (!this.activeId) this.activeId = page.targetId;

    const o = this.options();
    const consoleCap = o.maxConsoleEvents ?? 300;
    const netCap = o.maxNetworkEvents ?? 300;
    const sid = sessionId;

    const on = (method, fn) => this.conn.on(`${sid}/${method}`, fn);

    on('Runtime.consoleAPICalled', (p) => {
      ringPush(
        page.console,
        {
          at: Date.now(),
          level: p.type,
          text: (p.args ?? [])
            .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? a.type)))
            .join(' ')
            .slice(0, 2000),
        },
        consoleCap,
      );
    });
    on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails ?? {};
      ringPush(
        page.console,
        {
          at: Date.now(),
          level: 'exception',
          text: (d.exception?.description || d.text || 'exception').split('\n').slice(0, 3).join(' | ').slice(0, 2000),
        },
        consoleCap,
      );
    });
    on('Log.entryAdded', (p) => {
      const e = p.entry ?? {};
      ringPush(
        page.console,
        { at: Date.now(), level: e.level ?? 'log', text: `${e.source ? `[${e.source}] ` : ''}${e.text ?? ''}`.slice(0, 2000) },
        consoleCap,
      );
    });

    on('Network.requestWillBeSent', (p) => {
      page.pending.set(p.requestId, Date.now());
      page.lastActivity = Date.now();
      ringPush(
        page.network,
        {
          id: p.requestId,
          method: p.request?.method ?? 'GET',
          url: p.request?.url ?? '',
          type: p.type ?? '',
          startedAt: Date.now(),
          status: null,
          bytes: 0,
        },
        netCap,
      );
    });
    const finish = (p, patch) => {
      page.pending.delete(p.requestId);
      page.lastActivity = Date.now();
      const rec = page.network.find((r) => r.id === p.requestId);
      if (rec) Object.assign(rec, patch, { ms: Date.now() - rec.startedAt });
    };
    on('Network.responseReceived', (p) =>
      finish(p, { status: p.response?.status ?? null, mime: p.response?.mimeType }),
    );
    on('Network.loadingFailed', (p) => finish(p, { status: 'failed', error: p.errorText }));
    // Both of these also end a request's life, and either can be the only
    // terminal event one gets — a cached response reports no status at all.
    on('Network.requestServedFromCache', (p) => finish(p, { status: 'cached' }));
    on('Network.loadingFinished', (p) => {
      page.pending.delete(p.requestId);
      const rec = page.network.find((r) => r.id === p.requestId);
      if (rec) rec.bytes = p.encodedDataLength ?? rec.bytes;
    });

    // An unanswered dialog freezes the page, so always answer it — and keep
    // the message, because "why did nothing happen" is usually an alert().
    on('Page.javascriptDialogOpening', (p) => {
      const accept = (o.dialogs ?? 'accept') === 'accept';
      ringPush(page.dialogs, { at: Date.now(), type: p.type, message: p.message, accepted: accept }, 20);
      this.conn
        .send('Page.handleJavaScriptDialog', { accept, promptText: accept ? (o.dialogPrompt ?? '') : undefined }, sid)
        .catch(() => {});
    });

    on('Page.frameNavigated', (p) => {
      if (p.frame?.parentId) return;
      page.url = p.frame.url;
      page.loaderId = p.frame.loaderId ?? page.loaderId;
      // Requests belonging to the document we just left are abandoned, and the
      // browser does not always report a terminal event for them — Chrome's
      // own new-tab page is a reliable offender. Left in the map they would
      // make this page look permanently busy, so "in flight" means "for the
      // current document".
      page.pending.clear();
      page.lastActivity = Date.now();
    });

    for (const domain of ['Page', 'Runtime', 'Log', 'Network']) {
      await this.conn.send(`${domain}.enable`, {}, sessionId).catch(() => {});
    }
    // Lifecycle events carry the loaderId, which is the only reliable way to
    // tell "the page I just asked for has loaded" from "the page I was leaving
    // finished loading". Page.loadEventFired does not carry one.
    await this.conn.send('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId).catch(() => {});
    if (o.viewport && this.handle?.child) {
      // Only for browsers we launched: overriding metrics on someone's real
      // browser would resize the window they are looking at.
      await this.conn
        .send(
          'Emulation.setDeviceMetricsOverride',
          {
            width: o.viewport.width ?? 1280,
            height: o.viewport.height ?? 800,
            deviceScaleFactor: o.viewport.deviceScaleFactor ?? 1,
            mobile: false,
          },
          sessionId,
        )
        .catch(() => {});
    }
    return page;
  }

  page(id = null) {
    this.assertRunning();
    const key = id ?? this.activeId;
    const page = this.pages.get(key);
    if (!page) {
      throw new Error(
        `No such tab "${key}". Known tabs: ${[...this.pages.keys()].join(', ') || 'none'} (action "tabs" lists them).`,
      );
    }
    return page;
  }

  async newPage(url = 'about:blank') {
    this.assertRunning();
    const { targetId } = await this.conn.send('Target.createTarget', { url });
    if (!this.pages.has(targetId) && !this.registering.has(targetId)) {
      const { sessionId } = await this.conn.send('Target.attachToTarget', { targetId, flatten: true });
      await this._registerOnce({ targetId, url, type: 'page' }, sessionId);
    }
    await this.settle();
    this.activeId = targetId;
    return this.pages.get(targetId);
  }

  async closePage(id) {
    const page = this.page(id);
    await this.conn.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
    this.pages.delete(page.targetId);
    if (this.activeId === page.targetId) this.activeId = [...this.pages.keys()][0] ?? null;
    return page.targetId;
  }

  describe() {
    if (!this.running) return { running: false };
    return {
      running: true,
      exe: this.handle.exe?.path,
      kind: this.handle.exe?.kind,
      source: this.handle.exe?.source,
      version: this.handle.version?.Browser,
      headless: this.handle.headless,
      port: this.handle.port,
      attached: !this.handle.child,
      tabs: this.pages.size,
      active: this.activeId,
      uptimeMs: Date.now() - this.startedAt,
      profile: this.handle.userDataDir,
      tempProfile: this.handle.tempProfile,
    };
  }

  async close() {
    if (!this.conn) return false;
    const ours = Boolean(this.handle?.child);
    try {
      // Only close a browser we started. Killing the user's own browser
      // because a tool call said "close" would be unforgivable.
      if (ours) await this.conn.send('Browser.close', {}, null, { timeoutMs: 4000 }).catch(() => {});
    } finally {
      this.conn.close();
    }
    if (ours) {
      const child = this.handle.child;
      for (let i = 0; i < 30 && child.exitCode === null; i++) await sleep(100);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    this.conn = null;
    this.handle = null;
    this.pages.clear();
    this.activeId = null;
    return true;
  }
}

// ---------------------------------------------------------------- operations

/** Accept "example.com", "/tmp/page.html" and "localhost:3000" as URLs. */
export function normalizeUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('navigate needs a url');
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
  if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) return `file://${raw.replace(/\\/g, '/')}`;
  return `https://${raw}`;
}

const LIFECYCLE = { load: 'load', domcontentloaded: 'DOMContentLoaded', networkidle: 'load' };

/**
 * Collect lifecycle events from now on, so nothing is missed between sending
 * a navigation and learning which loaderId it got.
 */
function lifecycleRecorder(page) {
  const key = `${page.sessionId}/Page.lifecycleEvent`;
  const seen = [];
  let pendingWant = null;
  let resolvePending = null;

  const onEvent = (p) => {
    seen.push(p);
    if (
      pendingWant &&
      p.name === pendingWant.name &&
      (pendingWant.loaderId ? p.loaderId === pendingWant.loaderId : p.loaderId !== pendingWant.notLoaderId)
    ) {
      const fn = resolvePending;
      pendingWant = null;
      resolvePending = null;
      fn?.(p);
    }
  };
  page.conn.on(key, onEvent);

  return {
    /** Resolve true if the event arrives (or already has), false on timeout. */
    wait(want, timeoutMs) {
      const matches = (p) =>
        p.name === want.name &&
        (want.loaderId ? p.loaderId === want.loaderId : p.loaderId !== want.notLoaderId);
      if (seen.some(matches)) return Promise.resolve(true);

      return new Promise((resolve) => {
        pendingWant = want;
        resolvePending = () => resolve(true);
        const timer = setTimeout(() => {
          pendingWant = null;
          resolvePending = null;
          resolve(false);
        }, timeoutMs);
        if (timer.unref) timer.unref();
      });
    },
    stop() {
      page.conn.off(key, onEvent);
    },
  };
}

export async function navigate(page, { url, waitUntil = 'load', timeoutMs = 30000 }) {
  const target = normalizeUrl(url);
  const started = Date.now();
  const recorder = lifecycleRecorder(page);
  let timedOut = false;

  try {
    const res = await page.send('Page.navigate', { url: target }, { timeoutMs });
    if (res.errorText) {
      throw new Error(`Navigation to ${target} failed: ${res.errorText}`);
    }

    const name = LIFECYCLE[waitUntil];
    if (name) {
      // Tying the wait to this navigation's loaderId is the whole point: the
      // page being left behind can fire its own load event a moment after we
      // ask to leave, and treating that as ours means reading the old
      // document and reporting the wrong title.
      const ok = await recorder.wait({ name, loaderId: res.loaderId }, timeoutMs);
      timedOut = !ok;
    }
  } finally {
    recorder.stop();
  }

  if (waitUntil === 'networkidle' && !timedOut) {
    await waitForNetworkIdle(page, { timeoutMs: Math.max(1000, timeoutMs - (Date.now() - started)) });
  }

  const info = await pageInfo(page);
  return { ...info, ms: Date.now() - started, timedOut, requested: target };
}

/** Reload, waiting for a load event belonging to a new document. */
export async function reload(page, { ignoreCache = false, waitUntil = 'load', timeoutMs = 30000 } = {}) {
  const before = page.loaderId ?? null;
  const recorder = lifecycleRecorder(page);
  let timedOut = false;
  try {
    await page.send('Page.reload', { ignoreCache }, { timeoutMs });
    const name = LIFECYCLE[waitUntil];
    if (name) {
      timedOut = !(await recorder.wait({ name, notLoaderId: before }, timeoutMs));
    }
  } finally {
    recorder.stop();
  }
  const info = await pageInfo(page);
  return { ...info, timedOut };
}

export async function waitForNetworkIdle(page, { idleMs = 500, timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.inflightCount() === 0 && Date.now() - page.lastActivity >= idleMs) return true;
    await sleep(100);
  }
  return false;
}

export async function pageInfo(page) {
  const out = await page.evaluate(
    `() => ({ url: location.href, title: document.title, ready: document.readyState,
               w: innerWidth, h: innerHeight, sh: document.documentElement.scrollHeight })`,
  ).catch(() => null);
  if (out) {
    page.url = out.url;
    page.title = out.title;
  }
  return out ?? { url: page.url, title: page.title, ready: 'unknown' };
}

export async function getHtml(page, { selector = null, clean = false, maxBytes = 16000 }) {
  const html = await page.evaluate(
    `(a) => {
      ${HELPERS}
      const el = a.selector ? __resolve({ selector: a.selector }) : document.documentElement;
      let h = el.outerHTML || '';
      if (a.clean) {
        const d = el.cloneNode(true);
        for (const n of d.querySelectorAll('script,style,noscript,template,svg,link,meta')) n.remove();
        const w = document.createTreeWalker(d, NodeFilter.SHOW_COMMENT);
        const dead = [];
        while (w.nextNode()) dead.push(w.currentNode);
        for (const n of dead) n.remove();
        h = (d.outerHTML || '').replace(/>\\s+</g, '><').replace(/\\s{2,}/g, ' ');
      }
      return h;
    }`,
    { selector, clean },
  );
  const t = truncateMiddle(html, maxBytes);
  return { html: t.text, truncated: t.truncated, bytes: Buffer.byteLength(html) };
}

export async function getText(page, { selector = null, maxBytes = 16000 }) {
  const text = await page.evaluate(
    `(a) => {
      ${HELPERS}
      const el = a.selector ? __resolve({ selector: a.selector }) : document.body;
      return ((el && el.innerText) || '').replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
    }`,
    { selector },
  );
  const t = truncateMiddle(text, maxBytes);
  return { text: t.text, truncated: t.truncated, bytes: Buffer.byteLength(text) };
}

/**
 * The compact, actionable map of the page.
 *
 * Every element that can be interacted with, plus headings for orientation,
 * each with a ref that `click`/`type`/`select` accept. This is what a model
 * should read instead of the HTML.
 */
export async function snapshot(page, { selector = null, max = 200, all = false }) {
  const rows = await page.evaluate(
    `(a) => {
      ${HELPERS}
      const root = a.selector ? __resolve({ selector: a.selector }) : document.body;
      if (!root) return { rows: [], total: 0 };

      const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[contenteditable=""],[contenteditable="true"],[onclick],[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=option],[role=combobox],[role=searchbox],[role=textbox]';
      const STRUCTURE = 'h1,h2,h3,h4,h5,h6,label,[role=heading],[role=alert],[role=status]';
      const nodes = [...root.querySelectorAll(a.all ? INTERACTIVE + ',' + STRUCTURE + ',img[alt],table,form' : INTERACTIVE + ',' + STRUCTURE)];

      const refs = [null];
      const rows = [];
      let skipped = 0;

      for (const el of nodes) {
        if (!__vis(el)) { skipped++; continue; }
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || '';
        const name = __name(el);

        let kind = role || tag;
        if (tag === 'a') kind = 'link';
        else if (tag === 'input') kind = (el.type || 'text');
        else if (/^h[1-6]$/.test(tag)) kind = tag;

        const bits = [];
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          if (el.name) bits.push('name=' + el.name);
          if (el.id && !el.name) bits.push('id=' + el.id);
          if (el.placeholder) bits.push('placeholder=' + JSON.stringify(el.placeholder));
          if (el.type === 'checkbox' || el.type === 'radio') bits.push(el.checked ? 'checked' : 'unchecked');
          else if (el.value && el.type !== 'password') bits.push('value=' + JSON.stringify(String(el.value).slice(0, 60)));
          if (el.required) bits.push('required');
          if (tag === 'select') {
            bits.push('options=[' + [...el.options].slice(0, 12).map((o) => JSON.stringify(o.value || o.text)).join(',') + ']');
          }
        }
        if (tag === 'a' && el.getAttribute('href')) {
          let href = el.getAttribute('href');
          if (href.length > 80) href = href.slice(0, 77) + '...';
          bits.push('-> ' + href);
        }
        if (el.disabled) bits.push('disabled');
        if (el.getAttribute('aria-expanded')) bits.push('expanded=' + el.getAttribute('aria-expanded'));

        // Unnamed, attribute-less structural nodes tell a reader nothing.
        if (!name && !bits.length && /^(div|span|label|form|table)$/.test(tag)) { skipped++; continue; }
        // A label whose text is already its field's name is a duplicate row.
        if (tag === 'label' && el.control && __name(el.control) === name) { skipped++; continue; }

        refs.push(el);
        rows.push({ ref: 'e' + (refs.length - 1), kind, name, bits });
        if (rows.length >= a.max) break;
      }

      window.__tmcpRefs = refs;
      return { rows, total: nodes.length, skipped, url: location.href, title: document.title };
    }`,
    { selector, max, all },
  );
  return rows;
}

/** A data: URL is thousands of characters of no interest to anyone. */
export function shortUrl(url, max = 120) {
  const s = String(url ?? '');
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

export function renderSnapshot(snap, { label = '' } = {}) {
  const head = [`${shortUrl(snap.url)}${snap.title ? `  —  ${snap.title}` : ''}`];
  if (label) head.unshift(label);

  const lines = snap.rows.map((r) => {
    const name = r.name ? `"${r.name}"` : '';
    return `${r.ref.padEnd(5)}${r.kind.padEnd(10)} ${[name, ...r.bits].filter(Boolean).join('  ')}`.trimEnd();
  });

  const foot = [];
  if (snap.rows.length >= 1) {
    foot.push(
      `${snap.rows.length} element(s)${snap.skipped ? `, ${snap.skipped} hidden or unlabelled` : ''}. ` +
      'Act on these with click/type/fill/select using ref, e.g. click { ref: "e1" }.',
    );
  } else {
    foot.push('Nothing interactive found. The page may still be loading — try wait, or read it with action "text".');
  }
  return [...head, '', ...(lines.length ? lines : ['(no elements)']), '', ...foot].join('\n');
}

/** Scroll an element into view and return its centre in viewport coordinates. */
async function centerOf(page, spec) {
  const box = await page.evaluate(
    `(a) => {
      ${HELPERS}
      const el = __resolve(a);
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      if (r.width < 1 && r.height < 1) throw new Error('Element has no size, so it cannot be clicked');
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height,
               tag: el.tagName.toLowerCase(), name: __name(el) };
    }`,
    spec,
  );
  return box;
}

export async function click(page, spec, { button = 'left', count = 1, settleMs = 250 } = {}) {
  const before = page.url;
  const box = await centerOf(page, spec);
  const common = { x: Math.round(box.x), y: Math.round(box.y), button, clickCount: count };

  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...common, clickCount: 0 });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });

  if (settleMs) await sleep(settleMs);
  const after = await pageInfo(page);
  return { box, navigated: after.url !== before, url: after.url, title: after.title };
}

export async function hover(page, spec) {
  const box = await centerOf(page, spec);
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(box.x),
    y: Math.round(box.y),
  });
  return box;
}

export async function typeText(page, spec, { text, clear = false, pressEnter = false, submit = false }) {
  const box = await page.evaluate(
    `(a) => {
      ${HELPERS}
      const el = __resolve(a);
      const tag = el.tagName.toLowerCase();
      // Focusing a link and "typing" into it silently does nothing, which is
      // a far worse outcome than being told the target was wrong.
      if (!(tag === 'input' || tag === 'textarea' || el.isContentEditable)) {
        throw new Error('<' + tag + '>' + (__name(el) ? ' "' + __name(el) + '"' : '') +
          ' does not accept typing. Pick an input, textarea or contenteditable element' +
          (tag === 'select' ? ' — for a <select> use action "select"' : '') + '.');
      }
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.focus();
      if (a.clear) {
        if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
        else if (el.isContentEditable) el.textContent = '';
      }
      return { tag: el.tagName.toLowerCase(), name: __name(el), focused: document.activeElement === el };
    }`,
    { ...spec, clear },
  );
  if (!box.focused) {
    throw new Error(`Could not focus <${box.tag}>${box.name ? ` "${box.name}"` : ''} — is it disabled or covered?`);
  }

  // insertText is one message for the whole string and fires the input events
  // frameworks listen for; per-key dispatch is only needed for real keystrokes.
  if (text) await page.send('Input.insertText', { text: String(text) });
  if (pressEnter || submit) await pressKey(page, { key: 'Enter' });

  const value = await page.evaluate(
    `() => { const el = document.activeElement; return el && 'value' in el ? String(el.value).slice(0, 200) : null; }`,
  );
  return { ...box, value };
}

export async function pressKey(page, { key, spec = null, settleMs = 0 }) {
  if (spec && (spec.selector || spec.ref || spec.text)) {
    await page.evaluate(`(a) => { ${HELPERS} __resolve(a).focus(); return true; }`, spec);
  }
  const k = parseKey(key);
  const base = {
    modifiers: k.modifiers,
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.keyCode,
    nativeVirtualKeyCode: k.keyCode,
  };
  await page.send('Input.dispatchKeyEvent', {
    type: k.text ? 'keyDown' : 'rawKeyDown',
    ...base,
    text: k.text,
    unmodifiedText: k.text,
  });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  if (settleMs) await sleep(settleMs);
  return { key, modifiers: k.modifiers };
}

export async function selectOption(page, spec, { value = null, label = null, index = null }) {
  return page.evaluate(
    `(a) => {
      ${HELPERS}
      const el = __resolve(a);
      if (el.tagName.toLowerCase() !== 'select') throw new Error('Not a <select>: ' + el.tagName.toLowerCase());
      const opts = [...el.options];
      let opt = null;
      if (a.index !== null && a.index !== undefined) opt = opts[a.index];
      else if (a.value !== null && a.value !== undefined) opt = opts.find((o) => o.value === String(a.value));
      else if (a.label) opt = opts.find((o) => (o.text || '').trim() === a.label) || opts.find((o) => (o.text || '').includes(a.label));
      if (!opt) throw new Error('No matching option. Available: ' + opts.map((o) => o.value + '=' + JSON.stringify(o.text)).join(', '));
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { selected: opt.value, label: (opt.text || '').trim(), name: el.name || el.id || '' };
    }`,
    { ...spec, value, label, index },
  );
}

export async function scroll(page, { spec = null, x = 0, y = 0, to = null }) {
  return page.evaluate(
    `(a) => {
      ${HELPERS}
      if (a.spec && (a.spec.selector || a.spec.ref || a.spec.text)) {
        const el = __resolve(a.spec);
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
      } else if (a.to === 'top') scrollTo(0, 0);
      else if (a.to === 'bottom') scrollTo(0, document.documentElement.scrollHeight);
      else scrollBy(a.x || 0, a.y || 0);
      return { x: Math.round(scrollX), y: Math.round(scrollY),
               height: document.documentElement.scrollHeight, viewport: innerHeight };
    }`,
    { spec, x, y, to },
  );
}

export async function waitFor(page, { selector = null, text = null, gone = false, until = null, ms: waitMs = null, timeoutMs = 15000 }) {
  const started = Date.now();

  if (waitMs) {
    await sleep(waitMs);
    return { waited: Date.now() - started, reason: `${waitMs}ms elapsed` };
  }
  if (until === 'networkidle') {
    const ok = await waitForNetworkIdle(page, { timeoutMs });
    if (!ok) {
      const open = [...page.pending.keys()]
        .map((id) => page.network.find((r) => r.id === id)?.url)
        .filter(Boolean)
        .slice(0, 3);
      throw new Error(
        `Network did not go idle within ${timeoutMs}ms (${page.inflightCount()} request(s) in flight` +
        `${open.length ? `: ${open.map((u) => shortUrl(u, 70)).join(', ')}` : ''}). ` +
        'A page holding a stream open never goes idle — wait for a selector instead.',
      );
    }
    return { waited: Date.now() - started, reason: 'network idle' };
  }
  if (until === 'load' || until === 'domcontentloaded') {
    const want = until === 'load' ? 'complete' : 'interactive';
    while (Date.now() - started < timeoutMs) {
      const ready = await page.evaluate('() => document.readyState');
      if (ready === 'complete' || ready === want) return { waited: Date.now() - started, reason: ready };
      await sleep(100);
    }
    throw new Error(`Page was not ${until} within ${timeoutMs}ms`);
  }

  if (!selector && !text) throw new Error('wait needs one of: selector, text, until, ms');

  while (Date.now() - started < timeoutMs) {
    const found = await page.evaluate(
      `(a) => {
        ${HELPERS}
        try {
          const el = __resolve(a.selector ? { selector: a.selector } : { text: a.text });
          return __vis(el);
        } catch { return false; }
      }`,
      { selector, text },
    );
    if (found !== gone) {
      return {
        waited: Date.now() - started,
        reason: `${selector ? `selector ${selector}` : `text ${JSON.stringify(text)}`} ${gone ? 'gone' : 'present'}`,
      };
    }
    await sleep(120);
  }
  throw new Error(
    `Timed out after ${ms(timeoutMs)} waiting for ${selector ? `selector ${selector}` : `text ${JSON.stringify(text)}`}` +
    `${gone ? ' to disappear' : ''}. Check with action "snapshot".`,
  );
}

export async function evaluate(page, { expression, timeoutMs = 30000 }) {
  const run = (source) =>
    page.send(
      'Runtime.evaluate',
      { expression: source, returnByValue: true, awaitPromise: true, userGesture: true },
      { timeoutMs },
    );

  // Try it as an expression first — `({ a: 1 })`, `document.title`,
  // `fetch(...)` — then fall back to treating it as a function body, which is
  // what `const x = 1; return x` needs. Guessing from the first character
  // cannot tell `({...})` (an object) from `(() => {})` (a function), so ask
  // the JavaScript engine instead of pattern-matching.
  let r = await run(`(async () => (${expression}))()`);
  const syntaxError =
    r.exceptionDetails &&
    /SyntaxError/.test(String(r.exceptionDetails.exception?.className ?? r.exceptionDetails.exception?.description ?? ''));
  if (syntaxError) r = await run(`(async () => { ${expression} })()`);

  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(String(d.exception?.description || d.exception?.value || d.text || 'evaluation failed').split('\n')[0]);
  }
  return r.result?.value;
}

/**
 * Capture the viewport, the whole scrollable page, or one element.
 *
 * `maxWidth` is applied by the browser itself through `clip.scale`, not by
 * resizing afterwards. That matters for two reasons: the renderer produces a
 * properly rasterised image at the target size rather than a downsampled one,
 * and it works for JPEG, which this process cannot resize.
 */
export async function screenshot(page, { fullPage = false, spec = null, format = 'png', quality = null, maxWidth = null } = {}) {
  const params = { format, captureBeyondViewport: false, optimizeForSpeed: false };
  if (format === 'jpeg' || format === 'webp') params.quality = quality ?? 70;

  let area = null;
  if (spec && (spec.selector || spec.ref || spec.text)) {
    area = await page.evaluate(
      `(a) => {
        ${HELPERS}
        const el = __resolve(a);
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
      }`,
      spec,
    );
    if (area.width < 1 || area.height < 1) throw new Error('That element has no visible area to capture');
  } else if (fullPage) {
    const m = await page.send('Page.getLayoutMetrics');
    const size = m.cssContentSize ?? m.contentSize;
    // A runaway infinite-scroll page can report a height of 200,000px, which
    // is neither useful nor capturable.
    area = { x: 0, y: 0, width: size.width, height: Math.min(size.height, 20000) };
  } else if (maxWidth) {
    const m = await page.send('Page.getLayoutMetrics');
    const v = m.cssVisualViewport ?? m.visualViewport;
    area = {
      x: v.pageX ?? 0,
      y: v.pageY ?? 0,
      width: v.clientWidth ?? v.width,
      height: v.clientHeight ?? v.height,
    };
  }

  if (area) {
    const scale = maxWidth && area.width > maxWidth ? maxWidth / area.width : 1;
    params.clip = { ...area, scale };
    params.captureBeyondViewport = true;
  }

  const r = await page.send('Page.captureScreenshot', params, { timeoutMs: 60000 });
  return Buffer.from(r.data, 'base64');
}

export async function printPdf(page, opts = {}) {
  const r = await page.send(
    'Page.printToPDF',
    {
      landscape: Boolean(opts.landscape),
      printBackground: opts.background !== false,
      preferCSSPageSize: true,
      scale: opts.scale ?? 1,
      ...(opts.paperWidth ? { paperWidth: opts.paperWidth, paperHeight: opts.paperHeight } : {}),
    },
    { timeoutMs: 60000 },
  );
  return Buffer.from(r.data, 'base64');
}

export async function saveBuffer(absPath, buf) {
  mkdirSync(path.dirname(absPath), { recursive: true });
  await writeFile(absPath, buf);
  return absPath;
}

export async function getCookies(page, { urls = null } = {}) {
  const r = await page.send('Network.getCookies', urls ? { urls } : {});
  return r.cookies ?? [];
}

export async function setCookie(page, cookie) {
  if (!cookie.name) throw new Error('cookie_set needs "name"');
  const params = { ...cookie };
  if (!params.url && !params.domain) params.url = page.url;
  const r = await page.send('Network.setCookie', params);
  if (r.success === false) throw new Error('The browser rejected that cookie (check domain, path and secure)');
  return params;
}

export async function clearCookies(page) {
  await page.send('Network.clearBrowserCookies');
  return true;
}


/**
 * A filename safe to join onto the download directory.
 *
 * `suggestedFilename` comes from the server — a Content-Disposition header is
 * attacker-controlled input, so a name like `../../.bashrc` has to stop here
 * rather than at whatever writes the file.
 */
export function safeDownloadName(name) {
  const base = path.basename(String(name ?? '').replace(/[\\/]+/g, '/'));
  const cleaned = base
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || 'download';
}

/** The given path, or the next free "name (2).ext" beside it. */
export async function uniquePath(target) {
  if (!existsSync(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const stem = path.basename(target, ext);
  for (let n = 2; n < 1000; n++) {
    const candidate = path.join(dir, `${stem} (${n})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${stem} (${Date.now()})${ext}`);
}

/**
 * Start a download by going to a URL.
 *
 * A URL whose response is a download aborts the navigation by design: Chromium
 * hands the bytes to the download manager and the renderer never commits a
 * document. So net::ERR_ABORTED is the expected outcome here, not a failure —
 * which is exactly why `navigate` reports one and downloads looked blocked.
 */
export async function navigateForDownload(page, url, { timeoutMs = 30000 } = {}) {
  const target = normalizeUrl(url);
  try {
    const res = await page.send('Page.navigate', { url: target }, { timeoutMs });
    if (res.errorText && !/ERR_ABORTED/i.test(res.errorText)) {
      throw new Error(`Could not open ${target}: ${res.errorText}`);
    }
  } catch (err) {
    if (!/ERR_ABORTED/i.test(err.message)) throw err;
  }
  return target;
}
