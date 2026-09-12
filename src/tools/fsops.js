// Group: fs — the filesystem verbs that are not reading or writing content.

import {
  copyFile, cp, rename, rm, mkdir, stat, lstat, chmod, symlink, readlink,
  utimes, open, readdir,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import process from 'node:process';
import { resolveSafePath } from '../guards.js';
import { walk, walkAll } from '../walk.js';
import { truncateMiddle } from '../format.js';

const ACTIONS = [
  'copy', 'move', 'delete', 'mkdir', 'touch', 'stat', 'chmod',
  'symlink', 'readlink', 'hash', 'disk_usage', 'tree',
];

export const TOOLS = [
  {
    name: 'fs_op',
    description:
      'Filesystem operations other than reading/writing content: copy, move, delete, mkdir, touch, ' +
      'stat, chmod, symlink, readlink, hash (md5/sha1/sha256/sha512), disk_usage (recursive size, ' +
      'biggest files), tree (indented listing). Works on files and directories; recursive where it ' +
      'makes sense. delete refuses a non-empty directory unless recursive=true.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'Operation to perform.' },
        path: { type: 'string', description: 'Target path (the source, for copy/move).' },
        to: { type: 'string', description: 'Destination path for copy, move and symlink.' },
        recursive: { type: 'boolean', description: 'copy/delete: include directory contents. Required to delete a non-empty directory.' },
        force: { type: 'boolean', description: 'copy/move: overwrite the destination if it exists. delete: ignore a missing path.' },
        mode: { type: 'string', description: 'chmod: octal mode as a string, e.g. "755". mkdir: mode for new directories.' },
        algorithm: { type: 'string', enum: ['md5', 'sha1', 'sha256', 'sha512'], description: 'hash: digest to use. Default sha256.' },
        depth: { type: 'integer', description: 'tree: levels to show (default 3). disk_usage: levels to break down (default 2).' },
        top: { type: 'integer', description: 'disk_usage: how many biggest entries to list. Default 15.' },
        show_hidden: { type: 'boolean', description: 'tree/disk_usage: include dotfiles.' },
        skip_dirs: { type: 'array', items: { type: 'string' }, description: 'tree/disk_usage: directory names not to enter.' },
        max_entries: { type: 'integer', description: 'tree: cap on listed entries. Default 400.' },
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

function modeString(mode) {
  const perm = (mode & 0o777).toString(8).padStart(3, '0');
  const bits = ['r', 'w', 'x'];
  let sym = '';
  for (let shift = 6; shift >= 0; shift -= 3) {
    const triad = (mode >> shift) & 7;
    for (let b = 0; b < 3; b++) sym += triad & (4 >> b) ? bits[b] : '-';
  }
  return `${perm} (${sym})`;
}

async function hashFile(path, algorithm) {
  return new Promise((resolve, reject) => {
    const h = createHash(algorithm);
    const s = createReadStream(path);
    s.on('error', reject);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

export function createHandlers({ cfg }) {
  return {
    async fs_op(p) {
      const a = p.action;
      if (!a) throw new Error(`"action" is required. One of: ${ACTIONS.join(', ')}`);
      const writeAction = !['stat', 'readlink', 'hash', 'disk_usage', 'tree'].includes(a);
      const src = resolveSafePath(cfg, p.path, { forWrite: writeAction });

      switch (a) {
        case 'copy': {
          if (!p.to) throw new Error('copy needs "to"');
          const dest = resolveSafePath(cfg, p.to, { forWrite: true });
          const st = await lstat(src).catch(() => null);
          if (!st) throw new Error(`Source not found: ${src}`);
          const exists = await lstat(dest).then(() => true, () => false);
          if (exists && !p.force) {
            throw new Error(`Destination exists: ${dest} (pass force:true to overwrite)`);
          }
          await mkdir(dirname(dest), { recursive: true });
          if (st.isDirectory()) {
            if (!p.recursive) throw new Error(`${src} is a directory — pass recursive:true`);
            await cp(src, dest, { recursive: true, force: true });
            const { items } = await walkAll(dest, { showHidden: true, maxDepth: 64 });
            return `copied directory ${src} -> ${dest} (${items.length} file(s))`;
          }
          await copyFile(src, dest);
          return `copied ${src} -> ${dest} (${humanBytes(st.size)})`;
        }

        case 'move': {
          if (!p.to) throw new Error('move needs "to"');
          const dest = resolveSafePath(cfg, p.to, { forWrite: true });
          const exists = await lstat(dest).then(() => true, () => false);
          if (exists && !p.force) {
            throw new Error(`Destination exists: ${dest} (pass force:true to overwrite)`);
          }
          await mkdir(dirname(dest), { recursive: true });
          if (exists && p.force) await rm(dest, { recursive: true, force: true });
          try {
            await rename(src, dest);
          } catch (err) {
            // EXDEV: different filesystems, so rename cannot work — copy then remove.
            if (err.code !== 'EXDEV') throw err;
            await cp(src, dest, { recursive: true, force: true });
            await rm(src, { recursive: true, force: true });
            return `moved ${src} -> ${dest} (across filesystems: copied then removed)`;
          }
          return `moved ${src} -> ${dest}`;
        }

        case 'delete': {
          const st = await lstat(src).catch(() => null);
          if (!st) {
            if (p.force) return `${src} does not exist (force:true, nothing to do)`;
            throw new Error(`Not found: ${src}`);
          }
          if (st.isDirectory()) {
            const entries = await readdir(src);
            if (entries.length && !p.recursive) {
              throw new Error(
                `${src} is a non-empty directory (${entries.length} entries). Pass recursive:true to delete it.`,
              );
            }
            const { items } = await walkAll(src, { showHidden: true, maxDepth: 64, maxEntries: 100000 });
            await rm(src, { recursive: true, force: true });
            return `deleted directory ${src} (${items.length} file(s))`;
          }
          await rm(src, { force: true });
          return `deleted ${src} (${humanBytes(st.size)})`;
        }

        case 'mkdir': {
          await mkdir(src, { recursive: true, ...(p.mode ? { mode: parseInt(p.mode, 8) } : {}) });
          return `created directory ${src}`;
        }

        case 'touch': {
          const existed = await lstat(src).then(() => true, () => false);
          if (!existed) {
            await mkdir(dirname(src), { recursive: true });
            await (await open(src, 'a')).close();
            return `created empty file ${src}`;
          }
          const now = new Date();
          await utimes(src, now, now);
          return `updated timestamps on ${src}`;
        }

        case 'stat': {
          const st = await lstat(src).catch(() => null);
          if (!st) throw new Error(`Not found: ${src}`);
          const kind = st.isDirectory() ? 'directory' : st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : 'special';
          const rows = [
            `${src}`,
            `type      ${kind}`,
            `size      ${humanBytes(st.size)} (${st.size} bytes)`,
            `mode      ${modeString(st.mode)}`,
            `modified  ${new Date(st.mtimeMs).toISOString()}`,
            `created   ${new Date(st.birthtimeMs || st.ctimeMs).toISOString()}`,
            `accessed  ${new Date(st.atimeMs).toISOString()}`,
          ];
          if (process.platform !== 'win32') rows.push(`owner     uid=${st.uid} gid=${st.gid}`);
          rows.push(`inode     ${st.ino} links=${st.nlink}`);
          if (st.isSymbolicLink()) {
            const target = await readlink(src).catch(() => '(unreadable)');
            rows.push(`target    ${target}`);
          }
          if (st.isDirectory()) {
            const entries = await readdir(src).catch(() => []);
            rows.push(`entries   ${entries.length}`);
          }
          return rows.join('\n');
        }

        case 'chmod': {
          if (!p.mode) throw new Error('chmod needs "mode", e.g. mode:"755"');
          if (process.platform === 'win32') {
            return 'chmod has almost no effect on Windows (only the read-only bit is honoured).';
          }
          const parsed = parseInt(p.mode, 8);
          if (Number.isNaN(parsed)) throw new Error(`mode must be octal digits, got ${JSON.stringify(p.mode)}`);
          await chmod(src, parsed);
          return `chmod ${p.mode} ${src}`;
        }

        case 'symlink': {
          if (!p.to) throw new Error('symlink needs "to" (the link to create)');
          const link = resolveSafePath(cfg, p.to, { forWrite: true });
          await mkdir(dirname(link), { recursive: true });
          const st = await lstat(src).catch(() => null);
          await symlink(src, link, st?.isDirectory() && process.platform === 'win32' ? 'dir' : undefined);
          return `symlinked ${link} -> ${src}`;
        }

        case 'readlink': {
          const target = await readlink(src).catch(() => null);
          if (target === null) throw new Error(`${src} is not a symlink`);
          return `${src} -> ${target}`;
        }

        case 'hash': {
          const algorithm = p.algorithm || 'sha256';
          const st = await lstat(src).catch(() => null);
          if (!st) throw new Error(`Not found: ${src}`);
          if (st.isFile()) {
            return `${algorithm} ${await hashFile(src, algorithm)}  ${src}`;
          }
          const { items, truncated } = await walkAll(src, {
            showHidden: p.show_hidden === true,
            skipDirs: p.skip_dirs,
            maxDepth: 64,
            maxEntries: 2000,
          });
          const rows = [];
          for (const f of items) rows.push(`${await hashFile(f.absPath, algorithm)}  ${f.relPath}`);
          return (
            `${algorithm} of ${rows.length} file(s) under ${src}${truncated ? ' (capped at 2000)' : ''}\n` +
            truncateMiddle(rows.join('\n'), p.max_bytes ?? cfg.maxOutputBytes).text
          );
        }

        case 'disk_usage': {
          const st = await lstat(src).catch(() => null);
          if (!st) throw new Error(`Not found: ${src}`);
          if (st.isFile()) return `${humanBytes(st.size)}  ${src}`;

          const depth = p.depth ?? 2;
          const perDir = new Map();
          const biggest = [];
          let total = 0;
          let count = 0;

          for await (const f of walk(src, {
            maxDepth: 64,
            showHidden: p.show_hidden === true,
            skipDirs: p.skip_dirs,
            maxEntries: 200000,
          })) {
            total += f.size;
            count++;
            // Attribute the size to each ancestor up to `depth`.
            const parts = f.relPath.split('/');
            for (let d = 1; d <= Math.min(depth, parts.length - 1); d++) {
              const key = parts.slice(0, d).join('/');
              perDir.set(key, (perDir.get(key) ?? 0) + f.size);
            }
            biggest.push({ path: f.relPath, size: f.size });
            if (biggest.length > 4000) {
              biggest.sort((x, y) => y.size - x.size);
              biggest.length = 1000;
            }
          }

          const top = p.top ?? 15;
          biggest.sort((x, y) => y.size - x.size);
          const dirs = [...perDir.entries()].sort((x, y) => y[1] - x[1]).slice(0, top);

          const out = [`${src}: ${humanBytes(total)} across ${count} file(s)`];
          if (dirs.length) {
            out.push(`largest directories (depth<=${depth}):`);
            out.push(...dirs.map(([d, s]) => `  ${humanBytes(s).padStart(9)}  ${d}/`));
          }
          out.push(`largest files:`);
          out.push(...biggest.slice(0, top).map((f) => `  ${humanBytes(f.size).padStart(9)}  ${f.path}`));
          return truncateMiddle(out.join('\n'), p.max_bytes ?? cfg.maxOutputBytes).text;
        }

        case 'tree': {
          const st = await lstat(src).catch(() => null);
          if (!st) throw new Error(`Not found: ${src}`);
          if (!st.isDirectory()) return `${src} is a file (${humanBytes(st.size)})`;

          const maxEntries = p.max_entries ?? 400;
          const { items, truncated } = await walkAll(src, {
            maxDepth: p.depth ?? 3,
            includeDirs: true,
            showHidden: p.show_hidden === true,
            skipDirs: p.skip_dirs,
            maxEntries,
          });
          const rows = items.map((e) => {
            const parts = e.relPath.split('/');
            const indent = '  '.repeat(parts.length - 1);
            const name = parts[parts.length - 1];
            return e.isDir ? `${indent}${name}/` : `${indent}${name}  ${humanBytes(e.size)}`;
          });
          const files = items.filter((e) => !e.isDir).length;
          return (
            `${src} — ${files} file(s), ${items.length - files} dir(s), depth<=${p.depth ?? 3}` +
            `${truncated ? ` TRUNCATED at ${maxEntries}` : ''}\n` +
            truncateMiddle(rows.join('\n'), p.max_bytes ?? cfg.maxOutputBytes).text
          );
        }

        default:
          throw new Error(`Unknown fs_op action "${a}". One of: ${ACTIONS.join(', ')}`);
      }
    },
  };
}

