// Group: browser — drive a real browser over the DevTools Protocol.
//
// One tool, dispatched on `action`, for the same reason the rest of this
// server works that way: thirty separate tools would sit in the model's
// context on every single request.
//
// The intended loop is snapshot → act by ref → snapshot, not "download the
// HTML and hope". `snapshot` is a few hundred tokens; the HTML of a modern
// web app is tens of thousands.

import path from 'node:path';
import { PolicyError, resolveSafePath, assertCommandAllowed } from '../guards.js';
import { imageSize, toImageContent } from '../image.js';
import { ms, truncateMiddle } from '../format.js';
import {
  BrowserManager,
  clearCookies,
  click,
  evaluate,
  getCookies,
  getHtml,
  getText,
  hover,
  navigate,
  navigateForDownload,
  pageInfo,
  pressKey,
  printPdf,
  reload,
  renderSnapshot,
  saveBuffer,
  screenshot,
  scroll,
  selectOption,
  setCookie,
  shortUrl,
  snapshot,
  typeText,
  waitFor,
} from '../browser.js';

export const TOOLS = [
  {
    name: 'browser',
    description:
      'Drive a real Chromium browser (Chrome/Edge/Brave) over the DevTools Protocol. ' +
      'launch starts one; attach connects to a browser already running with ' +
      '--remote-debugging-port, so you get the user\'s own profile, logins and extensions. ' +
      'READ A PAGE WITH snapshot: it returns a compact list of every element you can act on, ' +
      'each with a ref, for a fraction of the tokens the HTML would cost — then click/type/select ' +
      'by ref. Use html only when you actually need the markup. Also: navigate, text, eval, wait, ' +
      'screenshot (viewport, full page or one element, viewable inline), pdf, cookies, console and ' +
      'network logs, and tabs. download fetches a file using the session the browser already has — from a URL, a link or a button — and waits for it to finish, so anything behind a login comes down without signing in again.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'launch', 'attach', 'status', 'close',
            'tabs', 'tab_new', 'tab_select', 'tab_close',
            'navigate', 'back', 'forward', 'reload',
            'snapshot', 'html', 'text', 'eval',
            'click', 'type', 'fill', 'press', 'hover', 'scroll', 'select',
            'wait', 'screenshot', 'pdf',
            'cookies', 'cookie_set', 'cookies_clear',
            'console', 'network', 'resize',
            'download', 'downloads',
          ],
          description: 'What to do.',
        },
        url: { type: 'string', description: 'navigate/tab_new: where to go. A bare host gets https://, an absolute path gets file://.' },
        selector: { type: 'string', description: 'CSS selector for the element to act on, or to scope html/text/snapshot.' },
        ref: { type: 'string', description: 'Element ref from the last snapshot, e.g. "e12". Cheaper and sturdier than a selector.' },
        text: { type: 'string', description: 'type/fill: what to type. click/hover: find the element by its visible text. wait: wait for this text.' },
        tab: { type: 'string', description: 'Act on this tab id instead of the active one (see action "tabs").' },
        value: { type: 'string', description: 'select: option value to choose.' },
        label: { type: 'string', description: 'select: option label to choose instead of a value.' },
        index: { type: 'integer', description: 'select: option position. tab_select: tab position, if you have no id.' },
        key: { type: 'string', description: 'press: a key, with optional modifiers — "Enter", "Tab", "Escape", "Control+A", "F5".' },
        expression: { type: 'string', description: 'eval: JavaScript to run in the page. Awaited if it returns a promise.' },
        clear: { type: 'boolean', description: 'type: empty the field first. console/network: drop the entries after returning them.' },
        press_enter: { type: 'boolean', description: 'type: press Enter afterwards — submits most forms in one call.' },
        button: { type: 'string', enum: ['left', 'middle', 'right'], description: 'click: which mouse button. Default left.' },
        count: { type: 'integer', description: 'click: click count — 2 for a double click. Default 1.' },
        x: { type: 'integer', description: 'scroll: horizontal delta in pixels.' },
        y: { type: 'integer', description: 'scroll: vertical delta in pixels.' },
        to: { type: 'string', enum: ['top', 'bottom'], description: 'scroll: jump to one end of the page.' },
        full_page: { type: 'boolean', description: 'screenshot: capture the whole scrollable page, not just the viewport.' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'screenshot: image format. Default png.' },
        quality: { type: 'integer', description: 'screenshot: jpeg quality 1-100. Default 70.' },
        max_width: { type: 'integer', description: 'screenshot: scale down to at most this many pixels wide before returning. Image cost is pixels, so this is the token dial. Default 1200.' },
        view: { type: 'boolean', description: 'screenshot: attach the image to the reply so you can see it. Default true. false saves it and returns only the path.' },
        path: { type: 'string', description: 'screenshot/pdf: where to save. Default: a timestamped file under .terminalmcp/shots/.' },
        save: { type: 'boolean', description: 'screenshot: write a file as well as viewing it. Default true.' },
        landscape: { type: 'boolean', description: 'pdf: landscape orientation.' },
        clean: { type: 'boolean', description: 'html: strip scripts, styles, svg and comments and collapse whitespace. Much cheaper to read.' },
        all: { type: 'boolean', description: 'snapshot: include images, tables and forms too, not just interactive elements.' },
        max: { type: 'integer', description: 'snapshot: element cap. Default 200. console/network: entry cap. Default 50.' },
        gone: { type: 'boolean', description: 'wait: wait for the selector or text to disappear instead of appear.' },
        until: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'], description: 'wait: wait for a page lifecycle state.' },
        ms: { type: 'integer', description: 'wait: just sleep this many milliseconds.' },
        wait_until: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle', 'none'], description: 'navigate/reload: what to wait for. Default load.' },
        timeout_ms: { type: 'integer', description: 'Per-action timeout. Default 30000 for navigation, 15000 for wait.' },
        cookie: { type: 'object', description: 'cookie_set: { name, value, domain, path, secure, httpOnly, expires }.' },
        level: { type: 'string', description: 'console: only entries of this level (log, warning, error, exception).' },
        filter: { type: 'string', description: 'network: only requests whose URL contains this.' },
        failed: { type: 'boolean', description: 'network: only failures and 4xx/5xx responses — the usual reason to look.' },
        width: { type: 'integer', description: 'launch/resize: viewport width.' },
        height: { type: 'integer', description: 'launch/resize: viewport height.' },
        headless: { type: 'boolean', description: 'launch: run with no visible window. Default true.' },
        browser_path: { type: 'string', description: 'launch: path to a specific browser binary.' },
        user_data_dir: { type: 'string', description: 'launch: profile directory to use, so logins persist between runs. Default: a throwaway temp profile.' },
        port: { type: 'integer', description: 'attach: debugging port. Default: try 9222 and a few others. launch: fix the port instead of letting the browser choose.' },
        host: { type: 'string', description: 'attach: host running the browser. Default 127.0.0.1.' },
        args: { type: 'array', items: { type: 'string' }, description: 'launch: extra browser command-line flags.' },
        max_bytes: { type: 'integer', description: 'Byte cap on returned text.' },
        wait: { type: 'boolean', description: 'downloads: block until the ones in flight finish. Default false.' },
      },
      required: ['action'],
    },
  },
];

/**
 * One browser per process, like the job registry: this server drives one
 * machine, and "which of the four browsers did you mean" is a worse API than
 * "the browser".
 */
let manager = null;

function getManager(cfg) {
  if (!manager) manager = new BrowserManager(cfg);
  return manager;
}

/** Async, graceful: used by the `close` action. */
export async function closeBrowser() {
  if (!manager) return false;
  const closed = await manager.close();
  manager = null;
  return closed;
}

/**
 * Synchronous, blunt: used on server shutdown, where there is no time to
 * await anything. A browser we launched must not outlive us.
 */
export function killBrowserSync() {
  const child = manager?.handle?.child;
  if (!child || child.exitCode !== null) return 0;
  try {
    child.kill('SIGKILL');
    return 1;
  } catch {
    return 0;
  }
}

function spec(a) {
  return { selector: a.selector ?? null, ref: a.ref ?? null, text: a.text ?? null };
}

function hasTarget(a) {
  return Boolean(a.selector || a.ref || a.text);
}

function requireTarget(a, action) {
  if (!hasTarget(a)) {
    throw new Error(`${action} needs one of: ref (from snapshot), selector, or text`);
  }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function defaultShotPath(cfg, ext) {
  const dir = cfg.screenshots?.dir ?? path.join(cfg.cwd, '.terminalmcp', 'shots');
  return path.join(dir, `${stamp()}.${ext}`);
}

/** Save-and-or-view, shared by browser screenshots and PDFs. */
async function deliverImage(cfg, buf, a, { ext = 'png', kind = 'screenshot', extraNote = null } = {}) {
  const view = a.view !== false;
  const wantSave = a.save !== false || Boolean(a.path);
  const lines = [];
  let saved = null;

  if (wantSave) {
    if (cfg.readOnly && a.path) {
      throw new PolicyError('readOnly is on, so the file cannot be written. Use view:true, save:false to look at it without saving.');
    }
    if (!cfg.readOnly) {
      const abs = resolveSafePath(cfg, a.path ?? defaultShotPath(cfg, ext), { forWrite: true });
      saved = await saveBuffer(abs, buf);
      const size = imageSize(buf);
      lines.push(`saved ${saved} (${buf.length} bytes${size ? `, ${size.width}x${size.height}` : ''})`);
      if (extraNote) lines.push(extraNote);
    } else {
      lines.push('not saved: readOnly is on');
    }
  }

  const images = [];
  if (view && ext !== 'pdf') {
    const { block, note } = toImageContent(buf, {
      filename: saved ?? `${kind}.${ext}`,
      maxWidth: a.max_width ?? cfg.screenshots?.maxWidth ?? 1200,
      maxHeight: cfg.screenshots?.maxHeight ?? 1600,
      maxBytes: cfg.screenshots?.maxImageBytes ?? 5 * 1024 * 1024,
    });
    images.push(block);
    lines.push(note);
  } else if (view && ext === 'pdf') {
    lines.push('a PDF cannot be viewed inline; read it with the pdf tooling of your choice');
  }

  return { text: lines.join('\n'), images };
}

export function createHandlers({ cfg }) {
  const timeout = (a, fallback) => a.timeout_ms ?? fallback;

  return {
    async browser(a) {
      const action = a.action;
      if (!action) throw new Error('browser needs "action"');
      const mgr = getManager(cfg);
      const cap = a.max_bytes ?? cfg.maxOutputBytes;

      switch (action) {
        // ------------------------------------------------------ lifecycle
        case 'launch': {
          if (cfg.readOnly) {
            throw new PolicyError('readOnly is on, so no browser process will be started. Use action "attach" to drive one that is already running.');
          }
          const exe = a.browser_path ?? cfg.browser?.executable ?? null;
          if (exe) assertCommandAllowed(cfg, exe);

          const viewport = {
            width: a.width ?? cfg.browser?.viewport?.width ?? 1280,
            height: a.height ?? cfg.browser?.viewport?.height ?? 800,
          };
          const res = await mgr.start('launch', {
            executable: exe,
            headless: a.headless ?? cfg.browser?.headless ?? true,
            port: a.port ?? cfg.browser?.port ?? 0,
            userDataDir: a.user_data_dir ?? cfg.browser?.userDataDir ?? null,
            args: a.args ?? [],
            viewport,
            timeoutMs: timeout(a, 30000),
          });
          if (res.reused) {
            return `A browser is already running (${res.version}, ${res.tabs} tab(s)). Close it first if you want different options.\n${renderStatus(res)}`;
          }
          if (a.url) {
            const page = mgr.page();
            const nav = await navigate(page, { url: a.url, waitUntil: a.wait_until ?? 'load', timeoutMs: timeout(a, 30000) });
            return `${renderStatus(res)}\n${renderNav(nav)}`;
          }
          return renderStatus(res);
        }

        case 'attach': {
          const res = await mgr.start('attach', { host: a.host, port: a.port });
          return res.reused
            ? `Already connected.\n${renderStatus(res)}`
            : `${renderStatus(res)}\nThis is someone's real browser: its profile, cookies and logins are live. Closing it is not something this tool will do for you.`;
        }

        case 'status': {
          if (!mgr.running) {
            return 'No browser running. Use action "launch", or "attach" for a browser started with --remote-debugging-port=9222.';
          }
          await mgr.syncTargets();
          const d = mgr.describe();
          return `${renderStatus(d)}\n\n${renderTabs(mgr)}`;
        }

        case 'close': {
          const closed = await closeBrowser();
          return closed ? 'Browser closed.' : 'No browser was running.';
        }

        // ------------------------------------------------------------ tabs
        case 'tabs': {
          mgr.assertRunning();
          await mgr.syncTargets();
          return renderTabs(mgr);
        }

        case 'tab_new': {
          mgr.assertRunning();
          const page = await mgr.newPage('about:blank');
          if (a.url) {
            const nav = await navigate(page, { url: a.url, waitUntil: a.wait_until ?? 'load', timeoutMs: timeout(a, 30000) });
            return `new tab ${page.targetId} (now active)\n${renderNav(nav)}`;
          }
          return `new tab ${page.targetId} (now active), about:blank`;
        }

        case 'tab_select': {
          mgr.assertRunning();
          await mgr.syncTargets();
          const ids = [...mgr.pages.keys()];
          const id = a.tab ?? (a.index !== undefined ? ids[a.index] : null);
          if (!id) throw new Error('tab_select needs "tab" (an id) or "index"');
          const page = mgr.page(id);
          mgr.activeId = page.targetId;
          await page.send('Page.bringToFront').catch(() => {});
          const info = await pageInfo(page);
          return `active tab is now ${page.targetId}\n${shortUrl(info.url)}  —  ${info.title}`;
        }

        case 'tab_close': {
          mgr.assertRunning();
          const id = await mgr.closePage(a.tab ?? null);
          return `closed tab ${id}. ${mgr.pages.size} tab(s) left${mgr.activeId ? `, active is ${mgr.activeId}` : ''}.`;
        }

        // ------------------------------------------------------ navigation
        case 'navigate': {
          const page = mgr.page(a.tab ?? null);
          const since = mgr.downloadSeq;
          try {
            const nav = await navigate(page, {
              url: a.url,
              waitUntil: a.wait_until ?? 'load',
              timeoutMs: timeout(a, 30000),
            });
            return renderNav(nav);
          } catch (err) {
            // A URL that is a file aborts its own navigation: Chromium gives
            // the response to the download manager and no document is ever
            // committed. Reporting that as a failed navigation is how a
            // perfectly good download came to look blocked.
            if (!/ERR_ABORTED/i.test(err.message)) throw err;
            const got = await mgr.waitForDownloads({ since, timeoutMs: 5000 });
            if (!got) throw err;
            return `that URL is a download, not a page\n${renderDownloads(got, mgr)}`;
          }
        }

        case 'back':
        case 'forward': {
          const page = mgr.page(a.tab ?? null);
          const { currentIndex, entries } = await page.send('Page.getNavigationHistory');
          const want = currentIndex + (action === 'back' ? -1 : 1);
          if (!entries[want]) return `Nothing to go ${action === 'back' ? 'back' : 'forward'} to.`;
          await page.send('Page.navigateToHistoryEntry', { entryId: entries[want].id });
          await new Promise((r) => setTimeout(r, 400));
          const info = await pageInfo(page);
          return `${action} → ${shortUrl(info.url)}\n${info.title}`;
        }

        case 'reload': {
          const page = mgr.page(a.tab ?? null);
          const info = await reload(page, {
            ignoreCache: Boolean(a.clear),
            waitUntil: a.wait_until ?? 'load',
            timeoutMs: timeout(a, 30000),
          });
          return (
            `reloaded ${shortUrl(info.url)}\n${info.title}` +
            `${info.timedOut ? '\nthe load event did not fire in time; the page may still be usable' : ''}`
          );
        }

        case 'resize': {
          const page = mgr.page(a.tab ?? null);
          const width = a.width ?? 1280;
          const height = a.height ?? 800;
          await page.send('Emulation.setDeviceMetricsOverride', {
            width,
            height,
            deviceScaleFactor: 1,
            mobile: false,
          });
          return `viewport is now ${width}x${height}`;
        }

        // ------------------------------------------------------- reading
        case 'snapshot': {
          const page = mgr.page(a.tab ?? null);
          const snap = await snapshot(page, {
            selector: a.selector ?? null,
            max: a.max ?? 200,
            all: Boolean(a.all),
          });
          return truncateMiddle(renderSnapshot(snap), cap).text;
        }

        case 'html': {
          const page = mgr.page(a.tab ?? null);
          const r = await getHtml(page, { selector: a.selector ?? null, clean: Boolean(a.clean), maxBytes: cap });
          return `${r.bytes} bytes of HTML${r.truncated ? ' (truncated)' : ''}${a.clean ? ', cleaned' : ''}\n${r.html}`;
        }

        case 'text': {
          const page = mgr.page(a.tab ?? null);
          const r = await getText(page, { selector: a.selector ?? null, maxBytes: cap });
          const info = await pageInfo(page);
          return `${shortUrl(info.url)}  —  ${info.title}\n\n${r.text}${r.truncated ? '\n[truncated]' : ''}`;
        }

        case 'eval': {
          if (!a.expression) throw new Error('eval needs "expression"');
          const page = mgr.page(a.tab ?? null);
          const value = await evaluate(page, { expression: a.expression, timeoutMs: timeout(a, 30000) });
          if (value === undefined) return 'undefined';
          const out = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
          return truncateMiddle(String(out), cap).text;
        }

        // ------------------------------------------------------ interaction
        case 'click': {
          requireTarget(a, 'click');
          const page = mgr.page(a.tab ?? null);
          const r = await click(page, spec(a), {
            button: a.button ?? 'left',
            count: a.count ?? 1,
          });
          return (
            `clicked <${r.box.tag}>${r.box.name ? ` "${r.box.name}"` : ''}` +
            `${r.navigated ? `\nnavigated to ${shortUrl(r.url)}\n${r.title}` : `\nstill on ${shortUrl(r.url)}`}`
          );
        }

        case 'type':
        case 'fill': {
          requireTarget(a, action);
          if (a.text === undefined || a.text === null) throw new Error(`${action} needs "text"`);
          const page = mgr.page(a.tab ?? null);
          // The only difference: fill replaces, type appends.
          const r = await typeText(page, spec(a), {
            text: a.text,
            clear: action === 'fill' ? a.clear !== false : Boolean(a.clear),
            pressEnter: Boolean(a.press_enter),
          });
          return (
            `${action === 'fill' ? 'filled' : 'typed into'} <${r.tag}>${r.name ? ` "${r.name}"` : ''}` +
            `${r.value !== null ? `, value is now ${JSON.stringify(r.value)}` : ''}` +
            `${a.press_enter ? ' (pressed Enter)' : ''}`
          );
        }

        case 'press': {
          if (!a.key) throw new Error('press needs "key"');
          const page = mgr.page(a.tab ?? null);
          const before = page.url;
          await pressKey(page, { key: a.key, spec: hasTarget(a) ? spec(a) : null, settleMs: 200 });
          const info = await pageInfo(page);
          return `pressed ${a.key}${info.url !== before ? `\nnavigated to ${shortUrl(info.url)}` : ''}`;
        }

        case 'hover': {
          requireTarget(a, 'hover');
          const page = mgr.page(a.tab ?? null);
          const box = await hover(page, spec(a));
          return `hovering <${box.tag}>${box.name ? ` "${box.name}"` : ''}`;
        }

        case 'scroll': {
          const page = mgr.page(a.tab ?? null);
          const r = await scroll(page, {
            spec: hasTarget(a) ? spec(a) : null,
            x: a.x ?? 0,
            y: a.y ?? (a.to || hasTarget(a) ? 0 : 600),
            to: a.to ?? null,
          });
          return `scrolled to y=${r.y} of ${r.height} (viewport ${r.viewport}px)`;
        }

        case 'select': {
          requireTarget(a, 'select');
          const page = mgr.page(a.tab ?? null);
          const r = await selectOption(page, spec(a), {
            value: a.value ?? null,
            label: a.label ?? null,
            index: a.index ?? null,
          });
          return `selected ${JSON.stringify(r.selected)}${r.label ? ` (${r.label})` : ''}${r.name ? ` in ${r.name}` : ''}`;
        }

        case 'wait': {
          const page = mgr.page(a.tab ?? null);
          const r = await waitFor(page, {
            selector: a.selector ?? null,
            text: a.text ?? null,
            gone: Boolean(a.gone),
            until: a.until ?? null,
            ms: a.ms ?? null,
            timeoutMs: timeout(a, 15000),
          });
          return `waited ${ms(r.waited)}: ${r.reason}`;
        }

        // ------------------------------------------------------- capture
        case 'screenshot': {
          const page = mgr.page(a.tab ?? null);
          const format = a.format ?? 'png';
          const maxWidth = a.max_width ?? cfg.screenshots?.maxWidth ?? 1200;
          // PNG is captured at full size and scaled down only for viewing, so
          // the file left on disk is the good copy. JPEG cannot be resized in
          // process, so there the renderer has to do it — which also scales
          // the saved file, and that is worth saying out loud.
          const scaleAtSource = format !== 'png';
          const buf = await screenshot(page, {
            fullPage: Boolean(a.full_page),
            spec: hasTarget(a) ? spec(a) : null,
            format,
            quality: a.quality ?? null,
            maxWidth: scaleAtSource ? maxWidth : null,
          });
          const info = await pageInfo(page);
          const what = hasTarget(a) ? 'element' : a.full_page ? 'full page' : 'viewport';
          const out = await deliverImage(cfg, buf, a, {
            ext: format === 'jpeg' ? 'jpg' : 'png',
            extraNote: scaleAtSource
              ? `scaled to ${maxWidth}px wide by the renderer: jpeg cannot be resized in-process, so the file is scaled too`
              : null,
          });
          return { text: `${what} of ${shortUrl(info.url)}\n${out.text}`, images: out.images };
        }

        case 'pdf': {
          const page = mgr.page(a.tab ?? null);
          const buf = await printPdf(page, {
            landscape: Boolean(a.landscape),
            background: true,
            scale: 1,
          });
          if (cfg.readOnly) throw new PolicyError('readOnly is on, so the PDF cannot be written');
          const abs = resolveSafePath(cfg, a.path ?? defaultShotPath(cfg, 'pdf'), { forWrite: true });
          await saveBuffer(abs, buf);
          const info = await pageInfo(page);
          return `saved ${abs} (${buf.length} bytes) from ${shortUrl(info.url)}`;
        }

        // -------------------------------------------------- state and logs
        case 'cookies': {
          const page = mgr.page(a.tab ?? null);
          const cookies = await getCookies(page);
          if (!cookies.length) return 'No cookies.';
          const rows = cookies
            .filter((c) => !a.filter || c.name.includes(a.filter) || c.domain.includes(a.filter))
            .map(
              (c) =>
                `${c.name}=${String(c.value).length > 40 ? `${String(c.value).slice(0, 37)}...` : c.value}  ` +
                `${c.domain}${c.path !== '/' ? c.path : ''}` +
                `${c.httpOnly ? ' httpOnly' : ''}${c.secure ? ' secure' : ''}` +
                `${c.expires > 0 ? ` expires=${new Date(c.expires * 1000).toISOString().slice(0, 16)}` : ' session'}`,
            );
          return `${rows.length} cookie(s)\n${truncateMiddle(rows.join('\n'), cap).text}`;
        }

        case 'cookie_set': {
          const page = mgr.page(a.tab ?? null);
          const c = await setCookie(page, a.cookie ?? {});
          return `set cookie ${c.name} for ${c.domain ?? c.url}`;
        }

        case 'cookies_clear': {
          const page = mgr.page(a.tab ?? null);
          await clearCookies(page);
          return 'Cleared all browser cookies.';
        }

        case 'console': {
          const page = mgr.page(a.tab ?? null);
          let entries = page.console;
          if (a.level) entries = entries.filter((e) => e.level === a.level);
          const max = a.max ?? 50;
          const shown = entries.slice(-max);
          if (a.clear) page.console.length = 0;
          if (!shown.length) return `No console output${a.level ? ` at level ${a.level}` : ''}.`;
          const rows = shown.map((e) => `${e.level.padEnd(9)} ${e.text}`);
          return (
            `${shown.length} of ${entries.length} console entr(ies)\n` +
            truncateMiddle(rows.join('\n'), cap).text
          );
        }

        case 'network': {
          const page = mgr.page(a.tab ?? null);
          let rows = page.network;
          if (a.filter) rows = rows.filter((r) => r.url.includes(a.filter));
          if (a.failed) rows = rows.filter((r) => r.status === 'failed' || (typeof r.status === 'number' && r.status >= 400));
          const max = a.max ?? 50;
          const shown = rows.slice(-max);
          if (a.clear) page.network.length = 0;
          if (!shown.length) return `No matching requests${a.failed ? ' (nothing failed)' : ''}.`;
          const lines = shown.map((r) => {
            const status = r.status === null ? 'pending' : String(r.status);
            const url = r.url.length > 110 ? `${r.url.slice(0, 107)}...` : r.url;
            return `${status.padEnd(8)}${r.method.padEnd(6)}${(r.type || '').padEnd(11)}${r.ms !== undefined ? `${String(r.ms).padStart(6)}ms ` : '        '}${url}${r.error ? `  ${r.error}` : ''}`;
          });
          return (
            `${shown.length} of ${rows.length} request(s)${page.inflight ? `, ${page.inflight} in flight` : ''}\n` +
            truncateMiddle(lines.join('\n'), cap).text
          );
        }

        case 'download': {
          // Three ways a download starts, and all three end the same way:
          // a URL to open, an element to click, or something the page is
          // already doing that we only need to wait for.
          const since = mgr.downloadSeq;
          const timeoutMs = a.timeout_ms ?? 120000;
          let how;
          if (a.url) {
            const page = mgr.page(a.tab ?? null);
            how = `opened ${shortUrl(await navigateForDownload(page, a.url, { timeoutMs: 30000 }))}`;
          } else if (a.ref || a.selector || a.text) {
            const page = mgr.page(a.tab ?? null);
            const r = await click(page, spec(a), { button: a.button ?? 'left', count: a.count ?? 1 });
            how = `clicked <${r.box.tag}>${r.box.name ? ` "${r.box.name}"` : ''}`;
          } else {
            how = 'waited for whatever the page had already started';
          }

          const got = await mgr.waitForDownloads({ since, timeoutMs });
          if (!got) {
            return (
              `${how}, but no download started within ${ms(timeoutMs)}.\n` +
              `${mgr.downloadEvents
                ? 'The browser reported no download at all, so that URL or element probably rendered a page instead — ' +
                  'check action "network" for what came back.'
                : `This browser would not report downloads (${mgr.downloadError ?? 'setDownloadBehavior refused'}), ` +
                  `so nothing can be waited on here. Look in ${mgr.downloadDir()} yourself.`}`
            );
          }
          return `${how}\n${renderDownloads(got, mgr)}`;
        }

        case 'downloads': {
          if (a.wait) {
            const pending = mgr.pendingDownloads();
            if (pending.length) {
              await mgr.waitForDownloads({
                since: Math.min(...pending.map((d) => d.index)) - 1,
                timeoutMs: a.timeout_ms ?? 120000,
              });
            }
          }
          const all = mgr.downloadList();
          if (!all.length) {
            return (
              `No downloads yet. Files go to ${mgr.downloadDir()}.\n` +
              `${mgr.downloadEvents
                ? 'Start one with action "download" (a url, or a ref/selector to click).'
                : `This browser refused to report downloads: ${mgr.downloadError ?? 'unknown reason'}`}`
            );
          }
          return renderDownloads(all, mgr);
        }

        default:
          throw new Error(
            `Unknown browser action "${action}". See the action enum; start with launch or attach, ` +
            'then navigate and snapshot.',
          );
      }
    },
  };
}

/** One line per download: state, size, name, and where it landed. */
function renderDownloads(list, mgr) {
  const lines = list.map((d) => {
    const size = d.total ? `${fmtBytes(d.received)}/${fmtBytes(d.total)}` : fmtBytes(d.received);
    const took = d.endedAt ? ` in ${ms(d.endedAt - d.startedAt)}` : '';
    const where = d.path ? `\n      -> ${d.path}` : '';
    const why = d.error ? `  (${d.error})` : '';
    return `  ${String(d.index).padEnd(4)}${d.state.padEnd(12)}${size.padEnd(18)}${d.name}${took}${why}${where}`;
  });
  const done = list.filter((d) => d.state === 'completed').length;
  return (
    `${list.length} download(s), ${done} completed, saved under ${mgr.downloadDir()}\n` +
    `${lines.join('\n')}`
  );
}

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function renderStatus(d) {
  if (!d.running) return 'No browser running.';
  return [
    `${d.version ?? 'browser'} — ${d.kind}${d.attached ? ' (attached to a browser you started)' : d.headless ? ' (headless)' : ' (windowed)'}`,
    `exe      ${d.exe}${d.source ? `  [${d.source}]` : ''}`,
    `port     ${d.port}`,
    `tabs     ${d.tabs}${d.active ? `, active ${d.active}` : ''}`,
    d.profile ? `profile  ${d.profile}${d.tempProfile ? ' (temporary)' : ''}` : null,
    `up       ${ms(d.uptimeMs)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function renderTabs(mgr) {
  if (!mgr.pages.size) return 'No tabs open.';
  const rows = [...mgr.pages.values()].map(
    (p) =>
      `${p.targetId === mgr.activeId ? '*' : ' '} ${p.targetId}  ${p.url.length > 90 ? `${p.url.slice(0, 87)}...` : p.url}` +
      `${p.title ? `  —  ${p.title}` : ''}`,
  );
  return `${mgr.pages.size} tab(s), * is active\n${rows.join('\n')}`;
}

function renderNav(nav) {
  return (
    `${shortUrl(nav.url)}\n${nav.title || '(no title)'}\n` +
    `${nav.ready}, ${ms(nav.ms)}${nav.timedOut ? ' (load event did not fire in time; the page may still be usable)' : ''}` +
    `${nav.sh && nav.h && nav.sh > nav.h * 1.2 ? `, page is ${nav.sh}px tall in a ${nav.h}px viewport` : ''}`
  );
}
