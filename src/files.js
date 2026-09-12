// File tools. These exist next to the shell because `cat`/`sed` round-trips
// cost far more tokens than a targeted read, and because quoting a big file
// body through a shell command is fragile on Windows.

import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';
import { resolveSafePath } from './guards.js';
import { truncateMiddle } from './format.js';

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz', '.tar',
  '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.wasm', '.mp3', '.mp4',
  '.mov', '.avi', '.woff', '.woff2', '.ttf', '.otf', '.bin', '.db', '.sqlite',
]);

function looksBinary(path, buf) {
  if (BINARY_EXT.has(extname(path).toLowerCase())) return true;
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function humanBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function splitLines(text) {
  // Keep the split lossless w.r.t. a trailing newline so writes round-trip.
  const lines = text.split('\n');
  const trailingNewline = lines.length > 1 && lines[lines.length - 1] === '';
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

function joinLines(lines, trailingNewline, eol = '\n') {
  return lines.join(eol) + (trailingNewline ? eol : '');
}

function detectEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

function numberLines(lines, startNo, width) {
  const w = width ?? String(startNo + lines.length - 1).length;
  return lines.map((l, i) => `${String(startNo + i).padStart(w, ' ')}│${l}`).join('\n');
}

// ------------------------------------------------------------------ read

export async function fileRead(cfg, p) {
  const abs = resolveSafePath(cfg, p.path);
  const st = await stat(abs).catch(() => null);
  if (!st) throw new Error(`File not found: ${abs}`);
  if (st.isDirectory()) throw new Error(`${abs} is a directory — use fs_list.`);

  const buf = await readFile(abs);
  const encoding = p.encoding || 'utf8';

  if (encoding === 'base64') {
    const b64 = buf.toString('base64');
    const cut = truncateMiddle(b64, p.max_bytes ?? cfg.maxOutputBytes);
    return `${abs} ${humanBytes(st.size)} base64${cut.truncated ? ' TRUNCATED' : ''}\n${cut.text}`;
  }

  if (looksBinary(abs, buf) && !p.force_text) {
    return `${abs} ${humanBytes(st.size)} appears BINARY (${extname(abs) || 'no ext'}). ` +
      `Use encoding="base64" for the bytes, or force_text=true to read as UTF-8 anyway.`;
  }

  const text = buf.toString('utf8');
  const { lines } = splitLines(text);
  const total = lines.length;
  const showNumbers = p.line_numbers !== false;
  const maxBytes = p.max_bytes ?? cfg.maxOutputBytes;

  // --- grep mode: only matching lines (+ context). Cheapest way to inspect
  // --- a big file when you know what you are looking for.
  if (p.match) {
    let re;
    try {
      re = new RegExp(p.match, p.match_flags ?? (p.ignore_case ? 'i' : ''));
    } catch (err) {
      throw new Error(`Invalid "match" regex: ${err.message}`);
    }
    const ctxN = Math.max(0, p.context ?? 0);
    const maxMatches = p.max_matches ?? 200;
    const keep = new Set();
    let hits = 0;
    for (let i = 0; i < total; i++) {
      if (re.test(lines[i])) {
        hits++;
        if (hits > maxMatches) break;
        for (let j = Math.max(0, i - ctxN); j <= Math.min(total - 1, i + ctxN); j++) keep.add(j);
      }
      re.lastIndex = 0;
    }
    if (hits === 0) return `${abs} ${total} lines — no line matches /${p.match}/`;

    const idx = [...keep].sort((a, b) => a - b);
    const chunks = [];
    let prev = -2;
    let cur = [];
    for (const i of idx) {
      if (i !== prev + 1 && cur.length) { chunks.push(cur); cur = []; }
      cur.push(i);
      prev = i;
    }
    if (cur.length) chunks.push(cur);

    const w = String(total).length;
    const body = chunks
      .map((c) => {
        const seg = c.map((i) => lines[i]);
        return showNumbers ? numberLines(seg, c[0] + 1, w) : seg.join('\n');
      })
      .join('\n  ---\n');
    const cut = truncateMiddle(body, maxBytes);
    return (
      `${abs} ${total} lines, ${hits} match${hits === 1 ? '' : 'es'} /${p.match}/` +
      `${hits > maxMatches ? ` (capped at ${maxMatches})` : ''}${cut.truncated ? ' TRUNCATED' : ''}\n${cut.text}`
    );
  }

  // --- range mode ---
  let from = 1;
  let to = total;
  if (p.tail_lines) {
    from = Math.max(1, total - Number(p.tail_lines) + 1);
  } else if (p.head_lines) {
    to = Math.min(total, Number(p.head_lines));
  } else {
    if (p.start_line !== undefined && p.start_line !== null) {
      from = Number(p.start_line) < 0 ? Math.max(1, total + Number(p.start_line) + 1) : Math.max(1, Number(p.start_line));
    }
    if (p.end_line !== undefined && p.end_line !== null) {
      to = Number(p.end_line) < 0 ? total + Number(p.end_line) + 1 : Math.min(total, Number(p.end_line));
    }
  }
  if (from > total) {
    return `${abs} has ${total} lines; start_line=${from} is past the end.`;
  }
  if (to < from) to = from;

  const seg = lines.slice(from - 1, to);
  const body = showNumbers ? numberLines(seg, from, String(total).length) : seg.join('\n');
  const cut = truncateMiddle(body, maxBytes);
  const ranged = from !== 1 || to !== total;

  return (
    `${abs} ${humanBytes(st.size)} lines ${from}-${to} of ${total}` +
    `${ranged ? '' : ' (whole file)'}${cut.truncated ? ' TRUNCATED' : ''}\n${cut.text}`
  );
}

// ----------------------------------------------------------------- write

export async function fileWrite(cfg, p) {
  const abs = resolveSafePath(cfg, p.path, { forWrite: true });
  if (typeof p.content !== 'string') throw new Error('content must be a string');

  const mode = p.mode || 'overwrite';
  const encoding = p.encoding || 'utf8';
  const existed = await stat(abs).then((s) => s, () => null);

  if (mode === 'create_new' && existed) {
    throw new Error(`Refusing to overwrite existing file (mode="create_new"): ${abs}`);
  }
  if (p.create_dirs !== false) await mkdir(dirname(abs), { recursive: true });

  if (encoding === 'base64') {
    const buf = Buffer.from(p.content, 'base64');
    await writeFile(abs, buf, { flag: mode === 'append' ? 'a' : 'w' });
    return `${mode === 'append' ? 'appended' : 'wrote'} ${humanBytes(buf.length)} (base64) -> ${abs}`;
  }

  let content = p.content;
  const eolPref = p.eol || 'keep';
  let eol = '\n';
  if (eolPref === 'crlf') eol = '\r\n';
  else if (eolPref === 'lf') eol = '\n';
  else if (existed) eol = detectEol(await readFile(abs, 'utf8').catch(() => '\n'));
  content = content.replace(/\r\n/g, '\n');
  if (eol !== '\n') content = content.replace(/\n/g, eol);
  if (p.ensure_trailing_newline !== false && content !== '' && !content.endsWith(eol)) content += eol;

  let finalText = content;
  if (mode === 'append') {
    const before = existed ? await readFile(abs, 'utf8') : '';
    finalText = before && !before.endsWith('\n') && !before.endsWith('\r\n') ? before + eol + content : before + content;
  } else if (mode === 'prepend') {
    const before = existed ? await readFile(abs, 'utf8') : '';
    finalText = content + before;
  }

  await writeFile(abs, finalText, 'utf8');
  const lineCount = splitLines(finalText).lines.length;
  const verb = mode === 'append' ? 'appended to' : mode === 'prepend' ? 'prepended to' : existed ? 'overwrote' : 'created';
  return `${verb} ${abs} — now ${humanBytes(Buffer.byteLength(finalText, 'utf8'))}, ${lineCount} lines`;
}

// ------------------------------------------------------------------ edit

/**
 * Apply several surgical edits in one call.
 *
 * Line numbers in EVERY op refer to the ORIGINAL file, and line-range ops must
 * not overlap — that makes a batch deterministic and lets the caller plan all
 * its edits from a single read.
 */
export async function fileEdit(cfg, p) {
  const abs = resolveSafePath(cfg, p.path, { forWrite: true });
  const st = await stat(abs).catch(() => null);
  if (!st) throw new Error(`File not found: ${abs}`);
  if (!Array.isArray(p.ops) || p.ops.length === 0) throw new Error('ops must be a non-empty array');

  const original = await readFile(abs, 'utf8');
  const eolStyle = p.eol === 'crlf' ? '\r\n' : p.eol === 'lf' ? '\n' : detectEol(original);
  const normalized = original.replace(/\r\n/g, '\n');
  let { lines, trailingNewline } = splitLines(normalized);
  const originalTotal = lines.length;

  const lineOps = [];
  const textOps = [];
  for (let i = 0; i < p.ops.length; i++) {
    const op = p.ops[i];
    if (!op || typeof op.type !== 'string') throw new Error(`ops[${i}] needs a "type"`);
    if (['replace_lines', 'delete_lines', 'insert_before', 'insert_after', 'insert_at'].includes(op.type)) {
      lineOps.push({ ...op, _i: i });
    } else if (['replace_text', 'regex_replace', 'append', 'prepend'].includes(op.type)) {
      textOps.push({ ...op, _i: i });
    } else {
      throw new Error(
        `ops[${i}] unknown type "${op.type}". Valid: replace_lines, delete_lines, ` +
        `insert_before, insert_after, replace_text, regex_replace, append, prepend`,
      );
    }
  }

  const log = [];

  // --- line ops: validate ranges against the original, then apply bottom-up
  const normed = lineOps.map((op) => {
    const isInsert = op.type.startsWith('insert');
    let start = Number(op.start_line ?? op.line ?? op.at);
    if (!Number.isFinite(start)) {
      throw new Error(`ops[${op._i}] (${op.type}) needs "start_line" (or "line")`);
    }
    if (start < 0) start = originalTotal + start + 1;
    let end = op.end_line === undefined || op.end_line === null ? start : Number(op.end_line);
    if (end < 0) end = originalTotal + end + 1;
    if (isInsert) end = start;
    if (start < 1 || (!isInsert && start > originalTotal)) {
      throw new Error(
        `ops[${op._i}] (${op.type}) start_line=${start} is out of range; file has ${originalTotal} lines`,
      );
    }
    if (end < start) throw new Error(`ops[${op._i}] end_line(${end}) < start_line(${start})`);
    if (!isInsert && end > originalTotal) end = originalTotal;
    return { ...op, start, end, isInsert };
  });

  const sorted = [...normed].sort((a, b) => b.start - a.start || b._i - a._i);
  for (let i = 1; i < sorted.length; i++) {
    const hi = sorted[i - 1];
    const lo = sorted[i];
    if (!lo.isInsert && !hi.isInsert && lo.end >= hi.start) {
      throw new Error(
        `Overlapping line ranges: ops[${lo._i}] (${lo.start}-${lo.end}) and ops[${hi._i}] (${hi.start}-${hi.end}). ` +
        `Line numbers always refer to the original file, so ranges must be disjoint.`,
      );
    }
  }

  for (const op of sorted) {
    const payload = op.content === undefined || op.content === null
      ? []
      : String(op.content).replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');

    if (op.expect_match !== undefined && op.expect_match !== null) {
      const actual = lines.slice(op.start - 1, op.end).join('\n');
      if (!actual.includes(String(op.expect_match))) {
        throw new Error(
          `ops[${op._i}] expect_match failed: lines ${op.start}-${op.end} do not contain ` +
          `${JSON.stringify(String(op.expect_match))}. Re-read the file — it may have changed.`,
        );
      }
    }

    switch (op.type) {
      case 'replace_lines':
        lines.splice(op.start - 1, op.end - op.start + 1, ...payload);
        log.push(`replaced lines ${op.start}-${op.end} with ${payload.length} line(s)`);
        break;
      case 'delete_lines':
        lines.splice(op.start - 1, op.end - op.start + 1);
        log.push(`deleted lines ${op.start}-${op.end}`);
        break;
      case 'insert_before':
      case 'insert_at':
        lines.splice(Math.max(0, op.start - 1), 0, ...payload);
        log.push(`inserted ${payload.length} line(s) before line ${op.start}`);
        break;
      case 'insert_after':
        lines.splice(Math.min(lines.length, op.start), 0, ...payload);
        log.push(`inserted ${payload.length} line(s) after line ${op.start}`);
        break;
      default:
        break;
    }
  }

  // --- text ops: applied in the given order on the result
  let text = joinLines(lines, trailingNewline, '\n');
  for (const op of textOps) {
    if (op.type === 'append') {
      const add = String(op.content ?? '').replace(/\r\n/g, '\n');
      text = text && !text.endsWith('\n') ? `${text}\n${add}` : text + add;
      log.push(`appended ${add.length} chars`);
      continue;
    }
    if (op.type === 'prepend') {
      const add = String(op.content ?? '').replace(/\r\n/g, '\n');
      text = add.endsWith('\n') ? add + text : `${add}\n${text}`;
      log.push(`prepended ${add.length} chars`);
      continue;
    }
    if (op.type === 'replace_text') {
      const oldStr = String(op.old ?? op.old_string ?? '').replace(/\r\n/g, '\n');
      if (oldStr === '') throw new Error(`ops[${op._i}] replace_text needs a non-empty "old"`);
      const newStr = String(op.new ?? op.new_string ?? '').replace(/\r\n/g, '\n');
      const count = occurrences(text, oldStr);
      const expected = op.expect_count ?? (op.all ? null : 1);
      if (count === 0) {
        throw new Error(`ops[${op._i}] replace_text: ${JSON.stringify(short(oldStr))} not found in ${abs}`);
      }
      if (expected !== null && expected !== undefined && count !== Number(expected)) {
        throw new Error(
          `ops[${op._i}] replace_text: found ${count} occurrence(s) of ${JSON.stringify(short(oldStr))}, ` +
          `expected ${expected}. Pass all=true to replace every one, or expect_count=${count}.`,
        );
      }
      text = op.all || count > 1 ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
      log.push(`replaced ${op.all || count > 1 ? count : 1} occurrence(s) of ${JSON.stringify(short(oldStr, 40))}`);
      continue;
    }
    if (op.type === 'regex_replace') {
      let re;
      try {
        re = new RegExp(op.pattern, op.flags ?? 'g');
      } catch (err) {
        throw new Error(`ops[${op._i}] invalid regex: ${err.message}`);
      }
      const before = text;
      const hits = (text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length;
      if (hits === 0 && op.allow_no_match !== true) {
        throw new Error(`ops[${op._i}] regex_replace: /${op.pattern}/ matched nothing in ${abs}`);
      }
      text = before.replace(re, String(op.replacement ?? ''));
      log.push(`regex_replace /${op.pattern}/ -> ${hits} match(es)`);
    }
  }

  const finalText = eolStyle === '\n' ? text : text.replace(/\n/g, eolStyle);
  const newTotal = splitLines(text).lines.length;

  if (p.dry_run) {
    const preview = diffPreview(normalized, text, p.preview_context ?? 2);
    return (
      `DRY RUN — ${abs} would go from ${originalTotal} to ${newTotal} lines\n` +
      log.map((l) => `- ${l}`).join('\n') +
      (preview ? `\n--- preview ---\n${preview}` : '')
    );
  }

  await writeFile(abs, finalText, 'utf8');
  return (
    `edited ${abs} — ${originalTotal} -> ${newTotal} lines, ` +
    `${humanBytes(Buffer.byteLength(finalText, 'utf8'))}\n` +
    log.map((l) => `- ${l}`).join('\n')
  );
}

function occurrences(hay, needle) {
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

function short(s, max = 80) {
  const flat = s.replace(/\n/g, '\\n');
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/**
 * Minimal hunk preview: trim the common prefix/suffix of the two versions and
 * print what is left. Not a real LCS diff, but enough to sanity-check an edit
 * without spending tokens on the whole file.
 */
function diffPreview(before, after, ctx) {
  const a = before.split('\n');
  const b = after.split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  if (s === a.length && a.length === b.length) return '(no change)';

  const out = [];
  for (let i = Math.max(0, s - ctx); i < s; i++) out.push(`  ${i + 1}│${a[i]}`);
  for (let i = s; i < a.length - e; i++) out.push(`- ${i + 1}│${a[i]}`);
  for (let i = s; i < b.length - e; i++) out.push(`+ ${i + 1}│${b[i]}`);
  for (let i = a.length - e; i < Math.min(a.length, a.length - e + ctx); i++) out.push(`  ${i + 1}│${a[i]}`);
  return truncateMiddle(out.join('\n'), 4000).text;
}

// ------------------------------------------------------------------ list

export async function fsList(cfg, p) {
  const abs = resolveSafePath(cfg, p.path ?? '.');
  const st = await stat(abs).catch(() => null);
  if (!st) throw new Error(`Path not found: ${abs}`);
  if (!st.isDirectory()) {
    return `${abs} ${humanBytes(st.size)} file, modified ${new Date(st.mtimeMs).toISOString()}`;
  }

  const depth = Math.max(1, p.depth ?? 1);
  const maxEntries = p.max_entries ?? 500;
  const skipDirs = new Set(p.skip_dirs ?? ['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build', '.next', 'target']);
  let re = null;
  if (p.pattern) {
    try {
      re = new RegExp(globToRegex(p.pattern), 'i');
    } catch (err) {
      throw new Error(`Invalid pattern: ${err.message}`);
    }
  }

  const rows = [];
  let truncated = false;
  let skipped = 0;

  async function walk(dir, level, prefix) {
    if (rows.length >= maxEntries) { truncated = true; return; }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      rows.push({ name: `${prefix}<unreadable: ${err.code}>`, dir: false, size: 0, mtime: 0 });
      return;
    }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const ent of entries) {
      if (rows.length >= maxEntries) { truncated = true; return; }
      if (!p.show_hidden && ent.name.startsWith('.') && ent.name !== '.env') { skipped++; continue; }
      const rel = prefix + ent.name;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name)) { rows.push({ name: `${rel}/`, dir: true, size: 0, mtime: 0, note: 'skipped' }); continue; }
        if (!re || re.test(rel)) rows.push({ name: `${rel}/`, dir: true, size: 0, mtime: 0 });
        if (level < depth) await walk(full, level + 1, `${rel}/`);
      } else {
        if (re && !re.test(rel)) continue;
        let size = 0;
        let mtime = 0;
        if (p.details !== false) {
          const s = await stat(full).catch(() => null);
          if (s) { size = s.size; mtime = s.mtimeMs; }
        }
        rows.push({ name: rel, dir: false, size, mtime });
      }
    }
  }

  await walk(abs, 1, '');

  const body = rows
    .map((r) => {
      if (r.dir) return `${r.name}${r.note ? `  (${r.note})` : ''}`;
      return p.details === false ? r.name : `${r.name}  ${humanBytes(r.size)}`;
    })
    .join('\n');

  const header =
    `${abs} — ${rows.filter((r) => !r.dir).length} files, ${rows.filter((r) => r.dir).length} dirs` +
    ` (depth=${depth}${p.pattern ? `, pattern=${p.pattern}` : ''})` +
    `${truncated ? ` TRUNCATED at ${maxEntries}` : ''}` +
    `${skipped && !p.show_hidden ? `, ${skipped} hidden` : ''}`;

  return `${header}\n${truncateMiddle(body, p.max_bytes ?? cfg.maxOutputBytes).text}`;
}

function globToRegex(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { out += '.*'; i++; } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) out += `\\${c}`;
    else out += c;
  }
  return `^${out}$|${out}$`;
}

