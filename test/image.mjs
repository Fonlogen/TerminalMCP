// PNG codec, resizing, and the desktop-capture decision table.
//
// All of this is deliberately pure: no browser, no display, no network. It is
// the part of the screenshot feature that can be verified on a headless CI
// box, which is where the capture back ends themselves cannot be.

import process from 'node:process';
import { deflateSync } from 'node:zlib';
import {
  decodePng,
  encodePng,
  fitPng,
  imageMime,
  imageSize,
  imageTokens,
  isPng,
  pngInfo,
  resizeRgba,
  toImageContent,
} from '../src/image.js';
import { LINUX_CAPTURERS, pickCapturer, sessionType, WINDOWS_SCRIPT } from '../src/screen.js';
import { crc32 } from '../src/archive.js';

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failures.push(`${name} — ${detail}`); console.log(`  FAIL ${name} — ${detail}`); }
}
function throws(name, fn, match) {
  try {
    fn();
    check(name, false, 'did not throw');
  } catch (err) {
    check(name, match ? match.test(err.message) : true, err.message);
  }
}

/** A deterministic test image with a gradient, hard edges and an alpha ramp. */
function makeImage(w, h, { opaque = false } = {}) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = (x * 255) / Math.max(1, w - 1);
      rgba[o + 1] = (y * 255) / Math.max(1, h - 1);
      rgba[o + 2] = (x ^ y) & 0xff;
      rgba[o + 3] = opaque ? 255 : x < w / 2 ? 255 : 128;
    }
  }
  return { width: w, height: h, rgba };
}

function main() {
  console.log('\n--- PNG round trip ---');
  {
    const src = makeImage(61, 37);
    const png = encodePng(src);
    check('output is a PNG', isPng(png));
    const info = pngInfo(png);
    check('dimensions survive', info.width === 61 && info.height === 37, JSON.stringify(info));
    check('alpha forces colour type 6', info.colorType === 6, String(info.colorType));
    const back = decodePng(png);
    check('decode gives the same pixel count', back.rgba.length === src.rgba.length);
    check('round trip is lossless', back.rgba.equals(src.rgba));
  }

  {
    const src = makeImage(64, 40, { opaque: true });
    const png = encodePng(src);
    check('a fully opaque image drops to colour type 2', pngInfo(png).colorType === 2);
    const back = decodePng(png);
    check('opaque round trip is lossless', back.rgba.equals(src.rgba));
    check('imageSize reads dimensions without decoding', JSON.stringify(imageSize(png)) === '{"width":64,"height":40}');
  }

  {
    // 1x1 and 1xN are where off-by-one errors in the row filters show up.
    for (const [w, h] of [[1, 1], [1, 9], [9, 1], [2, 2]]) {
      const src = makeImage(w, h, { opaque: true });
      const back = decodePng(encodePng(src));
      check(`${w}x${h} round trip`, back.rgba.equals(src.rgba));
    }
  }

  console.log('\n--- filters actually compress ---');
  {
    // A flat fill is the case row filters exist for: it must not come out
    // anywhere near its raw size.
    const flat = { width: 600, height: 400, rgba: Buffer.alloc(600 * 400 * 4) };
    for (let i = 0; i < flat.rgba.length; i += 4) {
      flat.rgba[i] = 240; flat.rgba[i + 1] = 240; flat.rgba[i + 2] = 245; flat.rgba[i + 3] = 255;
    }
    const png = encodePng(flat);
    check('a flat image compresses below 1% of raw', png.length < 600 * 400 * 3 * 0.01, `${png.length} bytes`);
    check('and still decodes correctly', decodePng(png).rgba.equals(flat.rgba));

    // A horizontal gradient is what Sub is for; vertical is what Up is for.
    const vertical = { width: 300, height: 300, rgba: Buffer.alloc(300 * 300 * 4) };
    for (let y = 0; y < 300; y++) {
      for (let x = 0; x < 300; x++) {
        const o = (y * 300 + x) * 4;
        vertical.rgba[o] = vertical.rgba[o + 1] = vertical.rgba[o + 2] = y;
        vertical.rgba[o + 3] = 255;
      }
    }
    const vpng = encodePng(vertical);
    check('a vertical gradient compresses hard (Up filter)', vpng.length < 300 * 300 * 3 * 0.02, `${vpng.length} bytes`);
  }

  console.log('\n--- resizing ---');
  {
    const src = makeImage(100, 50, { opaque: true });
    const half = resizeRgba(src, 50, 25);
    check('resize halves both axes', half.width === 50 && half.height === 25);
    check('resize produces the right buffer size', half.rgba.length === 50 * 25 * 4);

    // A box filter over a uniform block must return exactly that colour.
    const solid = { width: 40, height: 40, rgba: Buffer.alloc(40 * 40 * 4) };
    for (let i = 0; i < solid.rgba.length; i += 4) {
      solid.rgba[i] = 10; solid.rgba[i + 1] = 20; solid.rgba[i + 2] = 30; solid.rgba[i + 3] = 255;
    }
    const small = resizeRgba(solid, 7, 7);
    let exact = true;
    for (let i = 0; i < small.rgba.length; i += 4) {
      if (small.rgba[i] !== 10 || small.rgba[i + 1] !== 20 || small.rgba[i + 2] !== 30) exact = false;
    }
    check('averaging a solid colour returns that colour', exact);

    check('resizing to the same size is a no-op', resizeRgba(src, 100, 50).rgba === src.rgba);
    check('resize never produces a zero dimension', resizeRgba(src, 0, 0).width === 1);
  }

  console.log('\n--- fitPng ---');
  {
    const big = encodePng(makeImage(1000, 600, { opaque: true }));
    const fitted = fitPng(big, { maxWidth: 250 });
    check('fitPng scales down', fitted.width === 250 && fitted.height === 150, `${fitted.width}x${fitted.height}`);
    check('fitPng reports the original size', fitted.from.width === 1000);
    check('fitPng result is a valid PNG', pngInfo(fitted.buf).width === 250);

    const untouched = fitPng(big, { maxWidth: 4000 });
    check('an image already within budget is returned byte-identical', untouched.buf === big);
    check('and is marked as not resized', untouched.resized === false);

    const tall = encodePng(makeImage(100, 1000, { opaque: true }));
    const byHeight = fitPng(tall, { maxWidth: 10000, maxHeight: 200 });
    check('maxHeight constrains too', byHeight.height === 200 && byHeight.width === 20, `${byHeight.width}x${byHeight.height}`);
  }

  console.log('\n--- token accounting ---');
  {
    check('a 1200x800 image is about 1280 tokens', Math.abs(imageTokens(1200, 800) - 1280) < 5, String(imageTokens(1200, 800)));
    check(
      'halving the width quarters the cost',
      Math.abs(imageTokens(1200, 800) / imageTokens(600, 400) - 4) < 0.01,
    );
    const big = encodePng(makeImage(2000, 1200, { opaque: true }));
    const { note } = toImageContent(big, { maxWidth: 1000 });
    check('toImageContent explains what it did', /2000x1200 scaled to 1000x600/.test(note), note);
    check('and quotes a token estimate', /image tokens/.test(note), note);
  }

  console.log('\n--- MCP image blocks ---');
  {
    const png = encodePng(makeImage(80, 60, { opaque: true }));
    const { block, bytes } = toImageContent(png, { maxWidth: 500 });
    check('block has the MCP image shape', block.type === 'image' && typeof block.data === 'string');
    check('block declares a mime type', block.mimeType === 'image/png');
    check('base64 decodes back to the same bytes', Buffer.from(block.data, 'base64').length === bytes);

    throws(
      'an over-budget image is refused with advice',
      () => toImageContent(png, { maxWidth: 500, maxBytes: 10 }),
      /over the .* limit|max_width/,
    );
  }

  console.log('\n--- format sniffing ---');
  {
    const png = encodePng(makeImage(4, 4));
    check('png sniffed from magic bytes', imageMime(png) === 'image/png');
    check('jpeg sniffed from magic bytes', imageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])) === 'image/jpeg');
    check('gif sniffed', imageMime(Buffer.from('GIF89a......', 'latin1')) === 'image/gif');
    check('unknown bytes fall back to the extension', imageMime(Buffer.from([1, 2, 3, 4]), 'x.webp') === 'image/webp');
    check('and to octet-stream with nothing to go on', imageMime(Buffer.from([1, 2, 3, 4]), 'x.bin') === 'application/octet-stream');

    // A real JPEG header, so the SOF0 walk is exercised rather than assumed.
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x90, 0x02, 0x80]),
      Buffer.alloc(8),
    ]);
    check('jpeg dimensions read from SOF0', JSON.stringify(imageSize(jpeg)) === '{"width":640,"height":400}', JSON.stringify(imageSize(jpeg)));
  }

  console.log('\n--- damaged input is refused, not crashed on ---');
  {
    throws('not a PNG at all', () => pngInfo(Buffer.from('hello world')), /Not a PNG/);
    throws('truncated header', () => pngInfo(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), /truncated/);

    const good = encodePng(makeImage(20, 20));
    const noData = Buffer.concat([good.subarray(0, 33), good.subarray(good.length - 12)]);
    throws('a PNG with no image data', () => decodePng(noData), /no image data/);

    // An interlaced PNG: we do not support Adam7 and must say so clearly
    // rather than producing scrambled pixels.
    const interlaced = Buffer.from(good);
    interlaced[28] = 1;
    throws('interlaced PNG', () => decodePng(interlaced), /nterlac/);

    const badFilter = (() => {
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(2, 0);
      ihdr.writeUInt32BE(1, 4);
      ihdr[8] = 8;
      ihdr[9] = 2;
      const chunk = (type, data) => {
        const out = Buffer.allocUnsafe(data.length + 12);
        out.writeUInt32BE(data.length, 0);
        out.write(type, 4, 'latin1');
        data.copy(out, 8);
        out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
        return out;
      };
      // filter byte 9 does not exist
      const body = Buffer.from([9, 1, 2, 3, 4, 5, 6]);
      return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(body)),
        chunk('IEND', Buffer.alloc(0)),
      ]);
    })();
    throws('an unknown row filter', () => decodePng(badFilter), /row filter/);

    throws(
      'a pixel buffer smaller than the dimensions claim',
      () => encodePng({ width: 100, height: 100, rgba: Buffer.alloc(10) }),
      /smaller than/,
    );
  }

  console.log('\n--- desktop capture: back end selection ---');
  {
    const none = pickCapturer('full', { session: 'x11', installed: [] });
    check('with nothing installed there is no tool', none.tool === null);
    check('and the message says so', /no screenshot tool installed/.test(none.reason), none.reason);
    check('and it suggests what to install', none.suggest.length > 0);

    check('maim is preferred over scrot on X11', pickCapturer('region', { session: 'x11', installed: ['scrot', 'maim'] }).tool.name === 'maim');
    check('grim is used on Wayland', pickCapturer('full', { session: 'wayland', installed: ['grim'] }).tool.name === 'grim');

    const wrong = pickCapturer('full', { session: 'wayland', installed: ['maim'] });
    check('an X11 tool is not used on Wayland', wrong.tool === null);
    check('and the reason names the mismatch', /is for x11/.test(wrong.reason), wrong.reason);

    const cannot = pickCapturer('window', { session: 'x11', installed: ['scrot'] });
    check('a tool that cannot target a window is rejected for that mode', cannot.tool === null);
    check('and the reason lists what it can do', /supports full, region/.test(cannot.reason), cannot.reason);
    check('a capable alternative is suggested', cannot.suggest.some((s) => /maim|imagemagick/.test(s)));

    check(
      'every back end can at least capture the whole screen',
      LINUX_CAPTURERS.every((c) => typeof c.full === 'function'),
    );
    check(
      'every back end has install advice',
      LINUX_CAPTURERS.every((c) => typeof c.install === 'string' && c.install.length > 0),
    );
  }

  console.log('\n--- the Windows capture script ---');
  {
    // It cannot be run here, so check the parts that silently break if edited.
    check('declares the parameters the code passes', /param\(/.test(WINDOWS_SCRIPT) && /\$Title/.test(WINDOWS_SCRIPT));
    check('handles every mode the code asks for', ['displays', 'windows', 'full', 'display', 'region', 'window'].every((m) => WINDOWS_SCRIPT.includes(`'${m}'`)));
    check('uses a literal here-string so C# is not interpolated', WINDOWS_SCRIPT.includes("Add-Type @'"));
    check('here-string is closed', WINDOWS_SCRIPT.includes("'@"));
    check('emits tab-separated rows PowerShell-side', WINDOWS_SCRIPT.includes('"`t"'));
    check('emits tab-separated rows C#-side', WINDOWS_SCRIPT.includes('"\\t"'));
    check('makes the process DPI aware', /SetProcessDPIAware/.test(WINDOWS_SCRIPT));
    check('loads System.Drawing and Windows.Forms', /System\.Drawing/.test(WINDOWS_SCRIPT) && /System\.Windows\.Forms/.test(WINDOWS_SCRIPT));
    const braces = [...WINDOWS_SCRIPT].reduce((n, ch) => n + (ch === '{' ? 1 : ch === '}' ? -1 : 0), 0);
    check('braces balance', braces === 0, String(braces));
  }

  console.log('\n--- session detection ---');
  {
    const s = sessionType();
    check(
      'session type is one we handle, or null when headless',
      s === null || ['x11', 'wayland', 'quartz', 'windows'].includes(s),
      String(s),
    );
    if (s === null) console.log('      (headless here, as expected on CI — desktop capture paths are not exercised)');
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main();
