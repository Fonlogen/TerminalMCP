// Group: input — the mouse and the keyboard.
//
// Paired with `screen`, this closes the loop on software that has no other way
// in: an installer with no silent switch, a launcher, a native dialog, a
// legacy admin panel. Capture, decide, act, capture again.
//
// Two things shape the design:
//
//   * Input goes wherever the focus is, not wherever you meant. So every
//     action takes an optional `window`, raised first, and `shot: true`
//     returns a screenshot of what happened — one call instead of three, and
//     no acting blind.
//   * It moves the real pointer on someone's real desk. `readOnly` blocks all
//     of it, and the reply always says exactly what was sent.

import { PolicyError } from '../guards.js';
import { imageSize, imageTokens, toImageContent } from '../image.js';
import { capture } from '../screen.js';
import { createHandlers as createScreenHandlers } from './screen.js';
import { BULK_ACTIONS, renderInputBulk, runInputBulk } from '../inputbulk.js';
import {
  clickPointer,
  dragPointer,
  focusWindow,
  inputProbe,
  movePointer,
  pointerPosition,
  pressKeys,
  scrollWheel,
  typeText,
} from '../input.js';

export const TOOLS = [
  {
    name: 'input',
    description:
      'Move the mouse, click, drag, scroll, type and press keys on the real desktop — for ' +
      'apps that cannot be driven any other way. Pair it with the screen tool: shot:true ' +
      'returns a screenshot right after acting, so you see the result in the same call. ' +
      'window raises a window first, because input follows the focus. Keys are written as ' +
      'chords: "enter", "ctrl+s", "alt+f4", "ctrl+shift+p", or a sequence "ctrl+a ctrl+c". ' +
      'For a web page use the browser tool instead — it acts on elements, not coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['move', 'click', 'drag', 'scroll', 'type', 'key', 'position', 'focus', 'probe'],
          description: 'What to do. probe reports whether input works here at all, and what it needs.',
        },
        x: { type: 'integer', description: 'Target x, in virtual-desktop pixels (screen displays shows the space). Omit to act where the pointer already is.' },
        y: { type: 'integer', description: 'Target y.' },
        dx: { type: 'integer', description: 'move: offset from the current position instead of an absolute x.' },
        dy: { type: 'integer', description: 'move: vertical offset.' },
        to_x: { type: 'integer', description: 'drag: where the drag ends.' },
        to_y: { type: 'integer', description: 'drag: where the drag ends.' },
        button: { type: 'string', enum: ['left', 'middle', 'right'], description: 'click/drag: which button. Default left.' },
        count: { type: 'integer', description: 'click: how many clicks — 2 for a double click. Default 1.' },
        amount: { type: 'integer', description: 'scroll: wheel clicks. Positive scrolls down, negative up. Default 3.' },
        horizontal: { type: 'boolean', description: 'scroll: sideways instead of vertically.' },
        text: { type: 'string', description: 'type: the text to type. Sent as characters, so accents and any layout work.' },
        keys: { type: 'string', description: 'key: a chord ("ctrl+s") or a sequence separated by spaces ("alt+f x").' },
        hold_ms: { type: 'integer', description: 'key: hold each chord down this long before releasing — for a game, or a menu that needs it.' },
        interval_ms: { type: 'integer', description: 'type/key: delay between characters or chords.' },
        window: { type: 'string', description: 'Raise the window whose title contains this first, so the input lands in it.' },
        shot: { type: 'boolean', description: 'Return a screenshot after acting, so you can see the result. Default false.' },
        shot_mode: { type: 'string', enum: ['screen', 'window'], description: 'shot: the whole screen (default), or just the window named in "window".' },
        delay_ms: { type: 'integer', description: 'Wait this long before acting — time for a menu to open.' },
        max_width: { type: 'integer', description: 'shot: scale the screenshot to this width. Default 1200.' },
        timeout_ms: { type: 'integer', description: 'Give up after this long.' },
      },
      required: ['action'],
    },
  },

  {
    name: 'input_bulk',
    description:
      'Run a whole mouse/keyboard/screen sequence in ONE call, in order — the input twin of shell_bulk. ' +
      'Steps take the input actions (move, click, drag, scroll, type, key, focus, position) plus shot ' +
      '(a screenshot) and wait. delay_ms is the pause between steps (default 100) — UIs need a beat; ' +
      'per step add delay_before_ms / delay_after_ms. when, retry and on_failure work as in shell_bulk, ' +
      'reading prev.ok, step.<id>.ok, step.<id>.x/.y (from position), vars.<name>. A step may be a ' +
      'string: "click 400 300", "type hello", "key ctrl+s", "wait 500", "scroll -3", "focus Notepad", ' +
      '"shot". window raises that window once before the first step. Screenshots (shot steps, shot:true, ' +
      'final_shot) are capped at max_shots, newest kept.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          description: 'Steps run in order. A string is a shorthand, see the tool description.',
          items: {
            type: ['object', 'string'],
            properties: {
              action: { type: 'string', enum: BULK_ACTIONS },
              id: { type: 'string', description: 'Name for this step, readable later as step.<id>. Default s1, s2, ...' },
              x: { type: ['integer', 'string'], description: 'Target x (or shot region left). A string may use ${...}, e.g. "${step.p.x}".' },
              y: { type: ['integer', 'string'], description: 'Target y (or shot region top).' },
              dx: { type: ['integer', 'string'] },
              dy: { type: ['integer', 'string'] },
              to_x: { type: ['integer', 'string'], description: 'drag: end x.' },
              to_y: { type: ['integer', 'string'], description: 'drag: end y.' },
              button: { type: 'string', enum: ['left', 'middle', 'right'] },
              count: { type: ['integer', 'string'], description: 'click: 2 for a double click.' },
              amount: { type: ['integer', 'string'], description: 'scroll: wheel clicks, positive = down.' },
              horizontal: { type: 'boolean' },
              text: { type: 'string', description: 'type: the text.' },
              keys: { type: 'string', description: 'key: "ctrl+s", or a sequence "alt+f x".' },
              hold_ms: { type: ['integer', 'string'] },
              interval_ms: { type: ['integer', 'string'], description: 'type/key: delay between characters or chords.' },
              window: { type: 'string', description: 'Raise this window before the step. focus: the window to raise. shot: the window to capture.' },
              shot: { type: 'boolean', description: 'Input actions: screenshot right after.' },
              shot_mode: { type: 'string', enum: ['screen', 'window'] },
              mode: { type: 'string', enum: ['screen', 'display', 'window', 'region'], description: 'shot: what to capture. Default screen.' },
              display: { type: 'string', description: 'shot with mode=display.' },
              width: { type: ['integer', 'string'], description: 'shot with mode=region.' },
              height: { type: ['integer', 'string'], description: 'shot with mode=region.' },
              path: { type: 'string', description: 'shot: also save the full-resolution image here.' },
              max_width: { type: ['integer', 'string'] },
              ms: { type: ['integer', 'string'], description: 'wait: how long.' },
              delay_before_ms: { type: 'integer', description: 'Extra pause before this step.' },
              delay_after_ms: { type: 'integer', description: 'Extra pause after this step.' },
              when: { type: 'string', description: 'Run only if true: prev_success, prev_failure, all_success, any_failure, or an expression like "step.p.x > 100".' },
              on_failure: { type: 'string', enum: ['stop', 'continue'] },
              retry: {
                type: 'object',
                properties: { count: { type: 'integer' }, delay_ms: { type: 'integer' } },
                description: 'Try again while it fails. Careful with clicks: a retried click is a second click.',
              },
            },
          },
        },
        window: { type: 'string', description: 'Raise the window whose title contains this before the first step. If it cannot be raised nothing is sent.' },
        delay_ms: { type: 'integer', description: 'Pause between consecutive steps. Default 100.' },
        stop_on_failure: { type: 'boolean', description: 'Stop at the first failing step. Default true.' },
        max_shots: { type: 'integer', description: 'Most screenshots to attach; the newest are kept. Default 4.' },
        final_shot: { description: 'Capture once the run ends: true, false (default), or "on_failure" — to see where it broke.' },
        final_shot_mode: { type: 'string', enum: ['screen', 'window'], description: 'final_shot: the whole screen (default) or the run window.' },
        max_width: { type: 'integer', description: 'final_shot: scale to this width. Default 1200.' },
        timeout_ms: { type: 'integer', description: 'Per-step time limit.' },
        vars: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra variables for this run, over the persistent store.' },
      },
      required: ['steps'],
    },
  },
];

const MUTATES = new Set(['move', 'click', 'drag', 'scroll', 'type', 'key', 'focus']);

export function createHandlers({ cfg, vars = null }) {
  const { screen } = createScreenHandlers({ cfg });

  // One step of input_bulk, through the same code paths as the single-call
  // tools — so a click in a sequence is exactly a click on its own.
  const exec = async (action, a) => {
    if (action === 'position') {
      const p = await pointerPosition(cfg, { timeoutMs: a.timeout_ms ?? 20000 });
      return { text: `pointer at ${p.x},${p.y}`, x: p.x, y: p.y };
    }
    if (action === 'shot') {
      return screen({
        action: 'shot',
        mode: a.mode ?? 'screen',
        display: a.display,
        window: a.window,
        x: a.x,
        y: a.y,
        width: a.width,
        height: a.height,
        max_width: a.max_width,
        path: a.path,
        save: Boolean(a.path),
        timeout_ms: a.timeout_ms,
      });
    }
    const out = await handlers.input({ ...a, action });
    return typeof out === 'string' ? { text: out, images: [] } : out;
  };

  const handlers = {
    async input_bulk(a) {
      const out = await runInputBulk(cfg, a, { exec, store: vars });
      return { text: renderInputBulk(out), images: out.images };
    },

    async input(a) {
      const action = a.action;
      if (!action) throw new Error('input needs "action"');
      const timeoutMs = a.timeout_ms ?? 20000;

      // Moving someone's pointer and typing into their windows is not a read.
      if (cfg.readOnly && MUTATES.has(action)) {
        throw new PolicyError(
          `readOnly is on, so input cannot ${action} — it would act on the machine. ` +
          'Actions "position" and "probe" still work.',
        );
      }

      if (action === 'probe') return inputProbe(cfg, { timeoutMs });

      if (action === 'position') {
        const p = await pointerPosition(cfg, { timeoutMs });
        return `pointer at ${p.x},${p.y}`;
      }

      // Focus first: the whole difference between typing into the app you mean
      // and typing into whatever happened to be in front.
      let focused = null;
      if (a.window && action !== 'focus') {
        focused = await focusWindow(cfg, { window: a.window, timeoutMs });
      }
      if (a.delay_ms) await new Promise((r) => setTimeout(r, Math.min(a.delay_ms, 60000)));

      const lines = [];
      if (focused) lines.push(`raised "${focused.title}" (${focused.width}x${focused.height} at ${focused.x},${focused.y})`);

      switch (action) {
        case 'focus': {
          const win = await focusWindow(cfg, { window: a.window, timeoutMs });
          lines.push(`raised "${win.title}" (${win.width}x${win.height} at ${win.x},${win.y})`);
          break;
        }

        case 'move': {
          const relative = a.x === undefined || a.y === undefined;
          if (relative && a.dx === undefined && a.dy === undefined) {
            throw new Error('move needs x and y, or dx and dy for a relative move');
          }
          const p = await movePointer(cfg, {
            x: relative ? null : a.x,
            y: relative ? null : a.y,
            dx: a.dx ?? 0,
            dy: a.dy ?? 0,
            timeoutMs,
          });
          lines.push(p.x === null ? 'moved the pointer' : `pointer now at ${p.x},${p.y}`);
          break;
        }

        case 'click': {
          const r = await clickPointer(cfg, {
            x: a.x ?? null,
            y: a.y ?? null,
            button: a.button ?? 'left',
            count: a.count ?? 1,
            timeoutMs,
          });
          lines.push(
            `${r.count > 1 ? `${r.count}x ` : ''}${r.button} click` +
            `${r.x === null ? ' where the pointer was' : ` at ${r.x},${r.y}`}`,
          );
          break;
        }

        case 'drag': {
          const r = await dragPointer(cfg, {
            x: a.x ?? null,
            y: a.y ?? null,
            toX: a.to_x,
            toY: a.to_y,
            button: a.button ?? 'left',
            timeoutMs,
          });
          lines.push(`dragged with ${r.button} from ${r.from.x},${r.from.y} to ${r.to.x},${r.to.y}`);
          break;
        }

        case 'scroll': {
          const r = await scrollWheel(cfg, {
            x: a.x ?? null,
            y: a.y ?? null,
            amount: a.amount ?? 3,
            horizontal: Boolean(a.horizontal),
            timeoutMs,
          });
          lines.push(
            `scrolled ${Math.abs(r.amount)} click(s) ${r.horizontal ? (r.amount > 0 ? 'right' : 'left') : r.amount > 0 ? 'down' : 'up'}` +
            `${r.note ? ` — ${r.note}` : ''}`,
          );
          break;
        }

        case 'type': {
          const r = await typeText(cfg, {
            text: a.text,
            intervalMs: a.interval_ms ?? 0,
            timeoutMs: a.timeout_ms ?? 60000,
          });
          lines.push(`typed ${r.chars} character(s)`);
          break;
        }

        case 'key': {
          if (!a.keys) throw new Error('key needs "keys" — a chord like "ctrl+s", or a sequence like "alt+f x"');
          const r = await pressKeys(cfg, {
            keys: a.keys,
            holdMs: a.hold_ms ?? 0,
            intervalMs: a.interval_ms ?? 0,
            timeoutMs,
          });
          lines.push(
            `pressed ${r.chords.join(' then ')}${a.hold_ms ? ` (held ${a.hold_ms}ms each)` : ''}` +
            `${r.note ? ` — ${r.note}` : ''}`,
          );
          break;
        }

        default:
          throw new Error(
            `Unknown input action "${action}": move | click | drag | scroll | type | key | position | focus | probe`,
          );
      }

      const images = [];
      if (a.shot) {
        const mode = a.shot_mode === 'window' && a.window ? 'window' : 'screen';
        const shot = await capture(cfg, { mode, window: a.window ?? null, delayMs: 250, timeoutMs });
        const size = imageSize(shot.buf);
        const { block, note } = toImageContent(shot.buf, {
          filename: 'input.png',
          maxWidth: a.max_width ?? cfg.screenshots?.maxWidth ?? 1200,
          maxHeight: cfg.screenshots?.maxHeight ?? 1600,
          maxBytes: cfg.screenshots?.maxImageBytes ?? 5 * 1024 * 1024,
        });
        images.push(block);
        lines.push(
          `then captured ${mode}${size ? ` (${size.width}x${size.height}, ~${imageTokens(size.width, size.height)} tokens at full size)` : ''}`,
          `viewing: ${note}`,
        );
      }

      return { text: lines.join('\n'), images };
    },
  };
  return handlers;
}
