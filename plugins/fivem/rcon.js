// FiveM RCON, over UDP.
//
// FiveM speaks the Quake 3 flavour of RCON, not the Source binary one, which
// is why a Source RCON client will not talk to it:
//
//   request   FF FF FF FF  "rcon <password> <command>"
//   reply     FF FF FF FF  "print" <output>
//
// The awkward part is that there is no length prefix and no terminator. A
// long reply arrives as several datagrams, and the only way to know the reply
// has finished is that no more datagrams turn up. So this collects packets
// until the server goes quiet for `quietMs`, which is also why a command with
// a lot of output takes a beat longer than one with none.
//
// UDP also means a lost packet is simply missing, with nothing to notice it
// by. For anything where that matters — reading a whole log, say — the
// server's stdout via shell_job is the honest channel, and this is for
// commands.

import dgram from 'node:dgram';

const HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);

/** Strip the packet header and the "print" keyword FiveM prefixes replies with. */
function unwrap(packet) {
  let body = packet;
  if (body.length >= 4 && body.subarray(0, 4).equals(HEADER)) body = body.subarray(4);
  let text = body.toString('utf8');
  // Seen as "print\n", "print " and bare "print" depending on the build, so
  // match the keyword rather than assuming a fixed offset.
  const m = text.match(/^print[\s\n]?/);
  if (m) text = text.slice(m[0].length);
  return text;
}

/**
 * Run one RCON command.
 *
 * Resolves { text, packets, ms } — never rejects for an empty reply, because
 * plenty of console commands legitimately print nothing. It does reject when
 * the socket itself fails, since that is a real problem worth reporting.
 */
export function rconCommand({
  host = '127.0.0.1',
  port = 30120,
  password,
  command,
  timeoutMs = 5000,
  quietMs = 350,
} = {}) {
  if (!password) throw new Error('rcon needs a password');
  if (!command) throw new Error('rcon needs a command');

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const packets = [];
    const started = Date.now();
    let quietTimer = null;
    let hardTimer = null;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve({
        text: packets.map(unwrap).join(''),
        packets: packets.length,
        ms: Date.now() - started,
      });
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      reject(err);
    };

    socket.on('message', (msg) => {
      packets.push(msg);
      // Each packet restarts the quiet window: more of the reply may follow.
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    });

    socket.on('error', (err) =>
      fail(new Error(`RCON socket error talking to ${host}:${port}: ${err.message}`)),
    );

    hardTimer = setTimeout(finish, timeoutMs);
    if (hardTimer.unref) hardTimer.unref();

    const payload = Buffer.concat([HEADER, Buffer.from(`rcon ${password} ${command}`, 'utf8')]);
    socket.send(payload, port, host, (err) => {
      if (err) fail(new Error(`Could not send RCON packet to ${host}:${port}: ${err.message}`));
    });
  });
}

/** Recognise the two replies that mean "your command did not run". */
export function rconRejection(text) {
  if (/invalid password/i.test(text)) {
    return 'the RCON password is wrong';
  }
  if (/must set rcon_password/i.test(text)) {
    return 'the server has no rcon_password set, so RCON is disabled there — add `set rcon_password "…"` to server.cfg and restart';
  }
  return null;
}
