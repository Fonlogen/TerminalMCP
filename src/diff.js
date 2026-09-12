// Line diffing. Used by the `diff` tool, by file_edit's dry-run preview, and
// by search_text's replace preview.
//
// Myers' algorithm would be the textbook choice; this uses the classic
// "trim the common ends, then LCS the middle" approach, which is simpler to
// audit and fast enough because the trimmed middle is small for real edits.
// The middle is capped so a pathological input degrades to a coarse
// replace-block diff rather than eating memory.

const LCS_CELL_BUDGET = 4_000_000; // ~4M cells ≈ 32MB of Int32, worst case

/** Split text into lines without inventing a trailing empty line. */
export function toLines(text) {
  const s = String(text ?? '').replace(/\r\n/g, '\n');
  const lines = s.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Diff two line arrays.
 * Returns ops: [{ op: 'eq'|'del'|'ins', aIndex, bIndex, line }]
 */
export function diffLines(a, b) {
  // Trim the common prefix and suffix: most edits touch a small middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  ) {
    end++;
  }

  const aMid = a.slice(start, a.length - end);
  const bMid = b.slice(start, b.length - end);

  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ op: 'eq', aIndex: i, bIndex: i, line: a[i] });

  if (aMid.length * bMid.length > LCS_CELL_BUDGET) {
    // Too big to LCS: report the middle as one delete block + one insert block.
    for (let i = 0; i < aMid.length; i++) {
      ops.push({ op: 'del', aIndex: start + i, bIndex: null, line: aMid[i] });
    }
    for (let j = 0; j < bMid.length; j++) {
      ops.push({ op: 'ins', aIndex: null, bIndex: start + j, line: bMid[j] });
    }
  } else {
    ops.push(...lcsOps(aMid, bMid, start));
  }

  for (let k = 0; k < end; k++) {
    const i = a.length - end + k;
    ops.push({ op: 'eq', aIndex: i, bIndex: b.length - end + k, line: a[i] });
  }
  return ops;
}

function lcsOps(a, b, offset) {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((line, j) => ({ op: 'ins', aIndex: null, bIndex: offset + j, line }));
  if (m === 0) return a.map((line, i) => ({ op: 'del', aIndex: offset + i, bIndex: null, line }));

  // table[i][j] = LCS length of a[i..] and b[j..]
  const width = m + 1;
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + (j + 1)] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: 'eq', aIndex: offset + i, bIndex: offset + j, line: a[i] });
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      ops.push({ op: 'del', aIndex: offset + i, bIndex: null, line: a[i] });
      i++;
    } else {
      ops.push({ op: 'ins', aIndex: null, bIndex: offset + j, line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ op: 'del', aIndex: offset + i, bIndex: null, line: a[i++] });
  while (j < m) ops.push({ op: 'ins', aIndex: null, bIndex: offset + j, line: b[j++] });
  return ops;
}

/** Group ops into hunks with `context` equal lines around each change. */
export function toHunks(ops, context = 3) {
  const changed = ops
    .map((o, idx) => (o.op === 'eq' ? -1 : idx))
    .filter((idx) => idx !== -1);
  if (!changed.length) return [];

  const ranges = [];
  let lo = Math.max(0, changed[0] - context);
  let hi = Math.min(ops.length - 1, changed[0] + context);
  for (const idx of changed.slice(1)) {
    if (idx - context <= hi + 1) {
      hi = Math.min(ops.length - 1, idx + context);
    } else {
      ranges.push([lo, hi]);
      lo = Math.max(0, idx - context);
      hi = Math.min(ops.length - 1, idx + context);
    }
  }
  ranges.push([lo, hi]);

  return ranges.map(([from, to]) => {
    const slice = ops.slice(from, to + 1);
    let aStart = null;
    let bStart = null;
    let aCount = 0;
    let bCount = 0;
    for (const o of slice) {
      if (o.aIndex !== null) {
        if (aStart === null) aStart = o.aIndex;
        aCount++;
      }
      if (o.bIndex !== null) {
        if (bStart === null) bStart = o.bIndex;
        bCount++;
      }
    }
    return { aStart: (aStart ?? 0) + 1, aCount, bStart: (bStart ?? 0) + 1, bCount, ops: slice };
  });
}

/** Render a unified diff. `aName`/`bName` go in the ---/+++ header. */
export function unifiedDiff(aText, bText, { aName = 'a', bName = 'b', context = 3 } = {}) {
  const a = toLines(aText);
  const b = toLines(bText);
  const ops = diffLines(a, b);
  const hunks = toHunks(ops, context);
  if (!hunks.length) return '';

  const out = [`--- ${aName}`, `+++ ${bName}`];
  for (const h of hunks) {
    out.push(`@@ -${h.aStart},${h.aCount} +${h.bStart},${h.bCount} @@`);
    for (const o of h.ops) {
      out.push(`${o.op === 'eq' ? ' ' : o.op === 'del' ? '-' : '+'}${o.line}`);
    }
  }
  return out.join('\n');
}

/** Counts for a one-line summary. */
export function diffStats(aText, bText) {
  const ops = diffLines(toLines(aText), toLines(bText));
  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.op === 'ins') added++;
    else if (o.op === 'del') removed++;
  }
  return { added, removed, changed: added + removed };
}

/**
 * Apply a unified diff to `text`.
 *
 * Hunk line numbers are treated as a hint, not gospel: the context is searched
 * for near the stated position and then anywhere in the file, so a patch still
 * applies after unrelated edits shifted the line numbers. Returns
 * { text, applied, failed } and never throws on a hunk that does not fit.
 */
export function applyUnifiedDiff(text, patch, { fuzz = 200 } = {}) {
  const lines = toLines(text);
  const patchLines = String(patch).replace(/\r\n/g, '\n').split('\n');

  const hunks = [];
  let current = null;
  for (const raw of patchLines) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (header) {
      current = { aStart: Number(header[1]), lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue; // ---/+++/index lines before the first hunk
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    if (raw === '' ) { current.lines.push({ kind: ' ', text: '' }); continue; }
    const kind = raw[0];
    if (kind === ' ' || kind === '-' || kind === '+') {
      current.lines.push({ kind, text: raw.slice(1) });
    }
  }
  if (!hunks.length) throw new Error('No @@ hunk headers found — is this a unified diff?');

  const applied = [];
  const failed = [];
  let shift = 0;

  for (const [n, hunk] of hunks.entries()) {
    const expect = hunk.lines.filter((l) => l.kind !== '+').map((l) => l.text);
    const replacement = hunk.lines.filter((l) => l.kind !== '-').map((l) => l.text);
    const guess = Math.max(0, hunk.aStart - 1 + shift);
    const at = findBlock(lines, expect, guess, fuzz);

    if (at === -1) {
      failed.push(`hunk #${n + 1} (@@ -${hunk.aStart}) did not match the file`);
      continue;
    }
    lines.splice(at, expect.length, ...replacement);
    shift += replacement.length - expect.length;
    applied.push(`hunk #${n + 1} at line ${at + 1}`);
  }

  const trailing = /\n$/.test(String(text)) || text === '';
  return { text: lines.join('\n') + (trailing ? '\n' : ''), applied, failed };
}

/** Find `block` in `lines`, preferring positions near `guess`. */
function findBlock(lines, block, guess, fuzz) {
  if (block.length === 0) return Math.min(guess, lines.length);
  const matches = (at) => {
    if (at < 0 || at + block.length > lines.length) return false;
    for (let k = 0; k < block.length; k++) if (lines[at + k] !== block[k]) return false;
    return true;
  };
  if (matches(guess)) return guess;
  for (let d = 1; d <= fuzz; d++) {
    if (matches(guess - d)) return guess - d;
    if (matches(guess + d)) return guess + d;
  }
  for (let at = 0; at + block.length <= lines.length; at++) if (matches(at)) return at;
  return -1;
}
