// One directory walker, shared by search_text, search_files, code and fs_op.
// Centralising it keeps the skip rules (and therefore the results) consistent
// across every tool that crawls a tree.

import { readdir, stat, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseIgnore, isIgnored, toPosix } from './glob.js';

/** Directories nobody wants in a code search. Overridable per call. */
export const DEFAULT_SKIP_DIRS = [
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.svelte-kit',
  'coverage', '.gradle', '.idea', '.vs', 'vendor', 'Pods', '.terraform', '.tox',
  'bin/obj', '.cache', '.parcel-cache', '.turbo', '.yarn',
];

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.pdf', '.zip', '.gz',
  '.bz2', '.xz', '.tar', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.a', '.o', '.obj',
  '.class', '.jar', '.war', '.wasm', '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.flac', '.wav',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.bin', '.dat', '.db', '.sqlite', '.sqlite3',
  '.pyc', '.pyo', '.pdb', '.lib', '.node', '.iso', '.dmg', '.deb', '.rpm',
]);

export function looksBinaryPath(path) {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? false : BINARY_EXT.has(path.slice(dot).toLowerCase());
}

export function looksBinaryBuffer(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Walk `root` and yield { absPath, relPath, isDir, size, mtimeMs, depth }.
 *
 * Options:
 *   maxDepth        how deep to recurse (default 24)
 *   skipDirs        directory names not to enter
 *   includeDirs     also yield directories (default false)
 *   showHidden      include dotfiles (default false)
 *   respectGitignore  honour .gitignore files found while walking
 *   maxEntries      stop after this many yields; sets `truncated`
 *   followSymlinks  descend into symlinked directories (default false)
 */
export async function* walk(root, options = {}) {
  const {
    maxDepth = 24,
    skipDirs = DEFAULT_SKIP_DIRS,
    includeDirs = false,
    showHidden = false,
    respectGitignore = false,
    maxEntries = Infinity,
    followSymlinks = false,
  } = options;

  const skip = new Set(skipDirs);
  const state = { count: 0, truncated: false };
  const seenDirs = new Set(); // symlink loop protection

  // Ignore rules accumulated from .gitignore files, deepest last.
  let rules = [];
  if (respectGitignore) {
    const top = await readFile(join(root, '.gitignore'), 'utf8').catch(() => null);
    if (top !== null) rules = parseIgnore(top, '');
  }

  yield* descend(root, '', 1, rules);

  async function* descend(dir, relDir, depth, inherited) {
    if (state.count >= maxEntries) { state.truncated = true; return; }

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip it rather than abort the walk
    }

    let localRules = inherited;
    if (respectGitignore && relDir) {
      const gi = entries.find((e) => e.isFile() && e.name === '.gitignore');
      if (gi) {
        const content = await readFile(join(dir, '.gitignore'), 'utf8').catch(() => null);
        if (content !== null) localRules = [...inherited, ...parseIgnore(content, relDir)];
      }
    }

    entries.sort((a, b) =>
      a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1,
    );

    for (const ent of entries) {
      if (state.count >= maxEntries) { state.truncated = true; return; }
      if (!showHidden && ent.name.startsWith('.') && ent.name !== '.env') continue;

      const absPath = join(dir, ent.name);
      const relPath = relDir ? `${relDir}/${ent.name}` : ent.name;

      let isDir = ent.isDirectory();
      if (ent.isSymbolicLink()) {
        if (!followSymlinks) continue;
        const st = await stat(absPath).catch(() => null);
        if (!st) continue;
        isDir = st.isDirectory();
      }

      if (respectGitignore && isIgnored(localRules, relPath, isDir)) continue;

      if (isDir) {
        if (skip.has(ent.name)) continue;
        if (includeDirs) {
          state.count++;
          yield { absPath, relPath, isDir: true, size: 0, mtimeMs: 0, depth };
        }
        if (followSymlinks) {
          const real = await stat(absPath).then((s) => `${s.dev}:${s.ino}`, () => null);
          if (real) {
            if (seenDirs.has(real)) continue;
            seenDirs.add(real);
          }
        }
        if (depth < maxDepth) yield* descend(absPath, relPath, depth + 1, localRules);
        continue;
      }

      if (!ent.isFile() && !ent.isSymbolicLink()) continue; // sockets, fifos, devices

      let size = 0;
      let mtimeMs = 0;
      const st = await stat(absPath).catch(() => null);
      if (st) { size = st.size; mtimeMs = st.mtimeMs; }

      state.count++;
      yield { absPath, relPath, isDir: false, size, mtimeMs, depth };
    }
  }
}

/** Collect a walk into an array, reporting whether the cap was hit. */
export async function walkAll(root, options = {}) {
  const items = [];
  const max = options.maxEntries ?? Infinity;
  for await (const item of walk(root, options)) {
    items.push(item);
    if (items.length >= max) return { items, truncated: true };
  }
  return { items, truncated: false };
}

export function relPosix(from, to) {
  return toPosix(relative(from, to));
}
