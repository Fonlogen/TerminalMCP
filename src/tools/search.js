// Group: search — grep and find across a tree, plus project-wide replace.
//
// These matter most for token cost: reading whole files to locate one symbol
// is the single most expensive habit an agent has.

import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolveSafePath } from '../guards.js';
import { compileGlobList } from '../glob.js';
import { walk, looksBinaryPath, looksBinaryBuffer, DEFAULT_SKIP_DIRS } from '../walk.js';
import { truncateMiddle } from '../format.js';
import { unifiedDiff } from '../diff.js';

const P = {
  path: { type: 'string', description: 'File or directory to search. Default: server cwd.' },
  glob: {
    type: 'array',
    items: { type: 'string' },
    description: 'Only these paths, as globs: ["*.ts","src/**/*.js"]. A pattern without "/" matches the basename at any depth.',
  },
  exclude: { type: 'array', items: { type: 'string' }, description: 'Globs to skip.' },
  maxBytes: { type: 'integer', description: 'Byte cap on the returned text. Lower it to save tokens.' },
};

export const TOOLS = [
  {
    name: 'search_text',
    description:
      'Grep a whole tree: regex (or literal) across files, returning only matching lines with ' +
      'file:line and optional context. Skips .git/node_modules/build dirs and binaries, honours ' +
      '.gitignore. Use files_only=true to just locate files, count_only=true for tallies. ' +
      'Set replace= to rewrite every match (dry_run=true first shows a diff).',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex to search for (JS syntax), or a literal string when literal=true.' },
        path: P.path,
        glob: P.glob,
        exclude: P.exclude,
        literal: { type: 'boolean', description: 'Treat pattern as plain text, not a regex.' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive match.' },
        word: { type: 'boolean', description: 'Match whole words only.' },
        multiline: { type: 'boolean', description: 'Let the pattern span lines (. matches newline).' },
        context: { type: 'integer', description: 'Lines of context on both sides of each match.' },
        max_results: { type: 'integer', description: 'Stop after this many matching lines. Default 200.' },
        max_files: { type: 'integer', description: 'Stop after this many files with matches. Default 100.' },
        files_only: { type: 'boolean', description: 'Return just the list of matching file paths — the cheapest mode.' },
        count_only: { type: 'boolean', description: 'Return just a match count per file.' },
        max_depth: { type: 'integer', description: 'Recursion depth. Default 24.' },
        max_file_bytes: { type: 'integer', description: 'Skip files bigger than this. Default 2000000.' },
        skip_dirs: { type: 'array', items: { type: 'string' }, description: 'Directory names not to enter (replaces the default list).' },
        show_hidden: { type: 'boolean', description: 'Search dotfiles too.' },
        respect_gitignore: { type: 'boolean', description: 'Honour .gitignore. Default true.' },
        replace: { type: 'string', description: 'Replacement text ($1 backrefs work). Rewrites the files unless dry_run=true.' },
        dry_run: { type: 'boolean', description: 'With replace: show the diff without writing.' },
        max_bytes: P.maxBytes,
      },
      required: ['pattern'],
    },
  },

  {
    name: 'search_files',
    description:
      'Find files and directories by name glob, size, age or type — the `find` you would otherwise ' +
      'shell out for, with consistent output on every platform. Sorts by path, size or mtime.',
    inputSchema: {
      type: 'object',
      properties: {
        path: P.path,
        glob: P.glob,
        exclude: P.exclude,
        name: { type: 'string', description: 'Regex on the file name (alternative to glob).' },
        type: { type: 'string', enum: ['file', 'dir', 'any'], description: 'What to return. Default file.' },
        min_size: { type: 'integer', description: 'Only entries at least this many bytes.' },
        max_size: { type: 'integer', description: 'Only entries at most this many bytes.' },
        modified_within_hours: { type: 'number', description: 'Only entries touched in the last N hours.' },
        modified_before_hours: { type: 'number', description: 'Only entries untouched for at least N hours.' },
        max_depth: { type: 'integer', description: 'Recursion depth. Default 24.' },
        sort: { type: 'string', enum: ['path', 'size', 'mtime'], description: 'Ordering. size and mtime sort descending.' },
        limit: { type: 'integer', description: 'Max entries returned. Default 300.' },
        show_hidden: { type: 'boolean', description: 'Include dotfiles.' },
        respect_gitignore: { type: 'boolean', description: 'Honour .gitignore. Default true.' },
        skip_dirs: { type: 'array', items: { type: 'string' }, description: 'Directory names not to enter.' },
        details: { type: 'boolean', description: 'Include size and mtime. Default true.' },
        max_bytes: P.maxBytes,
      },
    },
  },
];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPattern(p) {
  let src = p.literal ? escapeRe(p.pattern) : p.pattern;
  if (p.word) src = `\\b(?:${src})\\b`;
  let flags = 'g';
  if (p.ignore_case) flags += 'i';
  if (p.multiline) flags += 's';
  try {
    return new RegExp(src, flags);
  } catch (err) {
    throw new Error(`Invalid pattern /${src}/: ${err.message}`);
  }
}

function humanBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

function ago(mtimeMs) {
  const s = Math.max(0, (Date.now() - mtimeMs) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Files to scan: either the single file given, or a walk of the directory. */
async function* candidates(cfg, p, root, isDir) {
  if (!isDir) {
    const st = await stat(root).catch(() => null);
    yield { absPath: root, relPath: root, size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0 };
    return;
  }
  yield* walk(root, {
    maxDepth: p.max_depth ?? 24,
    skipDirs: p.skip_dirs ?? DEFAULT_SKIP_DIRS,
    showHidden: p.show_hidden === true,
    respectGitignore: p.respect_gitignore !== false,
    includeDirs: false,
  });
}

export function createHandlers({ cfg }) {
  return {
    async search_text(p) {
      if (typeof p.pattern !== 'string' || p.pattern === '') {
        throw new Error('"pattern" is required');
      }
      const root = resolveSafePath(cfg, p.path ?? '.');
      const st = await stat(root).catch(() => null);
      if (!st) throw new Error(`Path not found: ${root}`);

      const re = buildPattern(p);
      const include = compileGlobList(p.glob);
      const exclude = compileGlobList(p.exclude);
      const hasExclude = Boolean(p.exclude && p.exclude.length);
      const maxResults = p.max_results ?? 200;
      const maxFiles = p.max_files ?? 100;
      const maxFileBytes = p.max_file_bytes ?? 2_000_000;
      const ctxN = Math.max(0, p.context ?? 0);
      const doReplace = typeof p.replace === 'string';
      if (doReplace && p.dry_run !== true) resolveSafePath(cfg, root, { forWrite: true });

      const perFile = [];
      let totalMatches = 0;
      let scanned = 0;
      let skippedBinary = 0;
      let skippedBig = 0;
      let capped = false;
      let filesChanged = 0;

      for await (const entry of candidates(cfg, p, root, st.isDirectory())) {
        if (perFile.length >= maxFiles || totalMatches >= maxResults) { capped = true; break; }
        if (!include(entry.relPath)) continue;
        if (hasExclude && exclude(entry.relPath)) continue;
        if (looksBinaryPath(entry.absPath)) { skippedBinary++; continue; }
        if (entry.size > maxFileBytes) { skippedBig++; continue; }

        const buf = await readFile(entry.absPath).catch(() => null);
        if (!buf) continue;
        if (looksBinaryBuffer(buf)) { skippedBinary++; continue; }
        scanned++;

        const text = buf.toString('utf8');
        re.lastIndex = 0;
        if (!re.test(text)) continue;

        if (doReplace) {
          re.lastIndex = 0;
          const updated = text.replace(re, p.replace);
          if (updated === text) continue;
          re.lastIndex = 0;
          const count = (text.match(re) || []).length;
          totalMatches += count;
          if (p.dry_run) {
            perFile.push({
              relPath: entry.relPath,
              count,
              diff: unifiedDiff(text, updated, { aName: entry.relPath, bName: `${entry.relPath} (after)`, context: 1 }),
            });
          } else {
            await writeFile(entry.absPath, updated, 'utf8');
            filesChanged++;
            perFile.push({ relPath: entry.relPath, count });
          }
          continue;
        }

        const lines = text.split('\n');
        const hits = [];
        for (let i = 0; i < lines.length; i++) {
          re.lastIndex = 0;
          if (!re.test(lines[i])) continue;
          hits.push(i);
          if (totalMatches + hits.length >= maxResults) { capped = true; break; }
        }
        // A multiline pattern can match across lines and hit nothing per-line.
        if (!hits.length) {
          re.lastIndex = 0;
          const m = re.exec(text);
          if (m) hits.push(text.slice(0, m.index).split('\n').length - 1);
        }
        if (!hits.length) continue;

        totalMatches += hits.length;
        perFile.push({ relPath: entry.relPath, count: hits.length, hits, lines });
      }

      // ---- rendering -----------------------------------------------------
      const label = `/${p.pattern}/${p.ignore_case ? 'i' : ''}`;
      const head = [];

      if (doReplace) {
        head.push(
          `${p.dry_run ? 'DRY RUN — ' : ''}replace ${label} -> ${JSON.stringify(p.replace)}: ` +
          `${totalMatches} match(es) in ${perFile.length} file(s)` +
          (p.dry_run ? '' : `, ${filesChanged} rewritten`),
        );
        const body = perFile
          .map((f) => (f.diff ? `${f.relPath} (${f.count})\n${f.diff}` : `${f.relPath} — ${f.count} replaced`))
          .join('\n\n');
        return `${head.join('\n')}\n${truncateMiddle(body, p.max_bytes ?? cfg.maxOutputBytes).text}` +
          (p.dry_run && perFile.length ? '\nRe-run without dry_run to apply.' : '');
      }

      if (!perFile.length) {
        return `${label}: no matches (${scanned} file(s) scanned` +
          `${skippedBinary ? `, ${skippedBinary} binary skipped` : ''}` +
          `${skippedBig ? `, ${skippedBig} oversized skipped` : ''})`;
      }

      head.push(
        `${label}: ${totalMatches} match(es) in ${perFile.length} file(s), ` +
        `${scanned} scanned${capped ? ' (CAPPED — raise max_results/max_files)' : ''}`,
      );

      if (p.files_only) {
        return `${head.join('\n')}\n${perFile.map((f) => `${f.relPath} (${f.count})`).join('\n')}`;
      }
      if (p.count_only) {
        return `${head.join('\n')}\n${perFile.map((f) => `${String(f.count).padStart(6)} ${f.relPath}`).join('\n')}`;
      }

      const blocks = perFile.map((f) => {
        const keep = new Set();
        for (const i of f.hits) {
          for (let j = Math.max(0, i - ctxN); j <= Math.min(f.lines.length - 1, i + ctxN); j++) keep.add(j);
        }
        const idx = [...keep].sort((a, b) => a - b);
        const width = String(idx[idx.length - 1] + 1).length;
        const rows = [];
        let prev = -2;
        for (const i of idx) {
          if (i !== prev + 1 && prev !== -2) rows.push('  ---');
          const marker = f.hits.includes(i) ? ':' : '-';
          rows.push(`${String(i + 1).padStart(width)}${marker}${f.lines[i]}`);
          prev = i;
        }
        return `${f.relPath} (${f.count})\n${rows.join('\n')}`;
      });

      const cut = truncateMiddle(blocks.join('\n\n'), p.max_bytes ?? cfg.maxOutputBytes);
      return `${head.join('\n')}${cut.truncated ? ' TRUNCATED' : ''}\n${cut.text}`;
    },

    async search_files(p) {
      const root = resolveSafePath(cfg, p.path ?? '.');
      const st = await stat(root).catch(() => null);
      if (!st) throw new Error(`Path not found: ${root}`);
      if (!st.isDirectory()) throw new Error(`${root} is a file — pass a directory.`);

      const include = compileGlobList(p.glob);
      const exclude = compileGlobList(p.exclude);
      const hasExclude = Boolean(p.exclude && p.exclude.length);
      const nameRe = p.name ? new RegExp(p.name, 'i') : null;
      const type = p.type || 'file';
      const limit = p.limit ?? 300;
      const now = Date.now();

      const rows = [];
      let considered = 0;
      let capped = false;

      for await (const e of walk(root, {
        maxDepth: p.max_depth ?? 24,
        skipDirs: p.skip_dirs,
        includeDirs: type !== 'file',
        showHidden: p.show_hidden === true,
        respectGitignore: p.respect_gitignore !== false,
      })) {
        considered++;
        if (type === 'dir' && !e.isDir) continue;
        if (type === 'file' && e.isDir) continue;
        if (!include(e.relPath)) continue;
        if (hasExclude && exclude(e.relPath)) continue;
        if (nameRe && !nameRe.test(e.relPath.split('/').pop())) continue;
        if (!e.isDir) {
          if (p.min_size !== undefined && e.size < p.min_size) continue;
          if (p.max_size !== undefined && e.size > p.max_size) continue;
        }
        if (p.modified_within_hours !== undefined && now - e.mtimeMs > p.modified_within_hours * 3600e3) continue;
        if (p.modified_before_hours !== undefined && now - e.mtimeMs < p.modified_before_hours * 3600e3) continue;

        rows.push(e);
        if (rows.length > limit * 4) { capped = true; break; } // keep memory bounded
      }

      if (p.sort === 'size') rows.sort((a, b) => b.size - a.size);
      else if (p.sort === 'mtime') rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
      else rows.sort((a, b) => a.relPath.localeCompare(b.relPath));

      const shown = rows.slice(0, limit);
      if (!shown.length) return `${root}: nothing matched (${considered} entries considered)`;

      const details = p.details !== false;
      const body = shown
        .map((e) => {
          const name = e.isDir ? `${e.relPath}/` : e.relPath;
          if (!details || e.isDir) return name;
          return `${name}  ${humanBytes(e.size)}  ${ago(e.mtimeMs)}`;
        })
        .join('\n');

      const header =
        `${root}: ${shown.length} of ${rows.length} match(es)` +
        `${rows.length > shown.length || capped ? ` (showing ${shown.length}, raise limit for more)` : ''}` +
        `${p.sort ? ` sorted by ${p.sort}` : ''}`;
      return `${header}\n${truncateMiddle(body, p.max_bytes ?? cfg.maxOutputBytes).text}`;
    },
  };
}
