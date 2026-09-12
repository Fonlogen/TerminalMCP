// Server-side variable store.
//
// The point is token cost: a value captured here never has to travel back
// through the conversation to be used again. Run a command once, keep its
// output in `vars.sha`, and reference `${vars.sha}` in later calls — the value
// itself stays on the server.
//
// Lives in memory for the process, shared by every session (like the job
// registry, and for the same reason: this server drives one machine).
// Optionally mirrored to a file so it survives a restart.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

export const VAR_DEFAULTS = {
  maxVars: 200,
  maxVarBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  varsFile: null,
  // Secrets stay in memory only unless this is turned on: a file on disk is a
  // different exposure than a value in a running process.
  persistSecrets: false,
};

function sizeOf(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
  } catch {
    return Infinity; // circular or otherwise unserialisable
  }
}

export function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array[${value.length}]`;
  const t = typeof value;
  if (t !== 'object') return t;
  return `object{${Object.keys(value).length}}`;
}

/** Short, single-line preview for listings. */
export function previewOf(value, max = 60) {
  let s;
  if (typeof value === 'string') s = value;
  else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export class VarStore {
  constructor(options = {}) {
    this.opts = { ...VAR_DEFAULTS, ...options };
    this.map = new Map();
    this.loadError = null;
    this._saveTimer = null;
    if (this.opts.varsFile) this._load();
  }

  // ------------------------------------------------------------- internals

  _assertName(name) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new Error(
        `Invalid variable name ${JSON.stringify(name)}. Use letters, digits, _ . - ` +
        `starting with a letter or _, up to 128 characters.`,
      );
    }
    return name;
  }

  /** Drop expired entries. Called before every read and listing. */
  _sweep() {
    const now = Date.now();
    for (const [name, entry] of this.map) {
      if (entry.expiresAt && entry.expiresAt <= now) this.map.delete(name);
    }
  }

  totalBytes() {
    let n = 0;
    for (const entry of this.map.values()) n += entry.bytes;
    return n;
  }

  // ------------------------------------------------------------------- API

  set(name, value, { secret = false, ttlMs = null } = {}) {
    this._assertName(name);
    this._sweep();

    const bytes = sizeOf(value);
    if (bytes === Infinity) {
      throw new Error(`Value for "${name}" cannot be serialised to JSON (circular reference?).`);
    }
    if (bytes > this.opts.maxVarBytes) {
      throw new Error(
        `Value for "${name}" is ${bytes} bytes, over the ${this.opts.maxVarBytes} byte limit. ` +
        `Write it to a file instead and keep the path in a variable.`,
      );
    }

    const existing = this.map.get(name);
    const projected = this.totalBytes() - (existing?.bytes ?? 0) + bytes;
    if (projected > this.opts.maxTotalBytes) {
      throw new Error(
        `Storing "${name}" would put the variable store at ${projected} bytes, over the ` +
        `${this.opts.maxTotalBytes} byte limit. Delete something first (vars action="list" shows sizes).`,
      );
    }
    if (!existing && this.map.size >= this.opts.maxVars) {
      throw new Error(`Variable limit reached (${this.opts.maxVars}). Delete some first.`);
    }

    const now = Date.now();
    this.map.set(name, {
      value,
      bytes,
      // Once secret, always secret: re-setting must not silently declassify.
      secret: Boolean(secret) || Boolean(existing?.secret),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      expiresAt: ttlMs ? now + Number(ttlMs) : (existing && ttlMs === null ? existing.expiresAt : null),
      writes: (existing?.writes ?? 0) + 1,
    });
    this._scheduleSave();
    return this.map.get(name);
  }

  get(name) {
    this._sweep();
    return this.map.get(name)?.value;
  }

  entry(name) {
    this._sweep();
    return this.map.get(name) ?? null;
  }

  has(name) {
    this._sweep();
    return this.map.has(name);
  }

  delete(name) {
    const existed = this.map.delete(name);
    if (existed) this._scheduleSave();
    return existed;
  }

  clear() {
    const n = this.map.size;
    this.map.clear();
    this._scheduleSave();
    return n;
  }

  /** Metadata for every variable — never the full values. */
  list() {
    this._sweep();
    return [...this.map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, e]) => ({
        name,
        type: describeType(e.value),
        bytes: e.bytes,
        secret: e.secret,
        preview: e.secret ? '(secret)' : previewOf(e.value),
        updatedAt: e.updatedAt,
        expiresAt: e.expiresAt,
      }));
  }

  /**
   * Plain object for ${...} interpolation. Includes secret values — that is
   * the whole point of marking something secret: usable without being shown.
   */
  snapshot() {
    this._sweep();
    const out = {};
    for (const [name, e] of this.map) out[name] = e.value;
    return out;
  }

  append(name, text) {
    this._assertName(name);
    const current = this.get(name);
    if (current === undefined) return this.set(name, text);
    if (Array.isArray(current)) return this.set(name, [...current, text]);
    if (typeof current === 'string') return this.set(name, current + text);
    throw new Error(`Cannot append to "${name}": it is ${describeType(current)}, not a string or array.`);
  }

  incr(name, delta = 1) {
    this._assertName(name);
    const current = this.get(name);
    const base = current === undefined ? 0 : Number(current);
    if (Number.isNaN(base)) {
      throw new Error(`Cannot increment "${name}": its value ${JSON.stringify(previewOf(current))} is not a number.`);
    }
    const next = base + Number(delta);
    this.set(name, next);
    return next;
  }

  // ------------------------------------------------------------ persistence

  _load() {
    const file = this.opts.varsFile;
    try {
      if (!existsSync(file)) return;
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      const entries = parsed?.vars && typeof parsed.vars === 'object' ? parsed.vars : {};
      const now = Date.now();
      for (const [name, e] of Object.entries(entries)) {
        if (!NAME_RE.test(name) || !e || typeof e !== 'object') continue;
        if (e.expiresAt && e.expiresAt <= now) continue;
        this.map.set(name, {
          value: e.value,
          bytes: sizeOf(e.value),
          secret: Boolean(e.secret),
          createdAt: e.createdAt ?? now,
          updatedAt: e.updatedAt ?? now,
          expiresAt: e.expiresAt ?? null,
          writes: e.writes ?? 0,
        });
      }
    } catch (err) {
      // A corrupt store must not stop the server from starting; report it
      // through shell_info / vars list instead.
      this.loadError = `${file}: ${err.message}`;
    }
  }

  /** Debounced so a bulk run assigning ten variables writes the file once. */
  _scheduleSave() {
    if (!this.opts.varsFile) return;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveNow();
    }, 250);
    this._saveTimer.unref?.();
  }

  saveNow() {
    const file = this.opts.varsFile;
    if (!file) return false;
    try {
      const vars = {};
      for (const [name, e] of this.map) {
        if (e.secret && !this.opts.persistSecrets) continue;
        vars[name] = {
          value: e.value,
          secret: e.secret,
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
          expiresAt: e.expiresAt,
          writes: e.writes,
        };
      }
      mkdirSync(dirname(file), { recursive: true });
      // Write-then-rename so a crash mid-write cannot truncate the store.
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ version: 1, savedAt: Date.now(), vars }, null, 2)}\n`, 'utf8');
      renameSync(tmp, file);
      return true;
    } catch (err) {
      this.loadError = `save failed: ${err.message}`;
      return false;
    }
  }

  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    return this.saveNow();
  }
}
