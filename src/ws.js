// A minimal WebSocket client, written by hand.
//
// Node 22 ships a global WebSocket, but this server supports Node 18, which
// does not — and adding `ws` would break the zero-dependency promise for one
// transport. The protocol (RFC 6455) is a handshake plus a frame header, so
// it lives here in about as much code as the dependency's README.
//
// Scope is deliberately "enough for CDP": client-side only, no extensions, no
// permessage-deflate, no subprotocols. What it does handle is the part CDP
// actually needs — multi-megabyte messages arriving in fragments, which is
// what a screenshot response looks like on the wire.

import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
};

/**
 * A byte queue that never re-concatenates what it does not have to.
 *
 * The naive version of this (`buf = Buffer.concat([buf, chunk])` on every
 * data event) copies the whole backlog per chunk, which turns a 6MB
 * screenshot arriving in 64KB pieces into hundreds of megabytes of copying.
 * Here chunks are held as they arrive and only the bytes a frame actually
 * claims are ever copied.
 */
class ByteQueue {
  constructor() {
    this.chunks = [];
    this.length = 0;
    this.offset = 0; // read position inside chunks[0]
  }

  push(chunk) {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  /** Byte at logical index `i`, without consuming. Used for frame headers. */
  at(i) {
    let idx = i + this.offset;
    for (const c of this.chunks) {
      if (idx < c.length) return c[idx];
      idx -= c.length;
    }
    return undefined;
  }

  /** Consume exactly `n` bytes. The caller has already checked `length`. */
  read(n) {
    if (n === 0) return Buffer.alloc(0);

    const first = this.chunks[0];
    // Fast path: the whole read is inside the current chunk, so hand back a
    // view of it instead of a copy.
    if (first.length - this.offset >= n) {
      const out = first.subarray(this.offset, this.offset + n);
      this.offset += n;
      this.length -= n;
      if (this.offset === first.length) {
        this.chunks.shift();
        this.offset = 0;
      }
      return out;
    }

    const out = Buffer.allocUnsafe(n);
    let written = 0;
    while (written < n) {
      const c = this.chunks[0];
      const take = Math.min(c.length - this.offset, n - written);
      c.copy(out, written, this.offset, this.offset + take);
      written += take;
      this.offset += take;
      this.length -= take;
      if (this.offset === c.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    return out;
  }
}

function maskInPlace(buf, mask) {
  for (let i = 0; i < buf.length; i++) buf[i] ^= mask[i & 3];
  return buf;
}

/** Build one client frame. Clients must mask; servers must not. */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.allocUnsafe(6);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(8);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(14);
    header[1] = 0x80 | 127;
    // 64-bit length. The high word is always zero here: nothing this client
    // sends comes close to 4GB.
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x80 | opcode; // FIN

  const mask = randomBytes(4);
  mask.copy(header, header.length - 4);
  return Buffer.concat([header, maskInPlace(Buffer.from(payload), mask)]);
}

export class WebSocketClient extends EventEmitter {
  constructor(socket, { maxPayload }) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.closed = false;
    this.queue = new ByteQueue();
    this.fragments = [];
    this.fragmentOp = null;
    this.fragmentBytes = 0;

    socket.on('data', (chunk) => {
      this.queue.push(chunk);
      try {
        this._drain();
      } catch (err) {
        this._fail(err);
      }
    });
    socket.on('error', (err) => this._fail(err));
    socket.on('close', () => this._down('socket closed'));
  }

  _fail(err) {
    if (this.closed) return;
    this.emit('error', err);
    this._down(err.message);
  }

  _down(reason) {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      /* already gone */
    }
    this.emit('close', reason);
  }

  _drain() {
    for (;;) {
      const q = this.queue;
      if (q.length < 2) return;

      const b0 = q.at(0);
      const b1 = q.at(1);
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      const short = b1 & 0x7f;

      let headerLen = 2;
      let payloadLen = short;
      if (short === 126) {
        headerLen = 4;
        if (q.length < headerLen) return;
        payloadLen = (q.at(2) << 8) | q.at(3);
      } else if (short === 127) {
        headerLen = 10;
        if (q.length < headerLen) return;
        // Only the low 32 bits can matter; a frame above 4GB is rejected.
        const hi =
          q.at(2) * 0x1000000 + (q.at(3) << 16) + (q.at(4) << 8) + q.at(5);
        const lo =
          q.at(6) * 0x1000000 + (q.at(7) << 16) + (q.at(8) << 8) + q.at(9);
        if (hi !== 0) throw new Error('WebSocket frame larger than 4GB');
        payloadLen = lo;
      }
      // A server frame must not be masked, but tolerate it rather than
      // dropping a connection over a technicality.
      if (masked) headerLen += 4;

      if (payloadLen > this.maxPayload) {
        throw new Error(
          `WebSocket frame of ${payloadLen} bytes exceeds the ${this.maxPayload} byte limit`,
        );
      }
      if (q.length < headerLen + payloadLen) return; // wait for the rest

      q.read(headerLen - (masked ? 4 : 0));
      const mask = masked ? q.read(4) : null;
      let payload = q.read(payloadLen);
      if (mask) payload = maskInPlace(Buffer.from(payload), mask);

      this._frame(fin, opcode, payload);
    }
  }

  _frame(fin, opcode, payload) {
    switch (opcode) {
      case OP.ping:
        if (!this.closed) this.socket.write(encodeFrame(OP.pong, payload));
        return;
      case OP.pong:
        return;
      case OP.close: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        if (!this.closed) {
          try {
            this.socket.write(encodeFrame(OP.close, payload.subarray(0, 2)));
          } catch {
            /* peer may already be gone */
          }
        }
        this._down(reason || `closed with code ${code}`);
        return;
      }
      case OP.continuation: {
        if (this.fragmentOp === null) throw new Error('WebSocket continuation with nothing to continue');
        this._collect(fin, payload);
        return;
      }
      case OP.text:
      case OP.binary: {
        if (fin) {
          this._deliver(opcode, payload);
          return;
        }
        this.fragmentOp = opcode;
        this.fragments = [payload];
        this.fragmentBytes = payload.length;
        return;
      }
      default:
        throw new Error(`Unknown WebSocket opcode 0x${opcode.toString(16)}`);
    }
  }

  _collect(fin, payload) {
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > this.maxPayload) {
      throw new Error(
        `WebSocket message of ${this.fragmentBytes} bytes exceeds the ${this.maxPayload} byte limit`,
      );
    }
    this.fragments.push(payload);
    if (!fin) return;

    const op = this.fragmentOp;
    const whole = Buffer.concat(this.fragments, this.fragmentBytes);
    this.fragments = [];
    this.fragmentOp = null;
    this.fragmentBytes = 0;
    this._deliver(op, whole);
  }

  _deliver(opcode, payload) {
    if (opcode === OP.text) this.emit('message', payload.toString('utf8'), false);
    else this.emit('message', payload, true);
  }

  send(data) {
    if (this.closed) throw new Error('WebSocket is closed');
    const isBuf = Buffer.isBuffer(data);
    this.socket.write(encodeFrame(isBuf ? OP.binary : OP.text, isBuf ? data : Buffer.from(String(data), 'utf8')));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const payload = Buffer.allocUnsafe(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2, 'utf8');
    try {
      this.socket.write(encodeFrame(OP.close, payload));
    } catch {
      /* nothing to negotiate with */
    }
    // Do not wait for a courteous close handshake; the caller is shutting down.
    this._down('closed locally');
  }
}

/**
 * Open a WebSocket connection.
 *
 * `maxPayload` defaults high on purpose: a full-page screenshot of a long
 * document arrives as one base64 string inside one CDP message.
 */
export function wsConnect(url, { headers = {}, maxPayload = 192 * 1024 * 1024, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error(`Not a URL: ${url}`));
    }
    const secure = u.protocol === 'wss:';
    if (!secure && u.protocol !== 'ws:') {
      return reject(new Error(`Not a WebSocket URL: ${url}`));
    }

    const port = u.port ? Number(u.port) : secure ? 443 : 80;
    const key = randomBytes(16).toString('base64');
    const expect = createHash('sha1').update(key + GUID).digest('base64');

    const socket = secure
      ? tls.connect({ host: u.hostname, port, servername: u.hostname })
      : net.connect({ host: u.hostname, port });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`WebSocket handshake to ${url} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };

    socket.on('error', (err) => fail(new Error(`WebSocket connect to ${url} failed: ${err.message}`)));

    socket.on(secure ? 'secureConnect' : 'connect', () => {
      const lines = [
        `GET ${u.pathname}${u.search} HTTP/1.1`,
        `Host: ${u.hostname}${u.port ? `:${u.port}` : ''}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        // Chrome rejects a devtools connection whose Origin it does not like;
        // sending none at all is what the DevTools frontend effectively does.
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        '',
        '',
      ];
      socket.write(lines.join('\r\n'));
    });

    // Read the handshake response by hand: the body of the upgrade response is
    // already WebSocket frames, so we must not let anything else buffer it.
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) {
        if (head.length > 64 * 1024) fail(new Error('WebSocket handshake response too large'));
        return;
      }

      const raw = head.subarray(0, end).toString('latin1');
      const rest = head.subarray(end + 4);
      socket.off('data', onData);

      const [statusLine, ...headerLines] = raw.split('\r\n');
      const status = Number(statusLine.split(' ')[1]);
      if (status !== 101) {
        return fail(new Error(`WebSocket handshake to ${url} returned HTTP ${status || statusLine}`));
      }

      const got = headerLines
        .map((l) => l.split(':'))
        .find(([k]) => k.toLowerCase() === 'sec-websocket-accept');
      if (!got || got.slice(1).join(':').trim() !== expect) {
        return fail(new Error('WebSocket handshake failed: bad Sec-WebSocket-Accept'));
      }

      settled = true;
      clearTimeout(timer);
      socket.setNoDelay(true);
      const client = new WebSocketClient(socket, { maxPayload });
      // Anything that arrived in the same TCP segment as the response headers
      // is already frame data and would otherwise be lost.
      if (rest.length) {
        client.queue.push(rest);
        try {
          client._drain();
        } catch (err) {
          client._fail(err);
        }
      }
      resolve(client);
    };
    socket.on('data', onData);
  });
}
