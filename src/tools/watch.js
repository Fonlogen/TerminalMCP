// Group: watch — observe paths for changes.
//
// Shaped like shell_job on purpose: start a watcher, then poll it with one
// blocking call instead of re-listing a directory in a loop.

import { watch as fsWatch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolveSafePath } from '../guards.js';
import { compileGlobList } from '../glob.js';
import { truncateMiddle, ms } from '../format.js';

const MAX_WATCHERS = 16;
const MAX_EVENTS = 2000;

export const TOOLS = [
  {
    name: 'watch',
    description:
      'Watch a file or directory for changes. start returns a watch_id; poll blocks up to wait_ms ' +
      'for new events and returns them (so one call replaces a polling loop); list shows active ' +
      'watchers; stop ends one. Events are coalesced per path, so a save that fires three times ' +
      'is reported once.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'poll', 'list', 'stop'], description: 'What to do.' },
        path: { type: 'string', description: 'start: file or directory to watch.' },
        watch_id: { type: 'string', description: 'poll/stop: which watcher.' },
        recursive: { type: 'boolean', description: 'start: watch subdirectories. Default true.' },
        glob: { type: 'array', items: { type: 'string' }, description: 'start: only report paths matching these globs.' },
        exclude: { type: 'array', items: { type: 'string' }, description: 'start: ignore paths matching these globs.' },
        wait_ms: { type: 'integer', description: 'poll: block up to this long for the first event. Default 0 (return at once).' },
        settle_ms: { type: 'integer', description: 'poll: after the first event, wait this long for related ones before returning. Default 300.' },
        clear: { type: 'boolean', description: 'poll: drop the returned events from the buffer. Default true.' },
        max_bytes: { type: 'integer', description: 'Byte cap on returned output.' },
      },
      required: ['action'],
    },
  },
];

let counter = 0;
const watchers = new Map();

function stopWatcher(entry) {
  try {
    entry.handle.close();
  } catch {
    /* already closed */
  }
  watchers.delete(entry.id);
}

export function createHandlers({ cfg }) {
  return {
    async watch(p) {
      const a = p.action;
      const cap = p.max_bytes ?? cfg.maxOutputBytes;

      if (a === 'list') {
        if (!watchers.size) return 'No active watchers.';
        return [...watchers.values()]
          .map(
            (w) =>
              `${w.id} ${w.path}${w.recursive ? ' (recursive)' : ''} — ` +
              `${w.events.length} pending event(s), ${w.total} total, up ${ms(Date.now() - w.startedAt)}` +
              `${w.error ? ` ERROR: ${w.error}` : ''}`,
          )
          .join('\n');
      }

      if (a === 'start') {
        if (!p.path) throw new Error('start needs "path"');
        const abs = resolveSafePath(cfg, p.path);
        const st = await stat(abs).catch(() => null);
        if (!st) throw new Error(`Not found: ${abs}`);

        if (watchers.size >= MAX_WATCHERS) {
          throw new Error(`Too many watchers (${watchers.size}/${MAX_WATCHERS}). Stop one first.`);
        }

        const recursive = p.recursive !== false && st.isDirectory();
        const include = compileGlobList(p.glob);
        const exclude = compileGlobList(p.exclude);
        const hasExclude = Boolean(p.exclude?.length);

        const id = `watch${++counter}`;
        const entry = {
          id,
          path: abs,
          recursive,
          events: [],
          total: 0,
          startedAt: Date.now(),
          error: null,
          waiters: [],
          seen: new Map(),
        };

        let handle;
        try {
          handle = fsWatch(abs, { recursive, persistent: false }, (eventType, filename) => {
            const rel = filename ? String(filename).replace(/\\/g, '/') : '';
            if (rel) {
              if (!include(rel)) return;
              if (hasExclude && exclude(rel)) return;
            }
            const now = Date.now();
            // Editors fire several events per save; collapse them per path.
            const last = entry.seen.get(rel) ?? 0;
            entry.seen.set(rel, now);
            entry.total++;
            if (now - last < 120) return;

            entry.events.push({ at: now, type: eventType, path: rel || '(watched path)' });
            if (entry.events.length > MAX_EVENTS) entry.events.splice(0, entry.events.length - MAX_EVENTS);
            for (const w of entry.waiters.splice(0)) w();
          });
        } catch (err) {
          // recursive:true is unsupported on some platforms/filesystems.
          if (recursive && /ERR_FEATURE_UNAVAILABLE|not supported|ENOSYS/i.test(err.message)) {
            throw new Error(
              `Recursive watching is not available here (${err.message}). ` +
              `Retry with recursive:false, or watch a single directory.`,
            );
          }
          throw err;
        }

        handle.on('error', (err) => { entry.error = err.message; });
        entry.handle = handle;
        watchers.set(id, entry);

        return (
          `watch_id=${id} watching ${abs}${recursive ? ' recursively' : ''}` +
          `${p.glob?.length ? ` filter ${p.glob.join(', ')}` : ''}\n` +
          `Read with watch {action:"poll", watch_id:"${id}", wait_ms:30000}`
        );
      }

      if (a === 'stop') {
        if (!p.watch_id) throw new Error('stop needs "watch_id"');
        const entry = watchers.get(p.watch_id);
        if (!entry) return `${p.watch_id} is not an active watcher.`;
        stopWatcher(entry);
        return `${p.watch_id} stopped (${entry.total} event(s) seen).`;
      }

      if (a === 'poll') {
        if (!p.watch_id) throw new Error('poll needs "watch_id"');
        const entry = watchers.get(p.watch_id);
        if (!entry) {
          const ids = [...watchers.keys()];
          throw new Error(
            `Unknown watch_id "${p.watch_id}".` + (ids.length ? ` Active: ${ids.join(', ')}` : ' No watchers are running.'),
          );
        }

        const waitMs = p.wait_ms ?? 0;
        if (!entry.events.length && waitMs > 0) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, waitMs);
            entry.waiters.push(() => { clearTimeout(timer); resolve(); });
          });
        }
        // Let a burst finish before reporting, so one save reads as one change.
        const settle = p.settle_ms ?? 300;
        if (entry.events.length && settle > 0) await new Promise((r) => setTimeout(r, settle));

        const events = [...entry.events];
        if (p.clear !== false) entry.events.length = 0;

        if (!events.length) {
          return (
            `${entry.id} no changes${waitMs ? ` in ${ms(waitMs)}` : ''} ` +
            `(watching ${entry.path}, ${entry.total} event(s) since start)` +
            `${entry.error ? `\nwatcher error: ${entry.error}` : ''}`
          );
        }

        const byPath = new Map();
        for (const e of events) {
          const cur = byPath.get(e.path) ?? { count: 0, types: new Set(), last: 0 };
          cur.count++;
          cur.types.add(e.type);
          cur.last = Math.max(cur.last, e.at);
          byPath.set(e.path, cur);
        }
        const rows = [...byPath.entries()]
          .sort((x, y) => y[1].last - x[1].last)
          .map(([path, info]) => `${[...info.types].join('+').padEnd(8)} ${path}${info.count > 1 ? ` (x${info.count})` : ''}`);

        return (
          `${entry.id} ${byPath.size} path(s) changed, ${events.length} event(s)\n` +
          truncateMiddle(rows.join('\n'), cap).text
        );
      }

      throw new Error(`Unknown watch action "${a}": start | poll | list | stop`);
    },
  };
}

/** Called on shutdown so watchers do not hold the process open. */
export function stopAllWatchers() {
  const n = watchers.size;
  for (const entry of [...watchers.values()]) stopWatcher(entry);
  return n;
}
