// Group: data — JSON surgery, diff/patch, and the encode/hash utilities you
// would otherwise shell out to a one-liner for.

import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { resolveSafePath } from '../guards.js';
import { truncateMiddle } from '../format.js';
import { unifiedDiff, diffStats, applyUnifiedDiff, toLines } from '../diff.js';

export const TOOLS = [
  {
    name: 'json_tool',
    description:
      'Query and patch JSON without rewriting the whole file: get (read a path), set, delete, ' +
      'merge (deep), keys (list a level), validate, format (pretty-print or minify). Paths look ' +
      'like "scripts.build" or "items[0].name". Works on a file (path=) or inline text (content=).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'delete', 'merge', 'keys', 'validate', 'format'], description: 'What to do.' },
        path: { type: 'string', description: 'JSON file to read (and write, for set/delete/merge/format).' },
        content: { type: 'string', description: 'Inline JSON text instead of a file. Nothing is written in this mode.' },
        json_path: { type: 'string', description: 'Dotted/bracketed path inside the document, e.g. "a.b[0].c". Omit for the root.' },
        value: { description: 'set: the new value (any JSON type). merge: the object to merge in.' },
        indent: { type: 'integer', description: 'Indent for written/formatted output. Default 2; 0 minifies.' },
        create_missing: { type: 'boolean', description: 'set: create intermediate objects that do not exist. Default true.' },
        max_bytes: { type: 'integer', description: 'Byte cap on returned output.' },
      },
      required: ['action'],
    },
  },

  {
    name: 'diff',
    description:
      'Compare and patch text: files (unified diff between two files), text (between two inline ' +
      'strings), apply (apply a unified diff to a file — hunk line numbers are matched by context, ' +
      'so a patch still applies after unrelated edits shifted the file).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['files', 'text', 'apply'], description: 'What to do.' },
        path: { type: 'string', description: 'files: the first file. apply: the file to patch.' },
        to: { type: 'string', description: 'files: the second file.' },
        a: { type: 'string', description: 'text: the "before" string.' },
        b: { type: 'string', description: 'text: the "after" string.' },
        patch: { type: 'string', description: 'apply: the unified diff to apply.' },
        context: { type: 'integer', description: 'Lines of context per hunk. Default 3.' },
        stat: { type: 'boolean', description: 'Report only the added/removed line counts.' },
        dry_run: { type: 'boolean', description: 'apply: report what would happen without writing.' },
        max_bytes: { type: 'integer', description: 'Byte cap on returned output.' },
      },
      required: ['action'],
    },
  },

  {
    name: 'encode',
    description:
      'Small conversions: base64/hex/url/html encode and decode, hash (md5/sha1/sha256/sha512), ' +
      'uuid, random bytes, jwt_decode (header and payload — signature is NOT verified), ' +
      'timestamp (epoch <-> ISO). Reads inline text or a file.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'base64_encode', 'base64_decode', 'base64url_encode', 'hex_encode', 'hex_decode',
            'url_encode', 'url_decode', 'html_escape', 'html_unescape',
            'hash', 'uuid', 'random', 'jwt_decode', 'timestamp',
          ],
          description: 'Which conversion.',
        },
        text: { type: 'string', description: 'Input text. For timestamp: an epoch number or an ISO string.' },
        path: { type: 'string', description: 'Read the input from this file instead of "text".' },
        algorithm: { type: 'string', enum: ['md5', 'sha1', 'sha256', 'sha512'], description: 'hash: digest. Default sha256.' },
        count: { type: 'integer', description: 'uuid: how many. random: how many bytes. Default 1 / 32.' },
        encoding: { type: 'string', enum: ['hex', 'base64'], description: 'random: output encoding. Default hex.' },
        max_bytes: { type: 'integer', description: 'Byte cap on returned output.' },
      },
      required: ['action'],
    },
  },
];

// ------------------------------------------------------------- JSON paths

/** Split "a.b[0].c" into ["a","b",0,"c"]. */
function parseJsonPath(path) {
  if (!path || path === '$' || path === '') return [];
  const parts = [];
  const re = /([^.[\]]+)|\[(\d+)\]|\["([^"]*)"\]|\['([^']*)'\]/g;
  let m;
  let consumed = 0;
  while ((m = re.exec(path)) !== null) {
    consumed = m.index + m[0].length;
    if (m[2] !== undefined) parts.push(Number(m[2]));
    else parts.push(m[1] ?? m[3] ?? m[4]);
  }
  if (consumed !== path.length) {
    throw new Error(`Cannot parse json_path ${JSON.stringify(path)} — use "a.b[0].c" form.`);
  }
  return parts;
}

function getAt(doc, parts) {
  let cur = doc;
  for (const key of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
}

function setAt(doc, parts, value, createMissing) {
  if (!parts.length) return value;
  let cur = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (cur[key] === undefined || cur[key] === null) {
      if (!createMissing) {
        throw new Error(`Path segment "${parts.slice(0, i + 1).join('.')}" does not exist (create_missing:false)`);
      }
      cur[key] = typeof parts[i + 1] === 'number' ? [] : {};
    }
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
  return doc;
}

function deleteAt(doc, parts) {
  if (!parts.length) throw new Error('delete needs a json_path — refusing to delete the whole document');
  const parent = getAt(doc, parts.slice(0, -1));
  if (parent === undefined || parent === null) return false;
  const last = parts[parts.length - 1];
  if (Array.isArray(parent) && typeof last === 'number') {
    if (last >= parent.length) return false;
    parent.splice(last, 1);
    return true;
  }
  if (!(last in parent)) return false;
  delete parent[last];
  return true;
}

function deepMerge(target, source) {
  if (Array.isArray(source) || typeof source !== 'object' || source === null) return source;
  const out = Array.isArray(target) || typeof target !== 'object' || target === null ? {} : { ...target };
  for (const [k, v] of Object.entries(source)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out;
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array[${value.length}]`;
  const t = typeof value;
  return t === 'object' ? `object{${Object.keys(value).length}}` : t;
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function createHandlers({ cfg }) {
  async function loadJson(p, { forWrite = false } = {}) {
    if (typeof p.content === 'string') {
      try {
        return { doc: JSON.parse(p.content), file: null };
      } catch (err) {
        throw new Error(`content is not valid JSON: ${err.message}`);
      }
    }
    if (!p.path) throw new Error('needs "path" (a JSON file) or "content" (inline JSON)');
    const abs = resolveSafePath(cfg, p.path, { forWrite });
    const text = await readFile(abs, 'utf8').catch(() => null);
    if (text === null) throw new Error(`File not found: ${abs}`);
    try {
      return { doc: JSON.parse(text), file: abs, raw: text };
    } catch (err) {
      // Point at the offending line: "unexpected token at position N" alone is useless.
      const at = Number((/position (\d+)/.exec(err.message) || [])[1]);
      const where = Number.isFinite(at) ? ` (line ${text.slice(0, at).split('\n').length})` : '';
      throw new Error(`${abs} is not valid JSON${where}: ${err.message}`);
    }
  }

  return {
    async json_tool(p) {
      const a = p.action;
      if (!a) throw new Error('"action" is required: get | set | delete | merge | keys | validate | format');
      const indent = p.indent ?? 2;
      const cap = p.max_bytes ?? cfg.maxOutputBytes;
      const writes = ['set', 'delete', 'merge', 'format'].includes(a);

      if (a === 'validate') {
        try {
          const { doc, file } = await loadJson(p);
          return `${file ?? 'inline JSON'} is valid — root is ${describe(doc)}`;
        } catch (err) {
          return `INVALID: ${err.message}`;
        }
      }

      const { doc, file } = await loadJson(p, { forWrite: writes && typeof p.content !== 'string' });
      const parts = parseJsonPath(p.json_path);

      if (a === 'get') {
        const value = getAt(doc, parts);
        if (value === undefined) {
          const parent = getAt(doc, parts.slice(0, -1));
          const hint =
            parent && typeof parent === 'object'
              ? ` Available keys at "${parts.slice(0, -1).join('.') || '$'}": ${Object.keys(parent).slice(0, 30).join(', ')}`
              : '';
          return `${p.json_path ?? '$'} is not present.${hint}`;
        }
        const rendered = typeof value === 'string' ? value : JSON.stringify(value, null, indent);
        return `${p.json_path ?? '$'} (${describe(value)})\n${truncateMiddle(rendered, cap).text}`;
      }

      if (a === 'keys') {
        const value = getAt(doc, parts);
        if (value === null || typeof value !== 'object') {
          return `${p.json_path ?? '$'} is ${describe(value)} — it has no keys`;
        }
        if (Array.isArray(value)) {
          return `${p.json_path ?? '$'} is an array of ${value.length}: ${value.map((v, i) => `[${i}] ${describe(v)}`).slice(0, 60).join(', ')}`;
        }
        const rows = Object.entries(value).map(([k, v]) => `  ${k}: ${describe(v)}`);
        return `${p.json_path ?? '$'} — ${rows.length} key(s)\n${truncateMiddle(rows.join('\n'), cap).text}`;
      }

      let updated = doc;
      let summary;

      if (a === 'set') {
        if (p.value === undefined) throw new Error('set needs "value"');
        const before = getAt(doc, parts);
        updated = setAt(doc, parts, p.value, p.create_missing !== false);
        summary = `set ${p.json_path ?? '$'}: ${describe(before)} -> ${describe(p.value)}`;
      } else if (a === 'delete') {
        const removed = deleteAt(doc, parts);
        if (!removed) return `${p.json_path} was already absent — nothing changed`;
        summary = `deleted ${p.json_path}`;
      } else if (a === 'merge') {
        if (p.value === undefined || typeof p.value !== 'object' || p.value === null) {
          throw new Error('merge needs "value" to be an object');
        }
        const target = getAt(doc, parts);
        const merged = deepMerge(target, p.value);
        updated = parts.length ? setAt(doc, parts, merged, true) : merged;
        summary = `merged ${Object.keys(p.value).length} key(s) into ${p.json_path ?? '$'}`;
      } else if (a === 'format') {
        summary = indent === 0 ? 'minified' : `formatted with indent ${indent}`;
      } else {
        throw new Error(`Unknown json_tool action "${a}"`);
      }

      const text = indent === 0 ? JSON.stringify(updated) : `${JSON.stringify(updated, null, indent)}\n`;
      if (!file) return `${summary} (inline — nothing written)\n${truncateMiddle(text, cap).text}`;
      await writeFile(file, text, 'utf8');
      return `${summary} -> ${file} (${text.length} bytes)`;
    },

    async diff(p) {
      const a = p.action;
      const cap = p.max_bytes ?? cfg.maxOutputBytes;
      const context = p.context ?? 3;

      if (a === 'files') {
        if (!p.path || !p.to) throw new Error('files needs "path" and "to"');
        const aAbs = resolveSafePath(cfg, p.path);
        const bAbs = resolveSafePath(cfg, p.to);
        const [aText, bText] = await Promise.all([
          readFile(aAbs, 'utf8').catch(() => null),
          readFile(bAbs, 'utf8').catch(() => null),
        ]);
        if (aText === null) throw new Error(`Not found: ${aAbs}`);
        if (bText === null) throw new Error(`Not found: ${bAbs}`);
        const s = diffStats(aText, bText);
        if (s.changed === 0) return `${aAbs} and ${bAbs} are identical (${toLines(aText).length} lines)`;
        const head = `${aAbs} -> ${bAbs}: +${s.added} -${s.removed}`;
        if (p.stat) return head;
        const patch = unifiedDiff(aText, bText, { aName: aAbs, bName: bAbs, context });
        return `${head}\n${truncateMiddle(patch, cap).text}`;
      }

      if (a === 'text') {
        if (p.a === undefined || p.b === undefined) throw new Error('text needs "a" and "b"');
        const s = diffStats(p.a, p.b);
        if (s.changed === 0) return 'identical';
        const head = `+${s.added} -${s.removed}`;
        if (p.stat) return head;
        return `${head}\n${truncateMiddle(unifiedDiff(p.a, p.b, { aName: 'a', bName: 'b', context }), cap).text}`;
      }

      if (a === 'apply') {
        if (!p.path) throw new Error('apply needs "path"');
        if (!p.patch) throw new Error('apply needs "patch"');
        const abs = resolveSafePath(cfg, p.path, { forWrite: p.dry_run !== true });
        const text = await readFile(abs, 'utf8').catch(() => null);
        if (text === null) throw new Error(`Not found: ${abs}`);

        const result = applyUnifiedDiff(text, p.patch);
        const lines = [
          `${p.dry_run ? 'DRY RUN — ' : ''}${abs}: ${result.applied.length} hunk(s) applied` +
          `${result.failed.length ? `, ${result.failed.length} FAILED` : ''}`,
          ...result.applied.map((x) => `  ok  ${x}`),
          ...result.failed.map((x) => `  FAIL ${x}`),
        ];

        if (result.failed.length && !result.applied.length) {
          throw new Error(`No hunk applied to ${abs}:\n${result.failed.join('\n')}`);
        }
        if (p.dry_run) {
          const s = diffStats(text, result.text);
          lines.push(`would change: +${s.added} -${s.removed}`);
          return lines.join('\n');
        }
        // Partial application would leave the file in a state nobody asked for.
        if (result.failed.length) {
          throw new Error(
            `Refusing a partial patch of ${abs} — ${result.applied.length} hunk(s) fit but ` +
            `${result.failed.length} did not:\n${result.failed.join('\n')}\n` +
            `Nothing was written. Re-read the file and rebuild the patch.`,
          );
        }
        await writeFile(abs, result.text, 'utf8');
        const s = diffStats(text, result.text);
        lines.push(`written: +${s.added} -${s.removed}`);
        return lines.join('\n');
      }

      throw new Error(`Unknown diff action "${a}": files | text | apply`);
    },

    async encode(p) {
      const a = p.action;
      if (!a) throw new Error('"action" is required');
      const cap = p.max_bytes ?? cfg.maxOutputBytes;

      if (a === 'uuid') {
        const n = Math.min(Math.max(p.count ?? 1, 1), 1000);
        return Array.from({ length: n }, () => randomUUID()).join('\n');
      }
      if (a === 'random') {
        const n = Math.min(Math.max(p.count ?? 32, 1), 1_000_000);
        return randomBytes(n).toString(p.encoding === 'base64' ? 'base64' : 'hex');
      }
      if (a === 'timestamp') {
        const input = p.text?.trim();
        if (!input) {
          const now = new Date();
          return `now: ${now.toISOString()} | epoch_s ${Math.floor(now.getTime() / 1000)} | epoch_ms ${now.getTime()}`;
        }
        if (/^\d+$/.test(input)) {
          // Ten digits is seconds, thirteen is milliseconds.
          const num = Number(input);
          const asMs = input.length <= 11 ? num * 1000 : num;
          const d = new Date(asMs);
          if (Number.isNaN(d.getTime())) throw new Error(`${input} is not a usable timestamp`);
          return `${input} -> ${d.toISOString()} (local: ${d.toString()})`;
        }
        const d = new Date(input);
        if (Number.isNaN(d.getTime())) throw new Error(`Cannot parse ${JSON.stringify(input)} as a date`);
        return `${input} -> epoch_s ${Math.floor(d.getTime() / 1000)} | epoch_ms ${d.getTime()} | ${d.toISOString()}`;
      }

      // Everything below needs input.
      let input;
      if (p.path) {
        const abs = resolveSafePath(cfg, p.path);
        const buf = await readFile(abs).catch(() => null);
        if (buf === null) throw new Error(`Not found: ${abs}`);
        input = buf;
      } else if (typeof p.text === 'string') {
        input = Buffer.from(p.text, 'utf8');
      } else {
        throw new Error(`${a} needs "text" or "path"`);
      }

      const outText = (s) => truncateMiddle(s, cap).text;

      switch (a) {
        case 'base64_encode': return outText(input.toString('base64'));
        case 'base64url_encode': return outText(input.toString('base64url'));
        case 'base64_decode': {
          const s = input.toString('utf8').trim().replace(/\s+/g, '');
          const decoded = Buffer.from(s, 'base64');
          // base64 decoding never fails loudly, so verify by re-encoding.
          const normalized = decoded.toString('base64').replace(/=+$/, '');
          if (normalized !== s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/')) {
            return `decoded ${decoded.length} bytes, but the input is not clean base64 — check it:\n${outText(decoded.toString('utf8'))}`;
          }
          return outText(decoded.toString('utf8'));
        }
        case 'hex_encode': return outText(input.toString('hex'));
        case 'hex_decode': {
          const s = input.toString('utf8').trim().replace(/[\s:]/g, '');
          if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2) throw new Error('not valid hex (needs an even count of hex digits)');
          return outText(Buffer.from(s, 'hex').toString('utf8'));
        }
        case 'url_encode': return outText(encodeURIComponent(input.toString('utf8')));
        case 'url_decode':
          try {
            return outText(decodeURIComponent(input.toString('utf8')));
          } catch (err) {
            throw new Error(`not a valid percent-encoded string: ${err.message}`);
          }
        case 'html_escape':
          return outText(input.toString('utf8').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]));
        case 'html_unescape':
          return outText(
            input
              .toString('utf8')
              .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e) =>
                ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' })[e])
              .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
              .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))),
          );
        case 'hash': {
          const algorithm = p.algorithm || 'sha256';
          const digest = createHash(algorithm).update(input).digest('hex');
          return `${algorithm} ${digest}  (${input.length} bytes)`;
        }
        case 'jwt_decode': {
          const token = input.toString('utf8').trim();
          const segments = token.split('.');
          if (segments.length < 2) throw new Error('not a JWT (expected at least header.payload)');
          const decode = (seg, label) => {
            try {
              return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
            } catch (err) {
              throw new Error(`${label} is not valid base64url JSON: ${err.message}`);
            }
          };
          const header = decode(segments[0], 'header');
          const payload = decode(segments[1], 'payload');
          const notes = [];
          if (payload.exp) {
            const d = new Date(payload.exp * 1000);
            notes.push(`exp ${d.toISOString()} (${d.getTime() < Date.now() ? 'EXPIRED' : 'valid'})`);
          }
          if (payload.iat) notes.push(`iat ${new Date(payload.iat * 1000).toISOString()}`);
          if (payload.nbf) notes.push(`nbf ${new Date(payload.nbf * 1000).toISOString()}`);
          return outText(
            [
              'header', JSON.stringify(header, null, 2),
              'payload', JSON.stringify(payload, null, 2),
              notes.length ? notes.join(' | ') : null,
              'NOTE: the signature is not verified — this only decodes.',
            ]
              .filter(Boolean)
              .join('\n'),
          );
        }
        default:
          throw new Error(`Unknown encode action "${a}"`);
      }
    },
  };
}

