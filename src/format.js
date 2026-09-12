// Output shaping helpers. Everything here exists to keep token usage low:
// strip noise, collapse blank runs, and truncate the middle of long output
// instead of dumping whole logs into the model's context.

const ESC = String.fromCharCode(27);
const CSI = String.fromCharCode(155);
const BEL = String.fromCharCode(7);
const ANSI_RE = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*` +
    `(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?${BEL}` +
    `|(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~])`,
  'g',
);

export function stripAnsi(s) {
  return typeof s === 'string' ? s.replace(ANSI_RE, '') : s;
}

export function normalizeEol(s) {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Trim trailing spaces per line and collapse runs of 3+ blank lines into one.
 * Cheap wins: build logs are full of both.
 */
export function compact(s) {
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Keep the head and the tail of `text`, drop the middle. The tail matters most
 * for command output (errors land at the end), so it gets the larger share.
 */
export function truncateMiddle(text, maxBytes) {
  const total = Buffer.byteLength(text, 'utf8');
  if (maxBytes <= 0) return { text: '', truncated: total > 0, removed: total };
  if (total <= maxBytes) return { text, truncated: false, removed: 0 };

  const buf = Buffer.from(text, 'utf8');
  const headBytes = Math.floor(maxBytes * 0.35);
  const tailBytes = maxBytes - headBytes;
  const head = buf.subarray(0, headBytes).toString('utf8');
  const tail = buf.subarray(total - tailBytes).toString('utf8');
  const removed = total - headBytes - tailBytes;

  // Cut on line boundaries so we never hand back half a line.
  const lastNl = head.lastIndexOf('\n');
  const headCut = lastNl > 0 ? head.slice(0, lastNl) : head;
  const tailIdx = tail.indexOf('\n');
  const tailCut = tailIdx >= 0 ? tail.slice(tailIdx + 1) : tail;

  return {
    text: `${headCut}\n... [${removed} bytes / ~${Math.round(removed / 4)} tokens omitted] ...\n${tailCut}`,
    truncated: true,
    removed,
  };
}

/** Full cleanup + truncation pipeline used by every command result. */
export function shapeOutput(raw, { maxBytes = 16000, ansi = false, tidy = true } = {}) {
  let s = normalizeEol(raw ?? '');
  if (!ansi) s = stripAnsi(s);
  if (tidy) s = compact(s);
  s = s.replace(/^\n+|\n+$/g, '');
  return truncateMiddle(s, maxBytes);
}

export function ms(n) {
  if (n < 1000) return `${n}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
  const m = Math.floor(n / 60000);
  return `${m}m${Math.round((n % 60000) / 1000)}s`;
}

/**
 * Compact single-command report. Empty streams are omitted entirely rather
 * than printed as `stderr: (empty)` — silence is the cheapest signal.
 */
export function renderResult(r, { label = null, showCwd = false } = {}) {
  const head = [];
  if (label) head.push(label);
  head.push(`exit=${r.exitCode === null ? 'killed' : r.exitCode}`);
  if (r.signal) head.push(`signal=${r.signal}`);
  if (r.timedOut) head.push('TIMED_OUT');
  head.push(ms(r.durationMs));
  if (showCwd) head.push(`cwd=${r.cwd}`);

  const parts = [head.join(' ')];
  if (r.stdout) parts.push(r.mergedStreams ? r.stdout : `--- stdout ---\n${r.stdout}`);
  if (r.stderr) parts.push(`--- stderr ---\n${r.stderr}`);
  if (!r.stdout && !r.stderr) parts.push('(no output)');
  return parts.join('\n');
}
