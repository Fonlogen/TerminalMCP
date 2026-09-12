// Group: vars — server-side variables, so a value need not travel back
// through the conversation to be reused.

import { readFile, writeFile } from 'node:fs/promises';
import { resolveSafePath } from '../guards.js';
import { truncateMiddle } from '../format.js';
import { describeType, previewOf } from '../vars.js';

const ACTIONS = ['set', 'get', 'list', 'delete', 'clear', 'append', 'incr', 'load', 'save'];

export const TOOLS = [
  {
    name: 'vars',
    description:
      'Server-side variables that persist between calls, so a value never has to be re-sent through ' +
      'the conversation. Store once, then reference it as ${vars.<name>} in later calls — in a ' +
      'command, cwd, env, a path, a URL, a header, a git message, a bulk step. list shows names, ' +
      'types and sizes but NOT full values (that is the saving). Mark a token secret:true and it ' +
      'stays usable via ${vars.…} while never being echoed back. shell_bulk assign, shell_exec ' +
      'assign and http_request assign all write here.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description:
            'set | get | list | delete | clear | append (to a string/array) | incr (numeric) | ' +
            'load (read a file into a variable) | save (write a variable to a file).',
        },
        name: { type: 'string', description: 'Variable name. Letters, digits, _ . - starting with a letter or _.' },
        value: { description: 'set: the value — any JSON type. A string is itself ${...}-expanded, so you can compose from other variables.' },
        text: { type: 'string', description: 'append: the text (or array element) to add.' },
        delta: { type: 'number', description: 'incr: how much to add. Default 1.' },
        path: { type: 'string', description: 'load: file to read into the variable. save: file to write the variable to.' },
        json: { type: 'boolean', description: 'load: parse the file as JSON instead of storing it as text.' },
        secret: { type: 'boolean', description: 'set/load: never echo this value back in get or list. It still works in ${vars.…}.' },
        reveal: { type: 'boolean', description: 'get: return a secret value in plain text. Only when you actually need to read it.' },
        ttl_ms: { type: 'integer', description: 'set: forget the variable after this long.' },
        names: { type: 'array', items: { type: 'string' }, description: 'get/delete: act on several names at once.' },
        confirm: { type: 'boolean', description: 'clear: required, since it drops every variable.' },
        max_bytes: { type: 'integer', description: 'get: byte cap on the returned value.' },
      },
      required: ['action'],
    },
  },
];

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function humanBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function renderValue(value, cap) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return truncateMiddle(text ?? 'null', cap).text;
}

export function createHandlers({ cfg, vars }) {
  return {
    async vars(p) {
      const a = p.action;
      if (!a) throw new Error(`"action" is required. One of: ${ACTIONS.join(', ')}`);
      const cap = p.max_bytes ?? cfg.maxOutputBytes;

      switch (a) {
        case 'set': {
          if (!p.name) throw new Error('set needs "name"');
          if (p.value === undefined) {
            throw new Error('set needs "value" (use action="delete" to remove a variable)');
          }
          const entry = vars.set(p.name, p.value, { secret: p.secret, ttlMs: p.ttl_ms ?? null });
          const shown = entry.secret ? '(secret)' : previewOf(p.value, 80);
          return (
            `${p.name} = ${shown}  [${describeType(p.value)}, ${humanBytes(entry.bytes)}]` +
            `${entry.expiresAt ? ` expires in ${Math.round((entry.expiresAt - Date.now()) / 1000)}s` : ''}\n` +
            `Use it as \${vars.${p.name}}`
          );
        }

        case 'get': {
          const names = p.names?.length ? p.names : p.name ? [p.name] : null;
          if (!names) throw new Error('get needs "name" or "names"');

          const parts = [];
          for (const name of names) {
            const entry = vars.entry(name);
            if (!entry) {
              const known = Object.keys(vars.snapshot());
              parts.push(
                `${name}: not set.` +
                (known.length ? ` Defined: ${known.slice(0, 25).join(', ')}` : ' No variables are set.'),
              );
              continue;
            }
            if (entry.secret && !p.reveal) {
              parts.push(
                `${name}: (secret, ${describeType(entry.value)}, ${humanBytes(entry.bytes)}) — ` +
                `usable as \${vars.${name}}; pass reveal:true to read it.`,
              );
              continue;
            }
            parts.push(
              names.length > 1
                ? `--- ${name} (${describeType(entry.value)}) ---\n${renderValue(entry.value, cap)}`
                : renderValue(entry.value, cap),
            );
          }
          return parts.join('\n');
        }

        case 'list': {
          const rows = vars.list();
          if (!rows.length) {
            return (
              'No variables set.' +
              (vars.loadError ? `\nstore warning: ${vars.loadError}` : '')
            );
          }
          const width = Math.max(...rows.map((v) => v.name.length));
          const body = rows
            .map(
              (v) =>
                `${v.name.padEnd(width)}  ${v.type.padEnd(12)} ${humanBytes(v.bytes).padStart(8)}  ` +
                `${ago(v.updatedAt).padStart(8)}  ${v.preview}` +
                `${v.expiresAt ? `  (expires in ${Math.round((v.expiresAt - Date.now()) / 1000)}s)` : ''}`,
            )
            .join('\n');
          return (
            `${rows.length} variable(s), ${humanBytes(vars.totalBytes())} total — ` +
            `values are not shown; read one with vars {action:"get", name:"…"}\n${body}` +
            (vars.loadError ? `\nstore warning: ${vars.loadError}` : '')
          );
        }

        case 'delete': {
          const names = p.names?.length ? p.names : p.name ? [p.name] : null;
          if (!names) throw new Error('delete needs "name" or "names"');
          const gone = names.filter((n) => vars.delete(n));
          const missing = names.filter((n) => !gone.includes(n));
          return (
            `deleted ${gone.length}: ${gone.join(', ') || '(none)'}` +
            (missing.length ? `\nnot set: ${missing.join(', ')}` : '')
          );
        }

        case 'clear': {
          const rows = vars.list();
          if (!p.confirm) {
            return (
              `Would delete all ${rows.length} variable(s): ${rows.map((v) => v.name).join(', ') || '(none)'}\n` +
              `Pass confirm:true to do it.`
            );
          }
          return `cleared ${vars.clear()} variable(s)`;
        }

        case 'append': {
          if (!p.name) throw new Error('append needs "name"');
          if (p.text === undefined) throw new Error('append needs "text"');
          const entry = vars.append(p.name, p.text);
          return `${p.name} now ${describeType(entry.value)}, ${humanBytes(entry.bytes)}: ${previewOf(entry.value, 80)}`;
        }

        case 'incr': {
          if (!p.name) throw new Error('incr needs "name"');
          return `${p.name} = ${vars.incr(p.name, p.delta ?? 1)}`;
        }

        case 'load': {
          if (!p.name) throw new Error('load needs "name"');
          if (!p.path) throw new Error('load needs "path"');
          const abs = resolveSafePath(cfg, p.path);
          const text = await readFile(abs, 'utf8').catch(() => null);
          if (text === null) throw new Error(`Not found: ${abs}`);
          let value = text;
          if (p.json) {
            try {
              value = JSON.parse(text);
            } catch (err) {
              throw new Error(`${abs} is not valid JSON: ${err.message}`);
            }
          }
          const entry = vars.set(p.name, value, { secret: p.secret, ttlMs: p.ttl_ms ?? null });
          return (
            `loaded ${abs} into ${p.name} ` +
            `[${describeType(value)}, ${humanBytes(entry.bytes)}]${entry.secret ? ' (secret)' : ''}\n` +
            `Use it as \${vars.${p.name}}`
          );
        }

        case 'save': {
          if (!p.name) throw new Error('save needs "name"');
          if (!p.path) throw new Error('save needs "path"');
          const value = vars.get(p.name);
          if (value === undefined) throw new Error(`${p.name} is not set`);
          const abs = resolveSafePath(cfg, p.path, { forWrite: true });
          const text = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
          await writeFile(abs, text, 'utf8');
          return `wrote ${p.name} to ${abs} (${humanBytes(Buffer.byteLength(text, 'utf8'))})`;
        }

        default:
          throw new Error(`Unknown vars action "${a}". One of: ${ACTIONS.join(', ')}`);
      }
    },
  };
}
