// PNG decoding, resizing and encoding — in process, with no image library.
//
// Why bother, when the platform has screenshot tools? Because resizing is the
// only real lever on what a screenshot costs. A vision model is billed by
// pixels, not bytes: roughly width × height / 750 tokens. A raw 4K screenshot
// is about 11,000 tokens. The same screenshot at 1200px wide is about 1,100,
// and is still perfectly readable.
//
// Leaning on ImageMagick for that would mean the feature silently degrades on
// machines that do not have it — which is most Windows machines. PNG is a
// filtered scanline format wrapped around zlib, and Node has zlib, so the
// whole thing is a few hundred lines and works identically everywhere.
//
// Deliberately not implemented: interlaced PNG (no screenshot tool emits it),
// and JPEG encoding (a DCT encoder is a lot of code for no token saving —
// pixels are what cost, and for the browser we can ask CDP for JPEG directly).

import { deflateSync, inflateSync } from 'node:zlib';
import { crc32 } from './archive.js';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 8 && buf.subarray(0, 8).equals(SIG);
}

/** Read IHDR without inflating anything. Cheap enough to call on every file. */
export function pngInfo(buf) {
  if (!isPng(buf)) throw new Error('Not a PNG file');
  if (buf.length < 33) throw new Error('PNG truncated before IHDR');
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') throw new Error('PNG does not start with IHDR');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
    interlace: buf[28],
  };
}

function* chunks(buf) {
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    const start = off + 8;
    const end = start + len;
    if (end > buf.length) throw new Error(`PNG chunk ${type} runs past the end of the file`);
    yield { type, data: buf.subarray(start, end) };
    off = end + 4; // skip the CRC
    if (type === 'IEND') return;
  }
}

/** Undo the per-scanline filter. Operates in place on `raw`. */
function unfilter(raw, width, height, bpp, rowBytes) {
  const out = Buffer.allocUnsafe(height * rowBytes);
  let src = 0;
  let prev = null;

  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = out.subarray(y * rowBytes, (y + 1) * rowBytes);
    raw.copy(row, 0, src, src + rowBytes);
    src += rowBytes;

    switch (filter) {
      case 0:
        break;
      case 1:
        for (let i = bpp; i < rowBytes; i++) row[i] = (row[i] + row[i - bpp]) & 0xff;
        break;
      case 2:
        if (prev) for (let i = 0; i < rowBytes; i++) row[i] = (row[i] + prev[i]) & 0xff;
        break;
      case 3:
        for (let i = 0; i < rowBytes; i++) {
          const left = i >= bpp ? row[i - bpp] : 0;
          const up = prev ? prev[i] : 0;
          row[i] = (row[i] + ((left + up) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < rowBytes; i++) {
          const a = i >= bpp ? row[i - bpp] : 0;
          const b = prev ? prev[i] : 0;
          const c = prev && i >= bpp ? prev[i - bpp] : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          row[i] = (row[i] + pred) & 0xff;
        }
        break;
      default:
        throw new Error(`Unknown PNG row filter ${filter} on row ${y}`);
    }
    prev = row;
  }
  return out;
}

/** Pull sample `i` out of a scanline at 1, 2, 4, 8 or 16 bits per sample. */
function sampleReader(row, bitDepth) {
  if (bitDepth === 8) return (i) => row[i];
  if (bitDepth === 16) return (i) => row[i * 2]; // drop the low byte
  const per = 8 / bitDepth;
  const max = (1 << bitDepth) - 1;
  return (i) => {
    const byte = row[Math.floor(i / per)];
    const shift = 8 - bitDepth * ((i % per) + 1);
    return (byte >> shift) & max;
  };
}

/** Decode any non-interlaced PNG to straight RGBA8. */
export function decodePng(buf) {
  const info = pngInfo(buf);
  if (info.interlace !== 0) {
    throw new Error('Interlaced PNG is not supported (re-save without Adam7 interlacing)');
  }
  const ch = CHANNELS[info.colorType];
  if (!ch) throw new Error(`Unsupported PNG colour type ${info.colorType}`);
  if (![1, 2, 4, 8, 16].includes(info.bitDepth)) {
    throw new Error(`Unsupported PNG bit depth ${info.bitDepth}`);
  }

  const idat = [];
  let palette = null;
  let transparency = null;
  for (const c of chunks(buf)) {
    if (c.type === 'IDAT') idat.push(c.data);
    else if (c.type === 'PLTE') palette = c.data;
    else if (c.type === 'tRNS') transparency = c.data;
  }
  if (!idat.length) throw new Error('PNG has no image data');
  if (info.colorType === 3 && !palette) throw new Error('Palette PNG with no PLTE chunk');

  const { width, height, bitDepth } = info;
  const raw = inflateSync(Buffer.concat(idat));
  const bitsPerPixel = ch * bitDepth;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const expected = height * (rowBytes + 1);
  if (raw.length < expected) {
    throw new Error(`PNG data is short: ${raw.length} bytes, expected ${expected}`);
  }

  const lines = unfilter(raw, width, height, bpp, rowBytes);
  const rgba = Buffer.allocUnsafe(width * height * 4);
  const scale = bitDepth < 8 ? 255 / ((1 << bitDepth) - 1) : 1;

  for (let y = 0; y < height; y++) {
    const row = lines.subarray(y * rowBytes, (y + 1) * rowBytes);
    const at = sampleReader(row, bitDepth);
    let o = y * width * 4;

    for (let x = 0; x < width; x++) {
      switch (info.colorType) {
        case 0: {
          const g = Math.round(at(x) * scale);
          rgba[o++] = g;
          rgba[o++] = g;
          rgba[o++] = g;
          rgba[o++] = 255;
          break;
        }
        case 2: {
          rgba[o++] = at(x * 3);
          rgba[o++] = at(x * 3 + 1);
          rgba[o++] = at(x * 3 + 2);
          rgba[o++] = 255;
          break;
        }
        case 3: {
          const idx = at(x);
          rgba[o++] = palette[idx * 3] ?? 0;
          rgba[o++] = palette[idx * 3 + 1] ?? 0;
          rgba[o++] = palette[idx * 3 + 2] ?? 0;
          rgba[o++] = transparency ? (transparency[idx] ?? 255) : 255;
          break;
        }
        case 4: {
          const g = Math.round(at(x * 2) * scale);
          rgba[o++] = g;
          rgba[o++] = g;
          rgba[o++] = g;
          rgba[o++] = Math.round(at(x * 2 + 1) * scale);
          break;
        }
        default: {
          rgba[o++] = at(x * 4);
          rgba[o++] = at(x * 4 + 1);
          rgba[o++] = at(x * 4 + 2);
          rgba[o++] = at(x * 4 + 3);
        }
      }
    }
  }

  return { width, height, rgba };
}

function chunk(type, data) {
  const out = Buffer.allocUnsafe(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Sum of absolute deviations — the standard cheap proxy for compressibility. */
function rowCost(row) {
  let sum = 0;
  for (let i = 0; i < row.length; i++) sum += row[i] < 128 ? row[i] : 256 - row[i];
  return sum;
}

/**
 * Encode RGBA8 to PNG.
 *
 * Two things here earn their keep on real screenshots: dropping the alpha
 * channel when nothing is transparent (a quarter fewer bytes before
 * compression), and picking a row filter per row instead of storing raw
 * scanlines (large flat areas of UI compress several times better).
 */
export function encodePng({ width, height, rgba }, { level = 9 } = {}) {
  if (rgba.length < width * height * 4) throw new Error('Pixel buffer is smaller than width × height');

  let opaque = true;
  for (let i = 3; i < width * height * 4; i += 4) {
    if (rgba[i] !== 255) {
      opaque = false;
      break;
    }
  }
  const ch = opaque ? 3 : 4;
  const rowBytes = width * ch;

  const body = Buffer.allocUnsafe(height * (rowBytes + 1));
  const cur = Buffer.allocUnsafe(rowBytes);
  const prev = Buffer.alloc(rowBytes);
  const cand = [Buffer.allocUnsafe(rowBytes), Buffer.allocUnsafe(rowBytes), Buffer.allocUnsafe(rowBytes)];
  let out = 0;

  for (let y = 0; y < height; y++) {
    // Pack the row down to 3 or 4 channels.
    let s = y * width * 4;
    for (let x = 0; x < width; x++) {
      const d = x * ch;
      cur[d] = rgba[s];
      cur[d + 1] = rgba[s + 1];
      cur[d + 2] = rgba[s + 2];
      if (ch === 4) cur[d + 3] = rgba[s + 3];
      s += 4;
    }

    // Sub, Up, Paeth. (Average rarely wins and costs another pass.)
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      cand[0][i] = (cur[i] - a) & 0xff;
      cand[1][i] = (cur[i] - b) & 0xff;
      cand[2][i] = (cur[i] - pred) & 0xff;
    }

    let best = 0; // filter type None
    let bestCost = rowCost(cur);
    for (let k = 0; k < 3; k++) {
      const cost = rowCost(cand[k]);
      if (cost < bestCost) {
        bestCost = cost;
        best = k === 0 ? 1 : k === 1 ? 2 : 4;
      }
    }

    body[out++] = best;
    const src = best === 0 ? cur : best === 1 ? cand[0] : best === 2 ? cand[1] : cand[2];
    src.copy(body, out);
    out += rowBytes;
    cur.copy(prev);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(body, { level })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Box-filter downscale. Averages every source pixel that falls inside a
 * destination pixel, which is the right answer when only shrinking — and
 * unlike nearest-neighbour it keeps one-pixel text legible.
 */
export function resizeRgba({ width, height, rgba }, targetW, targetH) {
  const tw = Math.max(1, Math.round(targetW));
  const th = Math.max(1, Math.round(targetH));
  if (tw === width && th === height) return { width, height, rgba };

  const out = Buffer.allocUnsafe(tw * th * 4);
  const xEdges = new Int32Array(tw + 1);
  for (let x = 0; x <= tw; x++) xEdges[x] = Math.min(width, Math.floor((x * width) / tw));
  const yEdges = new Int32Array(th + 1);
  for (let y = 0; y <= th; y++) yEdges[y] = Math.min(height, Math.floor((y * height) / th));

  for (let y = 0; y < th; y++) {
    const y0 = yEdges[y];
    const y1 = Math.max(y0 + 1, yEdges[y + 1]);
    for (let x = 0; x < tw; x++) {
      const x0 = xEdges[x];
      const x1 = Math.max(x0 + 1, xEdges[x + 1]);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        let i = (sy * width + x0) * 4;
        for (let sx = x0; sx < x1; sx++) {
          r += rgba[i];
          g += rgba[i + 1];
          b += rgba[i + 2];
          a += rgba[i + 3];
          i += 4;
          n++;
        }
      }
      const o = (y * tw + x) * 4;
      out[o] = (r / n) | 0;
      out[o + 1] = (g / n) | 0;
      out[o + 2] = (b / n) | 0;
      out[o + 3] = (a / n) | 0;
    }
  }
  return { width: tw, height: th, rgba: out };
}

/**
 * What a vision model will charge for an image of this size.
 * Anthropic's own approximation is width × height / 750.
 */
export function imageTokens(width, height) {
  return Math.round((width * height) / 750);
}

/**
 * Bring a PNG within a pixel budget, re-encoding only if it has to.
 *
 * Returns { buf, width, height, resized, from }. When the image already fits,
 * the original bytes are returned untouched — there is no point spending CPU
 * and losing a little quality to produce the same picture.
 */
export function fitPng(buf, { maxWidth = 1200, maxHeight = 1200, level = 9 } = {}) {
  const info = pngInfo(buf);
  const scale = Math.min(
    maxWidth ? maxWidth / info.width : 1,
    maxHeight ? maxHeight / info.height : 1,
    1,
  );
  if (scale >= 1) {
    return { buf, width: info.width, height: info.height, resized: false, from: null };
  }

  const decoded = decodePng(buf);
  const small = resizeRgba(decoded, Math.round(info.width * scale), Math.round(info.height * scale));
  return {
    buf: encodePng(small, { level }),
    width: small.width,
    height: small.height,
    resized: true,
    from: { width: info.width, height: info.height },
  };
}

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

/** Sniff the type from the bytes, falling back to the file extension. */
export function imageMime(buf, filename = '') {
  if (isPng(buf)) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 6 && buf.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (buf.length > 12 && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length > 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** Dimensions for the formats we might be handed, without a full decode. */
export function imageSize(buf) {
  if (isPng(buf)) {
    const i = pngInfo(buf);
    return { width: i.width, height: i.height };
  }
  // Baseline/progressive JPEG: walk the segment markers to SOFn.
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = buf[off + 1];
      const len = buf.readUInt16BE(off + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5) };
      }
      off += 2 + len;
    }
  }
  if (buf.length > 10 && buf.subarray(0, 3).toString('latin1') === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  return null;
}

/**
 * Package an image for the MCP reply, shrinking it if it is over budget.
 * Returns { block, note } where `block` is an MCP image content block.
 */
export function toImageContent(buf, { filename = '', maxWidth = 1200, maxHeight = 1200, maxBytes = 5 * 1024 * 1024 } = {}) {
  const mime = imageMime(buf, filename);
  let data = buf;
  let note = '';

  if (mime === 'image/png') {
    const fitted = fitPng(buf, { maxWidth, maxHeight });
    data = fitted.buf;
    note = fitted.resized
      ? `${fitted.from.width}x${fitted.from.height} scaled to ${fitted.width}x${fitted.height}, ~${imageTokens(fitted.width, fitted.height)} image tokens`
      : `${fitted.width}x${fitted.height}, ~${imageTokens(fitted.width, fitted.height)} image tokens`;
  } else {
    const size = imageSize(buf);
    // Only PNG can be resized in process; for anything else, say so rather
    // than quietly sending something huge.
    note = size
      ? `${size.width}x${size.height} ${mime}, ~${imageTokens(size.width, size.height)} image tokens` +
        (maxWidth && size.width > maxWidth ? ' (not resized: only PNG can be resized in-process)' : '')
      : `${mime}, ${data.length} bytes`;
  }

  if (data.length > maxBytes) {
    throw new Error(
      `Image is ${(data.length / 1048576).toFixed(1)}MB, over the ${(maxBytes / 1048576).toFixed(1)}MB limit. ` +
      'Lower max_width, or pass view:false and read the file from disk instead.',
    );
  }

  return {
    block: { type: 'image', data: data.toString('base64'), mimeType: mime },
    note,
    bytes: data.length,
  };
}
