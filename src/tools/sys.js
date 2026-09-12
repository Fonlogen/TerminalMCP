// Group: sys — machine facts and process control.

import os from 'node:os';
import process from 'node:process';
import { runArgv } from '../exec.js';
import { assertCommandAllowed } from '../guards.js';
import { truncateMiddle } from '../format.js';

const IS_WIN = process.platform === 'win32';

export const TOOLS = [
  {
    name: 'sys_info',
    description:
      'Facts about the machine: overview (default), cpu, memory, disk (free space per mount), ' +
      'network (interfaces), env (environment variables), uptime, user. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['overview', 'cpu', 'memory', 'disk', 'network', 'env', 'uptime', 'user', 'all'],
          description: 'Which facts to return. Default overview.',
        },
        filter: { type: 'string', description: 'env: regex on the variable name, e.g. "^(PATH|NODE)".' },
        show_values: { type: 'boolean', description: 'env: include values. Default true; set false to list names only.' },
        max_bytes: { type: 'integer', description: 'Byte cap on returned output.' },
      },
    },
  },

  {
    name: 'proc',
    description:
      'Processes on this machine: list (filter by name, sort by cpu/memory), tree (parent/child ' +
      'hierarchy), info (one pid in detail), kill (by pid, or every process matching a name — ' +
      'which requires confirm=true). Uses ps on Unix and PowerShell/tasklist on Windows.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'tree', 'info', 'kill'], description: 'What to do. Default list.' },
        name: { type: 'string', description: 'list/kill: regex matched against the process name and command line.' },
        pid: { type: 'integer', description: 'info/kill/tree: the process id.' },
        sort: { type: 'string', enum: ['cpu', 'memory', 'pid', 'name'], description: 'list: ordering. Default cpu.' },
        limit: { type: 'integer', description: 'list: how many processes to show. Default 25.' },
        signal: { type: 'string', description: 'kill: SIGTERM (default), SIGKILL, SIGINT. Ignored on Windows, which always force-kills.' },
        tree: { type: 'boolean', description: 'kill: also kill the children of the target.' },
        confirm: { type: 'boolean', description: 'Required to kill by name, since a regex can match more than you meant.' },
        max_bytes: { type: 'integer', description: 'Byte cap on returned output.' },
      },
    },
  },
];

function humanBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function duration(seconds) {
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

/** Parse one CSV line, honouring quotes — tasklist /FO CSV output. */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Read the process table. Returns [{ pid, ppid, cpu, memBytes, name, command, elapsed }]. */
async function processTable(cfg) {
  if (!IS_WIN) {
    const run = await runArgv(cfg, {
      file: 'ps',
      args: ['-eo', 'pid=,ppid=,pcpu=,rss=,etimes=,comm=,args=', '-ww'],
      timeoutMs: 20000,
    });
    if (run.error) throw new Error(`cannot read the process table: ${run.error}`);
    const rows = [];
    for (const line of run.stdout.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      // Six fixed numeric/short fields, then the full command line.
      const m = /^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(t);
      if (!m) continue;
      rows.push({
        pid: Number(m[1]),
        ppid: Number(m[2]),
        cpu: Number(m[3]),
        memBytes: Number(m[4]) * 1024,
        elapsed: Number(m[5]),
        name: m[6].split('/').pop(),
        command: m[7] || m[6],
      });
    }
    return rows;
  }

  // Windows: CIM gives the parent pid and command line, which tasklist does not.
  const ps = await runArgv(cfg, {
    file: 'powershell.exe',
    args: [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,CommandLine,CreationDate | ConvertTo-Json -Compress -Depth 2',
    ],
    timeoutMs: 30000,
  });
  if (!ps.error && ps.exitCode === 0 && ps.stdout.trim()) {
    try {
      const parsed = JSON.parse(ps.stdout);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const now = Date.now();
      return list.map((x) => {
        const created = x.CreationDate ? Date.parse(String(x.CreationDate).replace(/^\/Date\((\d+)\)\/$/, '$1')) : NaN;
        return {
          pid: Number(x.ProcessId),
          ppid: Number(x.ParentProcessId ?? 0),
          cpu: 0, // CIM has no instantaneous CPU%; left at 0 rather than faked
          memBytes: Number(x.WorkingSetSize ?? 0),
          elapsed: Number.isNaN(created) ? 0 : Math.max(0, (now - created) / 1000),
          name: String(x.Name ?? ''),
          command: String(x.CommandLine ?? x.Name ?? ''),
        };
      });
    } catch {
      /* fall through to tasklist */
    }
  }

  const tl = await runArgv(cfg, { file: 'tasklist', args: ['/FO', 'CSV', '/NH'], timeoutMs: 20000 });
  if (tl.error) throw new Error(`cannot read the process table: ${tl.error}`);
  return tl.stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => {
      const f = parseCsvLine(line.trim());
      return {
        pid: Number(f[1]),
        ppid: 0,
        cpu: 0,
        memBytes: Number(String(f[4] ?? '0').replace(/[^\d]/g, '')) * 1024,
        elapsed: 0,
        name: f[0] ?? '',
        command: f[0] ?? '',
      };
    })
    .filter((r) => Number.isFinite(r.pid));
}

async function diskInfo(cfg) {
  if (!IS_WIN) {
    const run = await runArgv(cfg, { file: 'df', args: ['-kP'], timeoutMs: 15000 });
    if (run.error) return `disk: ${run.error}`;
    const lines = run.stdout.split('\n').filter(Boolean).slice(1);
    const rows = lines
      .map((l) => l.trim().split(/\s+/))
      .filter((f) => f.length >= 6)
      .map((f) => {
        const total = Number(f[1]) * 1024;
        const used = Number(f[2]) * 1024;
        const avail = Number(f[3]) * 1024;
        return { mount: f.slice(5).join(' '), fs: f[0], total, used, avail, pct: f[4] };
      })
      .filter((r) => r.total > 0);
    return rows
      .map((r) => `${r.mount.padEnd(24)} ${humanBytes(r.avail).padStart(9)} free of ${humanBytes(r.total).padStart(9)} (${r.pct} used)  ${r.fs}`)
      .join('\n');
  }

  const run = await runArgv(cfg, {
    file: 'powershell.exe',
    args: [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'Get-PSDrive -PSProvider FileSystem | Select-Object Name,Used,Free | ConvertTo-Json -Compress',
    ],
    timeoutMs: 20000,
  });
  if (run.error || run.exitCode !== 0) return `disk: unavailable (${run.error || `exit ${run.exitCode}`})`;
  try {
    const parsed = JSON.parse(run.stdout);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .map((d) => {
        const used = Number(d.Used ?? 0);
        const free = Number(d.Free ?? 0);
        const total = used + free;
        const pct = total ? `${Math.round((used / total) * 100)}%` : '?';
        return `${String(d.Name)}:${''.padEnd(22)} ${humanBytes(free).padStart(9)} free of ${humanBytes(total).padStart(9)} (${pct} used)`;
      })
      .join('\n');
  } catch (err) {
    return `disk: could not parse Get-PSDrive output (${err.message})`;
  }
}

function networkInfo() {
  const ifaces = os.networkInterfaces();
  const rows = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      rows.push(
        `${name.padEnd(14)} ${a.family.padEnd(5)} ${a.address}${a.netmask ? `/${a.netmask}` : ''}` +
        `${a.internal ? ' (internal)' : ''}${a.mac && a.mac !== '00:00:00:00:00:00' ? `  mac=${a.mac}` : ''}`,
      );
    }
  }
  return rows.join('\n') || '(no interfaces)';
}

export function createHandlers({ cfg }) {
  return {
    async sys_info(p) {
      const action = p.action || 'overview';
      const cap = p.max_bytes ?? cfg.maxOutputBytes;
      const cpus = os.cpus();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();

      const sections = {
        overview: () =>
          [
            `host      ${os.hostname()}`,
            `os        ${os.type()} ${os.release()} (${process.platform}/${process.arch})`,
            `cpu       ${cpus.length} x ${cpus[0]?.model?.trim() ?? 'unknown'}`,
            `memory    ${humanBytes(totalMem - freeMem)} used of ${humanBytes(totalMem)} (${Math.round(((totalMem - freeMem) / totalMem) * 100)}%)`,
            `load      ${os.loadavg().map((n) => n.toFixed(2)).join(' ')}${IS_WIN ? ' (load average is always 0 on Windows)' : ''}`,
            `uptime    ${duration(os.uptime())}`,
            `user      ${os.userInfo().username} (home ${os.homedir()})`,
            `node      ${process.version}`,
            `server    pid ${process.pid}, cwd ${cfg.cwd}, up ${duration(process.uptime())}`,
          ].join('\n'),

        cpu: () => {
          const byModel = new Map();
          for (const c of cpus) byModel.set(c.model.trim(), (byModel.get(c.model.trim()) ?? 0) + 1);
          const times = cpus.reduce(
            (acc, c) => {
              for (const k of Object.keys(c.times)) acc[k] = (acc[k] ?? 0) + c.times[k];
              return acc;
            },
            {},
          );
          const total = Object.values(times).reduce((a, b) => a + b, 0) || 1;
          return [
            `cores     ${cpus.length}`,
            ...[...byModel].map(([m, n]) => `model     ${n}x ${m}`),
            `speed     ${cpus[0]?.speed ?? '?'} MHz`,
            `load      ${os.loadavg().map((n) => n.toFixed(2)).join(' ')} (1m 5m 15m)`,
            `time split ${Object.entries(times).map(([k, v]) => `${k}=${((v / total) * 100).toFixed(1)}%`).join(' ')}`,
          ].join('\n');
        },

        memory: () =>
          [
            `total     ${humanBytes(totalMem)}`,
            `free      ${humanBytes(freeMem)}`,
            `used      ${humanBytes(totalMem - freeMem)} (${Math.round(((totalMem - freeMem) / totalMem) * 100)}%)`,
            `server rss ${humanBytes(process.memoryUsage().rss)}`,
          ].join('\n'),

        disk: () => diskInfo(cfg),
        network: () => networkInfo(),
        uptime: () => `system up ${duration(os.uptime())}, this server up ${duration(process.uptime())}`,

        user: () => {
          const u = os.userInfo();
          return [
            `user      ${u.username}`,
            `home      ${u.homedir}`,
            `shell     ${u.shell ?? '(n/a)'}`,
            ...(IS_WIN ? [] : [`uid/gid   ${u.uid}/${u.gid}`]),
            `tmp       ${os.tmpdir()}`,
          ].join('\n');
        },

        env: () => {
          const re = p.filter ? new RegExp(p.filter, 'i') : null;
          const keys = Object.keys(process.env).filter((k) => !re || re.test(k)).sort();
          if (!keys.length) return p.filter ? `no environment variables match /${p.filter}/` : '(no environment)';
          return keys
            .map((k) => (p.show_values === false ? k : `${k}=${process.env[k]}`))
            .join('\n');
        },
      };

      if (action === 'all') {
        const parts = [];
        for (const key of ['overview', 'cpu', 'memory', 'disk', 'network']) {
          parts.push(`--- ${key} ---\n${await sections[key]()}`);
        }
        return truncateMiddle(parts.join('\n\n'), cap).text;
      }

      const fn = sections[action];
      if (!fn) throw new Error(`Unknown sys_info action "${action}". One of: ${Object.keys(sections).join(', ')}, all`);
      return truncateMiddle(String(await fn()), cap).text;
    },

    async proc(p) {
      const action = p.action || 'list';
      const cap = p.max_bytes ?? cfg.maxOutputBytes;

      if (action === 'kill') {
        assertCommandAllowed(cfg, `kill ${p.pid ?? p.name ?? ''}`);
        const signal = p.signal || 'SIGTERM';

        if (p.pid) {
          const killed = [];
          const targets = [Number(p.pid)];
          if (p.tree) {
            const table = await processTable(cfg);
            const queue = [Number(p.pid)];
            while (queue.length) {
              const parent = queue.shift();
              for (const row of table) {
                if (row.ppid === parent && !targets.includes(row.pid)) {
                  targets.push(row.pid);
                  queue.push(row.pid);
                }
              }
            }
          }
          // Children first, so a parent cannot respawn them mid-kill.
          for (const pid of targets.reverse()) {
            try {
              if (IS_WIN) {
                const r = await runArgv(cfg, { file: 'taskkill', args: ['/PID', String(pid), '/F'], timeoutMs: 10000 });
                if (r.exitCode === 0) killed.push(pid);
              } else {
                process.kill(pid, signal);
                killed.push(pid);
              }
            } catch (err) {
              if (err.code === 'ESRCH') continue; // already gone
              if (err.code === 'EPERM') throw new Error(`no permission to signal pid ${pid}`);
              throw err;
            }
          }
          if (!killed.length) return `pid ${p.pid} not found (nothing signalled)`;
          return `sent ${IS_WIN ? 'force kill' : signal} to ${killed.length} process(es): ${killed.join(', ')}`;
        }

        if (!p.name) throw new Error('kill needs "pid" or "name"');
        if (!p.confirm) {
          const table = await processTable(cfg);
          const re = new RegExp(p.name, 'i');
          const matches = table.filter((r) => re.test(r.name) || re.test(r.command));
          const list = matches
            .slice(0, 20)
            .map((r) => `  ${r.pid} ${r.name} — ${r.command.slice(0, 90)}`)
            .join('\n');
          return (
            `Would signal ${matches.length} process(es) matching /${p.name}/:\n${list}` +
            `${matches.length > 20 ? `\n  ... and ${matches.length - 20} more` : ''}\n` +
            `Pass confirm:true to actually kill them.`
          );
        }
        const table = await processTable(cfg);
        const re = new RegExp(p.name, 'i');
        const matches = table.filter(
          (r) => (re.test(r.name) || re.test(r.command)) && r.pid !== process.pid,
        );
        const killed = [];
        for (const row of matches) {
          try {
            if (IS_WIN) {
              const r = await runArgv(cfg, { file: 'taskkill', args: ['/PID', String(row.pid), '/F'], timeoutMs: 10000 });
              if (r.exitCode === 0) killed.push(row.pid);
            } else {
              process.kill(row.pid, signal);
              killed.push(row.pid);
            }
          } catch { /* gone or not permitted; reported by the count */ }
        }
        return `matched ${matches.length}, signalled ${killed.length}: ${killed.join(', ') || '(none)'}`;
      }

      const table = await processTable(cfg);

      if (action === 'info') {
        if (!p.pid) throw new Error('info needs "pid"');
        const row = table.find((r) => r.pid === Number(p.pid));
        if (!row) throw new Error(`No process with pid ${p.pid}`);
        const children = table.filter((r) => r.ppid === row.pid);
        const parent = table.find((r) => r.pid === row.ppid);
        return [
          `pid       ${row.pid}`,
          `name      ${row.name}`,
          `parent    ${row.ppid}${parent ? ` (${parent.name})` : ''}`,
          `cpu       ${row.cpu}%`,
          `memory    ${humanBytes(row.memBytes)}`,
          `running   ${row.elapsed ? duration(row.elapsed) : '(unknown)'}`,
          `children  ${children.length}${children.length ? `: ${children.map((c) => `${c.pid} ${c.name}`).join(', ')}` : ''}`,
          `command   ${row.command}`,
        ].join('\n');
      }

      if (action === 'tree') {
        const byParent = new Map();
        for (const row of table) {
          if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
          byParent.get(row.ppid).push(row);
        }
        const roots = p.pid
          ? table.filter((r) => r.pid === Number(p.pid))
          : table.filter((r) => !table.some((x) => x.pid === r.ppid));
        if (!roots.length) throw new Error(p.pid ? `No process with pid ${p.pid}` : 'No root processes found');

        const lines = [];
        const seen = new Set();
        const walkTree = (row, depth) => {
          if (seen.has(row.pid) || depth > 12) return;
          seen.add(row.pid);
          lines.push(
            `${'  '.repeat(depth)}${row.pid} ${row.name}` +
            `${row.cpu ? ` ${row.cpu}%` : ''} ${humanBytes(row.memBytes)}`,
          );
          for (const child of (byParent.get(row.pid) ?? []).sort((a, b) => a.pid - b.pid)) {
            walkTree(child, depth + 1);
          }
        };
        for (const root of roots.sort((a, b) => a.pid - b.pid)) walkTree(root, 0);
        return `${table.length} process(es)\n${truncateMiddle(lines.join('\n'), cap).text}`;
      }

      // list
      let rows = table;
      if (p.name) {
        const re = new RegExp(p.name, 'i');
        rows = rows.filter((r) => re.test(r.name) || re.test(r.command));
      }
      const sort = p.sort || 'cpu';
      if (sort === 'cpu') rows.sort((a, b) => b.cpu - a.cpu || b.memBytes - a.memBytes);
      else if (sort === 'memory') rows.sort((a, b) => b.memBytes - a.memBytes);
      else if (sort === 'pid') rows.sort((a, b) => a.pid - b.pid);
      else rows.sort((a, b) => a.name.localeCompare(b.name));

      const limit = p.limit ?? 25;
      const shown = rows.slice(0, limit);
      if (!shown.length) return p.name ? `no process matches /${p.name}/ (${table.length} running)` : 'no processes found';

      const body = shown
        .map(
          (r) =>
            `${String(r.pid).padStart(7)} ${String(r.cpu.toFixed(1)).padStart(5)}% ` +
            `${humanBytes(r.memBytes).padStart(9)} ${r.elapsed ? duration(r.elapsed).padStart(10) : '         -'} ` +
            `${r.command.slice(0, 100)}`,
        )
        .join('\n');

      return (
        `${shown.length} of ${rows.length} match(es)${p.name ? ` for /${p.name}/` : ''}, ` +
        `${table.length} total, sorted by ${sort}\n` +
        `    pid   cpu    memory    uptime command\n${truncateMiddle(body, cap).text}`
      );
    },
  };
}
