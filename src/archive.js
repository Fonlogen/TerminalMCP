// ZIP and TAR, implemented here because Node ships zlib (deflate/gzip) but no
// container format. Keeping it in-process means archives work identically on
// Windows, macOS and Linux instead of depending on whichever tar/zip happens
// to be installed.

import { deflateRawSync, inflateRawSync, gzipSync, gunzipSync } from 'node:zlib';

// ------------------------------------------------------------------ CRC32

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

// -------------------------------------------------------------------- ZIP

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_EOCD = 0x06054b50;

/** DOS date/time, as ZIP has stored timestamps since 1980. */
function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function fromDosDateTime(date, time) {
  return new Date(
    1980 + ((date >> 9) & 0x7f),
    ((date >> 5) & 0x0f) - 1,
    date & 0x1f,
    (time >> 11) & 0x1f,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2,
  );
}

/**
 * Build a ZIP.
 * `entries`: [{ name, data: Buffer, mtime?, mode?, isDir? }]
 */
export function createZip(entries, { level = 6 } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/').replace(/^\/+/, '');
    const nameBuf = Buffer.from(entry.isDir && !name.endsWith('/') ? `${name}/` : name, 'utf8');
    const raw = entry.isDir ? Buffer.alloc(0) : Buffer.from(entry.data ?? Buffer.alloc(0));
    const crc = crc32(raw);

    // Only compress if it actually helps; stored is cheaper to read back.
    let method = 0;
    let body = raw;
    if (!entry.isDir && raw.length > 0 && level > 0) {
      const deflated = deflateRawSync(raw, { level });
      if (deflated.length < raw.length) {
        method = 8;
        body = deflated;
      }
    }

    const { time, date } = dosDateTime(entry.mtime ?? new Date());
    const flags = 0x0800; // UTF-8 names

    const local = Buffer.alloc(30);
    local.writeUInt32LE(ZIP_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(ZIP_CENTRAL, 0);
    central.writeUInt16LE(0x031e, 4); // made by: unix, zip 3.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    // External attrs: unix mode in the high 16 bits.
    const mode = entry.mode ?? (entry.isDir ? 0o755 : 0o644);
    central.writeUInt32LE(((mode | (entry.isDir ? 0o40000 : 0o100000)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(ZIP_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/** Read a ZIP's central directory. Returns entry metadata, no file data. */
export function listZip(buf) {
  // The EOCD sits at the end, after an optional comment of up to 64KB.
  let eocdAt = -1;
  const from = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === ZIP_EOCD) { eocdAt = i; break; }
  }
  if (eocdAt === -1) throw new Error('Not a ZIP file (no end-of-central-directory record found)');

  const count = buf.readUInt16LE(eocdAt + 10);
  let at = buf.readUInt32LE(eocdAt + 16);
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== ZIP_CENTRAL) {
      throw new Error(`Corrupt ZIP: bad central directory entry ${i + 1} of ${count}`);
    }
    const method = buf.readUInt16LE(at + 10);
    const time = buf.readUInt16LE(at + 12);
    const date = buf.readUInt16LE(at + 14);
    const crc = buf.readUInt32LE(at + 16);
    const compressedSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const externalAttrs = buf.readUInt32LE(at + 38);
    const localOffset = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');

    entries.push({
      name,
      size,
      compressedSize,
      method,
      crc,
      mtime: fromDosDateTime(date, time),
      mode: (externalAttrs >>> 16) & 0o7777,
      isDir: name.endsWith('/') || ((externalAttrs >>> 16) & 0o40000) !== 0,
      localOffset,
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Extract one entry's bytes from a ZIP buffer. */
export function readZipEntry(buf, entry) {
  const at = entry.localOffset;
  if (buf.readUInt32LE(at) !== ZIP_LOCAL) throw new Error(`Corrupt ZIP: bad local header for ${entry.name}`);
  const nameLen = buf.readUInt16LE(at + 26);
  const extraLen = buf.readUInt16LE(at + 28);
  const dataAt = at + 30 + nameLen + extraLen;
  const body = buf.subarray(dataAt, dataAt + entry.compressedSize);

  let data;
  if (entry.method === 0) data = Buffer.from(body);
  else if (entry.method === 8) data = inflateRawSync(body);
  else throw new Error(`${entry.name}: unsupported ZIP compression method ${entry.method}`);

  if (crc32(data) !== entry.crc) throw new Error(`${entry.name}: CRC mismatch — the archive is damaged`);
  return data;
}

// -------------------------------------------------------------------- TAR

const BLOCK = 512;

function octal(value, width) {
  // ustar stores numbers as NUL-terminated octal strings.
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function tarHeader({ name, size, mode, mtime, typeflag, prefix = '', uname = 'root', gname = 'root' }) {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode & 0o7777, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii'); // uid
  h.write(octal(0, 8), 116, 8, 'ascii'); // gid
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(Math.floor(mtime / 1000), 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii'); // checksum placeholder: eight spaces
  h.write(typeflag, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write(uname, 265, 32, 'utf8');
  h.write(gname, 297, 32, 'utf8');
  h.write(prefix, 345, 155, 'utf8');

  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  h.write(octal(sum, 8).slice(0, 7), 148, 7, 'ascii');
  h[155] = 0x20;
  return h;
}

function padTo512(buf) {
  const rem = buf.length % BLOCK;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(BLOCK - rem)]);
}

/**
 * Build a TAR (ustar). `entries`: [{ name, data, mtime?, mode?, isDir? }]
 * Long paths use the ustar prefix field, falling back to a GNU longname
 * record so nothing is silently truncated.
 */
export function createTar(entries) {
  const parts = [];

  for (const entry of entries) {
    let name = entry.name.replace(/\\/g, '/').replace(/^\/+/, '');
    const isDir = Boolean(entry.isDir);
    if (isDir && !name.endsWith('/')) name += '/';
    const data = isDir ? Buffer.alloc(0) : Buffer.from(entry.data ?? Buffer.alloc(0));
    const mode = entry.mode ?? (isDir ? 0o755 : 0o644);
    const mtime = entry.mtime ? new Date(entry.mtime).getTime() : Date.now();
    const typeflag = isDir ? '5' : '0';

    let prefix = '';
    let shortName = name;
    if (Buffer.byteLength(name) > 100) {
      const cut = name.lastIndexOf('/', name.length - 2);
      if (cut > 0 && Buffer.byteLength(name.slice(cut + 1)) <= 100 && Buffer.byteLength(name.slice(0, cut)) <= 155) {
        prefix = name.slice(0, cut);
        shortName = name.slice(cut + 1);
      } else {
        // GNU longname: a './@LongLink' record carrying the real path.
        const nameBuf = Buffer.from(`${name}\0`, 'utf8');
        parts.push(
          tarHeader({ name: '././@LongLink', size: nameBuf.length, mode: 0o644, mtime, typeflag: 'L' }),
          padTo512(nameBuf),
        );
        shortName = name.slice(0, 100);
      }
    }

    parts.push(tarHeader({ name: shortName, size: data.length, mode, mtime, typeflag, prefix }));
    if (data.length) parts.push(padTo512(data));
  }

  parts.push(Buffer.alloc(BLOCK * 2)); // end-of-archive: two zero blocks
  return Buffer.concat(parts);
}

function readOctal(buf, start, len) {
  const s = buf.subarray(start, start + len).toString('ascii').replace(/\0.*$/, '').trim();
  if (s === '') return 0;
  // GNU base-256 encoding for values that do not fit in octal.
  if (buf[start] & 0x80) {
    let n = buf[start] & 0x7f;
    for (let i = start + 1; i < start + len; i++) n = n * 256 + buf[i];
    return n;
  }
  const n = parseInt(s, 8);
  return Number.isNaN(n) ? 0 : n;
}

/** Parse a TAR. Returns [{ name, size, mode, mtime, isDir, data }]. */
export function listTar(buf, { withData = true } = {}) {
  const entries = [];
  let at = 0;
  let pendingLongName = null;

  while (at + BLOCK <= buf.length) {
    const header = buf.subarray(at, at + BLOCK);
    // Two zero blocks mark the end; one stray zero block also means "done".
    if (header.every((b) => b === 0)) break;

    const magic = header.subarray(257, 262).toString('ascii');
    if (magic !== 'ustar' && magic.trim() !== 'ustar' && magic !== '') {
      throw new Error(`Not a TAR file (bad magic ${JSON.stringify(magic)} at offset ${at})`);
    }

    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const size = readOctal(header, 124, 12);
    const mode = readOctal(header, 100, 8);
    const mtime = readOctal(header, 136, 12) * 1000;
    const typeflag = String.fromCharCode(header[156] || 0x30);

    const dataAt = at + BLOCK;
    const dataEnd = dataAt + size;
    at = dataAt + Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === 'L') {
      pendingLongName = buf.subarray(dataAt, dataEnd).toString('utf8').replace(/\0.*$/, '');
      continue;
    }
    if (typeflag === 'x' || typeflag === 'g') {
      // PAX header: the only field we care about is an overriding path.
      const pax = buf.subarray(dataAt, dataEnd).toString('utf8');
      const m = /\d+ path=([^\n]+)\n/.exec(pax);
      if (m) pendingLongName = m[1];
      continue;
    }
    if (typeflag === 'K') continue; // GNU long link target: not needed here

    const name = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    pendingLongName = null;
    if (!name) continue;

    const isDir = typeflag === '5' || name.endsWith('/');
    entries.push({
      name,
      size: isDir ? 0 : size,
      mode: mode || (isDir ? 0o755 : 0o644),
      mtime: new Date(mtime || Date.now()),
      isDir,
      typeflag,
      ...(withData && !isDir ? { data: Buffer.from(buf.subarray(dataAt, dataEnd)) } : {}),
    });
  }

  return entries;
}

export { gzipSync, gunzipSync };

/** Sniff the format from the file name and magic bytes. */
export function detectFormat(name, buf) {
  const lower = String(name).toLowerCase();
  if (buf && buf.length > 1 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return lower.endsWith('.tar.gz') || lower.endsWith('.tgz') ? 'tar.gz' : 'gz';
  }
  if (buf && buf.length > 3 && buf.readUInt32LE(0) === ZIP_LOCAL) return 'zip';
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  if (lower.endsWith('.tar')) return 'tar';
  if (lower.endsWith('.gz')) return 'gz';
  return null;
}
