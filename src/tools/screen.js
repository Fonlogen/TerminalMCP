// Group: screen — capture the desktop, and look at images on disk.
//
// The browser tool can screenshot a web page; this one screenshots everything
// else: a native app, an installer dialog, a graph in a viewer, the whole
// desktop. It also has `view`, which turns any image file into something the
// model can actually see — including screenshots taken minutes ago, or a
// mockup the user dropped in a folder.
//
// Images are billed by area, so `max_width` (default 1200) is the dial that
// matters: the same capture at 1200px costs about a tenth of a 4K one, and is
// still perfectly legible.

import { stat } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError, resolveSafePath } from '../guards.js';
import { imageMime, imageSize, imageTokens, toImageContent } from '../image.js';
import { truncateMiddle } from '../format.js';
import { capture, listDisplays, listWindows, probe, sessionType } from '../screen.js';
import { saveBuffer } from '../browser.js';

export const TOOLS = [
  {
    name: 'screen',
    description:
      'Screenshot the desktop and look at images. shot captures everything, one monitor, ' +
      'one window found by title, or an exact rectangle — the image comes back viewable inline, ' +
      'so you can see what is on screen rather than guess. view shows any image file on disk ' +
      '(png/jpeg/gif/webp). displays and windows list what there is to capture, and probe says ' +
      'whether capture can work here at all — run it first if a shot fails. ' +
      'Scaled to max_width first, because an image costs tokens by area. For web pages prefer ' +
      'the browser tool: it needs no display and can capture a full scrolling page.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['shot', 'view', 'displays', 'windows', 'probe'],
          description: 'What to do.',
        },
        mode: {
          type: 'string',
          enum: ['screen', 'display', 'window', 'region'],
          description: 'shot: screen = everything across all monitors (default), display = one monitor, window = one window by title, region = an exact rectangle.',
        },
        display: { type: 'string', description: 'shot with mode=display: monitor index ("1") or name ("eDP-1", "DISPLAY1").' },
        window: { type: 'string', description: 'shot with mode=window: part of the window title, or an id from action "windows". The largest match wins.' },
        x: { type: 'integer', description: 'shot with mode=region: left edge, in virtual-desktop pixels.' },
        y: { type: 'integer', description: 'shot with mode=region: top edge.' },
        width: { type: 'integer', description: 'shot with mode=region: width.' },
        height: { type: 'integer', description: 'shot with mode=region: height.' },
        path: { type: 'string', description: 'view: which image to look at. shot: where to save it (default: a timestamped file under .terminalmcp/shots/).' },
        view: { type: 'boolean', description: 'shot: attach the image so you can see it. Default true; false saves it and returns only the path.' },
        save: { type: 'boolean', description: 'shot: write the file too. Default true.' },
        max_width: { type: 'integer', description: 'Scale down to at most this many pixels wide. Default 1200. This is the token dial.' },
        activate: { type: 'boolean', description: 'shot with mode=window: raise the window first (Windows only). It will be in front of whatever the user is doing.' },
        delay_ms: { type: 'integer', description: 'shot: wait this long before capturing — time for a menu to open or an animation to finish.' },
        timeout_ms: { type: 'integer', description: 'Give up after this long. Default 30000.' },
        max_bytes: { type: 'integer', description: 'Byte cap on returned text.' },
      },
      required: ['action'],
    },
  },
];

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

export function createHandlers({ cfg }) {
  return {
    async screen(a) {
      const action = a.action;
      if (!action) throw new Error('screen needs "action"');
      const cap = a.max_bytes ?? cfg.maxOutputBytes;
      const timeoutMs = a.timeout_ms ?? 30000;
      const maxWidth = a.max_width ?? cfg.screenshots?.maxWidth ?? 1200;
      const maxHeight = cfg.screenshots?.maxHeight ?? 1600;
      const maxImageBytes = cfg.screenshots?.maxImageBytes ?? 5 * 1024 * 1024;

      switch (action) {
        case 'probe':
          return probe(cfg, { timeoutMs });

        case 'displays': {
          const displays = await listDisplays(cfg, { timeoutMs });
          const rows = displays.map(
            (d) =>
              `${String(d.index).padEnd(3)}${(d.name ?? '').padEnd(18)}` +
              `${d.width && d.height ? `${d.width}x${d.height}`.padEnd(12) : 'unknown'.padEnd(12)}` +
              `at ${d.x},${d.y}${d.primary ? '  (primary)' : ''}`,
          );
          return (
            `${displays.length} display(s) on this ${sessionType()} session\n${rows.join('\n')}\n\n` +
            'Capture one with: shot { mode: "display", display: "1" }'
          );
        }

        case 'windows': {
          const windows = await listWindows(cfg, { timeoutMs });
          if (!windows.length) return 'No visible windows.';
          const rows = windows
            .sort((x, y) => y.width * y.height - x.width * x.height)
            .map(
              (w) =>
                `${w.id.padEnd(12)}${`${w.width}x${w.height}`.padEnd(11)}` +
                `${`at ${w.x},${w.y}`.padEnd(14)}${w.minimized ? 'min  ' : '     '}${w.title}`,
            );
          return (
            `${windows.length} window(s), largest first\n${truncateMiddle(rows.join('\n'), cap).text}\n\n` +
            'Capture one with: shot { mode: "window", window: "<part of the title>" }'
          );
        }

        case 'shot': {
          const mode = a.mode ?? 'screen';
          if (mode === 'region') {
            for (const k of ['x', 'y', 'width', 'height']) {
              if (a[k] === undefined || a[k] === null) {
                throw new Error('mode "region" needs x, y, width and height. Action "displays" shows the coordinate space.');
              }
            }
            if (a.width < 1 || a.height < 1) throw new Error('region width and height must be at least 1');
          }

          const shot = await capture(cfg, {
            mode,
            display: a.display ?? null,
            window: a.window ?? null,
            region: mode === 'region' ? { x: a.x, y: a.y, width: a.width, height: a.height } : null,
            activate: Boolean(a.activate),
            delayMs: a.delay_ms ?? 0,
            timeoutMs,
          });

          const lines = [];
          const size = imageSize(shot.buf);
          lines.push(
            `captured ${shot.mode}${shot.detail ? ` — ${shot.detail}` : ''} with ${shot.tool}` +
            `${size ? ` (${size.width}x${size.height}, ~${imageTokens(size.width, size.height)} tokens at full size)` : ''}`,
          );

          let saved = null;
          if (a.save !== false || a.path) {
            if (cfg.readOnly) {
              if (a.path) {
                throw new PolicyError('readOnly is on, so the screenshot cannot be saved. Use save:false to view it without saving.');
              }
              lines.push('not saved: readOnly is on');
            } else {
              const target =
                a.path ?? path.join(cfg.screenshots?.dir ?? path.join(cfg.cwd, '.terminalmcp', 'shots'), `${stamp()}.png`);
              saved = await saveBuffer(resolveSafePath(cfg, target, { forWrite: true }), shot.buf);
              lines.push(`saved ${saved} (${shot.buf.length} bytes, full resolution)`);
            }
          }

          const images = [];
          if (a.view !== false) {
            const { block, note } = toImageContent(shot.buf, {
              filename: saved ?? 'screen.png',
              maxWidth,
              maxHeight,
              maxBytes: maxImageBytes,
            });
            images.push(block);
            lines.push(`viewing: ${note}`);
          }

          return { text: lines.join('\n'), images };
        }

        case 'view': {
          if (!a.path) throw new Error('view needs "path"');
          const abs = resolveSafePath(cfg, a.path);
          const st = await stat(abs).catch(() => null);
          if (!st) throw new Error(`Not found: ${abs}`);
          if (st.isDirectory()) throw new Error(`${abs} is a directory`);

          const buf = await readFile(abs);
          const mime = imageMime(buf, abs);
          if (!mime.startsWith('image/')) {
            throw new Error(
              `${path.basename(abs)} is not an image (${mime}). Read it with file_read instead.`,
            );
          }
          if (mime === 'image/svg+xml') {
            throw new Error('SVG cannot be shown as an image; read it as text with file_read — it is markup.');
          }

          const { block, note } = toImageContent(buf, {
            filename: abs,
            maxWidth,
            maxHeight,
            maxBytes: maxImageBytes,
          });
          return {
            text: `${abs}\n${st.size} bytes on disk, ${mime}\n${note}`,
            images: [block],
          };
        }

        default:
          throw new Error(`Unknown screen action "${action}": shot | view | displays | windows | probe`);
      }
    },
  };
}
