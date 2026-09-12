// Glob matching and .gitignore handling, shared by the search and fs tools.
// Paths are compared in POSIX form ("/" separators) so one pattern works on
// every platform.

export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * Convert a glob to a RegExp source.
 * Supports **, *, ?, [...], {a,b} and leading ! (handled by the caller).
 *   *  -> anything except /
 *   ** -> anything, / included
 */
export function globToRegExpSource(glob) {
  const g = toPosix(glob);
  let out = '';
  let i = 0;

  while (i < g.length) {
    const c = g[i];

    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` may match zero directories, so `**/x` also matches `x`.
        if (g[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
      continue;
    }

    if (c === '?') { out += '[^/]'; i++; continue; }

    if (c === '[') {
      const close = g.indexOf(']', i + 1);
      if (close === -1) { out += '\\['; i++; continue; }
      let cls = g.slice(i + 1, close);
      let negate = false;
      if (cls.startsWith('!') || cls.startsWith('^')) { negate = true; cls = cls.slice(1); }
      out += `[${negate ? '^' : ''}${cls.replace(/\\/g, '\\\\')}]`;
      i = close + 1;
      continue;
    }

    if (c === '{') {
      const close = findBrace(g, i);
      if (close === -1) { out += '\\{'; i++; continue; }
      const parts = splitTopLevel(g.slice(i + 1, close));
      out += `(?:${parts.map(globToRegExpSource).join('|')})`;
      i = close + 1;
      continue;
    }

    out += /[.+^$()|\\]/.test(c) ? `\\${c}` : c;
    i++;
  }
  return out;
}

function findBrace(s, from) {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

function splitTopLevel(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/**
 * Compile a glob into a matcher over relative paths.
 * A pattern with no "/" matches the basename at any depth, which is what
 * people mean by "*.ts".
 */
export function compileGlob(glob) {
  const g = toPosix(glob);
  const anchored = g.includes('/');
  const src = globToRegExpSource(anchored ? g.replace(/^\.\//, '') : g);
  const re = new RegExp(`^${src}$`);
  return (relPath) => {
    const rel = toPosix(relPath);
    if (re.test(rel)) return true;
    if (!anchored) {
      const base = rel.slice(rel.lastIndexOf('/') + 1);
      return re.test(base);
    }
    return false;
  };
}

/** Match against any of several globs (empty list = match everything). */
export function compileGlobList(globs) {
  const list = (Array.isArray(globs) ? globs : globs ? [globs] : []).filter(Boolean);
  if (!list.length) return () => true;
  const matchers = list.map(compileGlob);
  return (relPath) => matchers.some((m) => m(relPath));
}

// ------------------------------------------------------------- .gitignore

/**
 * Parse .gitignore content into rules. Handles the parts that matter in
 * practice: comments, negation with !, directory-only with a trailing /,
 * anchoring with a leading /, and ** wildcards. Not a full reimplementation
 * of git's matcher — good enough to keep node_modules and build output out of
 * a search, which is the point.
 */
export function parseIgnore(content, baseDir = '') {
  const rules = [];
  for (const raw of String(content).split('\n')) {
    let line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    // Trailing spaces are insignificant unless escaped.
    line = line.replace(/(?<!\\)\s+$/, '');
    if (!line) continue;

    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }

    let dirOnly = false;
    if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }

    const anchored = line.startsWith('/') || line.slice(0, -1).includes('/');
    if (line.startsWith('/')) line = line.slice(1);

    const src = globToRegExpSource(line);
    // An unanchored pattern applies at any depth below baseDir.
    const base = anchored ? src : `(?:.*/)?${src}`;
    rules.push({
      // The entry itself. For a `dir/` rule this only counts when it IS a dir.
      exact: new RegExp(`^${base}$`),
      // Anything inside it — always counts, since ignoring a directory
      // ignores its whole subtree.
      under: new RegExp(`^${base}/.*$`),
      negate,
      dirOnly,
      baseDir: toPosix(baseDir),
    });
  }
  return rules;
}

/**
 * Is `relPath` (relative to the repo root) ignored by `rules`?
 * Later rules win, which is how git resolves negations.
 */
export function isIgnored(rules, relPath, isDir) {
  const rel = toPosix(relPath);
  let ignored = false;
  for (const rule of rules) {
    // A rule from a nested .gitignore only applies under its own directory.
    let subject = rel;
    if (rule.baseDir) {
      if (!rel.startsWith(`${rule.baseDir}/`)) continue;
      subject = rel.slice(rule.baseDir.length + 1);
    }
    const hit =
      rule.under.test(subject) || ((!rule.dirOnly || isDir) && rule.exact.test(subject));
    if (hit) ignored = !rule.negate;
  }
  return ignored;
}
