// Group: archive — create, inspect and extract zip / tar / tar.gz / gz.

import { readFile, writeFile, mkdir, stat, lstat, chmod, utimes } from 'node:fs/promises';
import { dirname, resolve, sep, basename } from 'node:path';
import process from 'node:process';
import { resolveSafePath } from '../guards.js';
import { walkAll } from '../walk.js';
import { compileGlobList } from '../glob.js';
import { truncateMiddle } from '../format.js';
import {
  createZip, listZip, readZipEntry, createTar, listTar,
  gzipSync, gunzipSync, detectFormat,
} from '../archive.js';

export const TOOLS = [
  {
    name: 'archive',
    description:
      'Create, list and extract archives: zip, tar, tar.gz (tgz) and plain gzip. Implemented in ' +
      'process, so it behaves the same on Windows, macOS and Linux with no zip/tar binary needed. ' +
      'create takes a directory or a file list (with glob filters); extract refuses paths that ' +
      'escape the destination.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'extract', 'gzip', 'gunzip'], description: 'What to do.' },
        path: { type: 'string', description: 'The archive file. For create, the archive to write.' },
        from: { type: 'string', description: 'create: directory (or single file) to pack.' },
        files: { type: 'array', items: { type: 'string' }, description: 'create: explicit file list instead of "from".' },
        to: { type: 'string', description: 'extract: destination directory. gzip/gunzip: output file.' },
        format: { type: 'string', enum: ['zip', 'tar', 'tar.gz', 'gz'], description: 'Override the format. Default: inferred from the file name, then the magic bytes.' },
        glob: { type: 'array', items: { type: 'string' }, description: 'create/extract: only these paths (globs).' },
        exclude: { type: 'array', items: { type: 'string' }, description: 'create/extract: skip these paths (globs).' },
        base: { type: 'string', description: 'create: strip this leading path from stored names. Default: the "from" directory.' },
        strip_components: { type: 'integer', description: 'extract: drop this many leading path segments, like tar --strip-components.' },
        overwrite: { type: 'boolean', description: 'extract: replace existing files. Default false (they are skipped).' },
        level: { type: 'integer', description: 'create/gzip: compression level 0-9. Default 6; 0 stores without compressing.' },
        show_hidden: { type: 'boolean', description: 'create: include dotfiles. Default true.' },
        skip_dirs: { type: 'array', items: { type: 'string' }, description: 'create: directory names not to pack.' },
        max_bytes: { type: 'integer', description: 'Byte cap on returned output.' },
      },
      required: ['action', 'path'],
    },
  },
];

function humanBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

/**
 * Guard against zip-slip: an archive entry named "../../etc/passwd" must not
 * write outside the destination. Absolute paths and drive letters are stripped
 * and the resolved result is checked to still live under `destRoot`.
 */
function safeJoin(destRoot, entryName) {
  const cleaned = String(entryName)
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:/, '')
    .replace(/^\/+/, '')
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.' && seg !== '..')
    .join('/');
  if (!cleaned) return null;
  const abs = resolve(destRoot, cleaned);
  const root = destRoot.endsWith(sep) ? destRoot : destRoot + sep;
  if (abs !== destRoot && !abs.startsWith(root)) return null;
  return { abs, rel: cleaned };
}

function stripComponents(name, n) {
  if (!n) return name;
  const parts = name.split('/');
  return parts.slice(Math.min(n, parts.length - 1)).join('/');
}

export function createHandlers({ cfg }) {
  return {
    async archive(p) {
      const a = p.action;
      if (!a) throw new Error('"action" is required: create | list | extract | gzip | gunzip');

      // ------------------------------------------------------------ create
      if (a === 'create') {
        const target = resolveSafePath(cfg, p.path, { forWrite: true });
        const format = p.format || detectFormat(target, null) || 'zip';
        if (format === 'gz') {
          throw new Error('format "gz" compresses a single file — use action="gzip" instead.');
        }

        const include = compileGlobList(p.glob);
        const exclude = compileGlobList(p.exclude);
        const hasExclude = Boolean(p.exclude && p.exclude.length);
        const entries = [];

        if (Array.isArray(p.files) && p.files.length) {
          const base = p.base ? resolveSafePath(cfg, p.base) : cfg.cwd;
          for (const f of p.files) {
            const abs = resolveSafePath(cfg, f);
            const st = await lstat(abs).catch(() => null);
            if (!st || st.isDirectory()) continue;
            const rel = abs.startsWith(base) ? abs.slice(base.length).replace(/^[\\/]+/, '') : basename(abs);
            entries.push({
              name: rel.replace(/\\/g, '/'),
              data: await readFile(abs),
              mtime: st.mtime,
              mode: st.mode & 0o7777,
            });
          }
        } else {
          if (!p.from) throw new Error('create needs "from" (a directory) or "files" (a list)');
          const from = resolveSafePath(cfg, p.from);
          const st = await stat(from).catch(() => null);
          if (!st) throw new Error(`Source not found: ${from}`);

          if (st.isFile()) {
            entries.push({
              name: basename(from),
              data: await readFile(from),
              mtime: st.mtime,
              mode: st.mode & 0o7777,
            });
          } else {
            const { items, truncated } = await walkAll(from, {
              maxDepth: 64,
              showHidden: p.show_hidden !== false,
              skipDirs: p.skip_dirs ?? ['.git'],
              maxEntries: 20000,
            });
            if (truncated) throw new Error('Refusing to pack more than 20000 files in one call.');
            for (const item of items) {
              if (!include(item.relPath)) continue;
              if (hasExclude && exclude(item.relPath)) continue;
              const fst = await lstat(item.absPath).catch(() => null);
              if (!fst || !fst.isFile()) continue;
              entries.push({
                name: item.relPath,
                data: await readFile(item.absPath),
                mtime: fst.mtime,
                mode: fst.mode & 0o7777,
              });
            }
          }
        }

        if (!entries.length) throw new Error('Nothing to pack (no files matched).');
        const rawBytes = entries.reduce((n, e) => n + e.data.length, 0);

        let out;
        if (format === 'zip') out = createZip(entries, { level: p.level ?? 6 });
        else if (format === 'tar') out = createTar(entries);
        else out = gzipSync(createTar(entries), { level: p.level ?? 6 });

        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, out);
        const ratio = rawBytes ? Math.round((1 - out.length / rawBytes) * 100) : 0;
        return (
          `created ${target} (${format}) — ${entries.length} file(s), ` +
          `${humanBytes(rawBytes)} -> ${humanBytes(out.length)} (${ratio}% smaller)`
        );
      }

      // -------------------------------------------------------------- gzip
      if (a === 'gzip') {
        const src = resolveSafePath(cfg, p.path);
        const dest = resolveSafePath(cfg, p.to ?? `${p.path}.gz`, { forWrite: true });
        const data = await readFile(src);
        const out = gzipSync(data, { level: p.level ?? 6 });
        await writeFile(dest, out);
        return `gzipped ${src} -> ${dest} (${humanBytes(data.length)} -> ${humanBytes(out.length)})`;
      }

      if (a === 'gunzip') {
        const src = resolveSafePath(cfg, p.path);
        const data = await readFile(src);
        const stripped = String(p.path).replace(/\.gz$/, '');
        const dest = resolveSafePath(cfg, p.to ?? (stripped === String(p.path) ? `${p.path}.out` : stripped), {
          forWrite: true,
        });
        const out = gunzipSync(data);
        await writeFile(dest, out);
        return `gunzipped ${src} -> ${dest} (${humanBytes(data.length)} -> ${humanBytes(out.length)})`;
      }

      // ------------------------------------------------------ list/extract
      const archivePath = resolveSafePath(cfg, p.path);
      const buf = await readFile(archivePath).catch(() => null);
      if (!buf) throw new Error(`Archive not found: ${archivePath}`);
      const format = p.format || detectFormat(archivePath, buf);
      if (!format) {
        throw new Error(
          `Cannot tell the format of ${archivePath} from its name or contents — pass format explicitly.`,
        );
      }

      let items;
      if (format === 'zip') {
        items = listZip(buf).map((e) => ({ ...e, read: () => readZipEntry(buf, e) }));
      } else if (format === 'tar' || format === 'tar.gz') {
        const plain = format === 'tar.gz' ? gunzipSync(buf) : buf;
        items = listTar(plain, { withData: a === 'extract' }).map((e) => ({ ...e, read: () => e.data ?? Buffer.alloc(0) }));
      } else {
        // A bare .gz holds one stream, not a listing.
        const inner = gunzipSync(buf);
        if (a === 'list') {
          return `${archivePath} — gzip stream, ${humanBytes(buf.length)} compressed, ${humanBytes(inner.length)} raw`;
        }
        const dest = resolveSafePath(cfg, p.to ?? String(p.path).replace(/\.gz$/, ''), { forWrite: true });
        await writeFile(dest, inner);
        return `extracted gzip ${archivePath} -> ${dest} (${humanBytes(inner.length)})`;
      }

      if (a === 'list') {
        const files = items.filter((e) => !e.isDir);
        const rawTotal = files.reduce((n, e) => n + e.size, 0);
        const rows = items.map((e) => {
          const name = e.isDir ? `${e.name.replace(/\/$/, '')}/` : e.name;
          return e.isDir ? name : `${humanBytes(e.size).padStart(9)}  ${name}`;
        });
        return (
          `${archivePath} (${format}) — ${files.length} file(s), ${items.length - files.length} dir(s), ` +
          `${humanBytes(rawTotal)} uncompressed, ${humanBytes(buf.length)} on disk\n` +
          truncateMiddle(rows.join('\n'), p.max_bytes ?? cfg.maxOutputBytes).text
        );
      }

      if (a !== 'extract') {
        throw new Error(`Unknown archive action "${a}": create | list | extract | gzip | gunzip`);
      }

      const destRoot = resolveSafePath(cfg, p.to ?? '.', { forWrite: true });
      await mkdir(destRoot, { recursive: true });
      const include = compileGlobList(p.glob);
      const exclude = compileGlobList(p.exclude);
      const hasExclude = Boolean(p.exclude && p.exclude.length);

      let written = 0;
      let skipped = 0;
      let bytes = 0;
      const refused = [];

      for (const entry of items) {
        const logicalName = stripComponents(entry.name.replace(/\\/g, '/'), p.strip_components ?? 0);
        if (!logicalName) continue;
        if (!include(logicalName)) continue;
        if (hasExclude && exclude(logicalName)) continue;

        const safe = safeJoin(destRoot, logicalName);
        if (!safe) {
          refused.push(entry.name);
          continue;
        }

        if (entry.isDir) {
          await mkdir(safe.abs, { recursive: true });
          continue;
        }

        const exists = await lstat(safe.abs).then(() => true, () => false);
        if (exists && !p.overwrite) { skipped++; continue; }

        await mkdir(dirname(safe.abs), { recursive: true });
        const data = entry.read();
        await writeFile(safe.abs, data);
        bytes += data.length;
        written++;
        if (entry.mode && process.platform !== 'win32') {
          await chmod(safe.abs, entry.mode & 0o7777).catch(() => {});
        }
        if (entry.mtime) await utimes(safe.abs, entry.mtime, entry.mtime).catch(() => {});
      }

      const out = [
        `extracted ${archivePath} (${format}) -> ${destRoot} — ` +
        `${written} file(s), ${humanBytes(bytes)}` +
        `${skipped ? `, ${skipped} skipped (already exist; pass overwrite:true)` : ''}`,
      ];
      if (refused.length) {
        out.push(
          `REFUSED ${refused.length} entr${refused.length === 1 ? 'y' : 'ies'} whose path escaped the ` +
          `destination: ${refused.slice(0, 5).join(', ')}${refused.length > 5 ? ', ...' : ''}`,
        );
      }
      return out.join('\n');
    },
  };
}

