// Group: git.
//
// Everything here is reachable through shell_exec, so the reason this tool
// exists is output shaping: `git status` and `git log` are verbose, and their
// compact forms are what an agent actually needs. Anything not covered has a
// `raw` action, so the tool is never a cage.

import { runArgv } from '../exec.js';
import { resolveSafePath, assertCommandAllowed } from '../guards.js';
import { shapeOutput, truncateMiddle, ms } from '../format.js';

const READ_ACTIONS = [
  'status', 'log', 'diff', 'show', 'blame', 'branches', 'tags', 'remotes',
  'stash_list', 'file_history', 'current', 'root', 'config_get',
];
const WRITE_ACTIONS = [
  'add', 'unstage', 'commit', 'checkout', 'branch_create', 'branch_delete',
  'merge', 'rebase', 'reset', 'revert', 'restore', 'stash', 'stash_pop',
  'tag_create', 'fetch', 'pull', 'push', 'apply', 'clean', 'init',
];

export const TOOLS = [
  {
    name: 'git',
    description:
      'Run git with compact, token-cheap output. Read: status, log, diff, show, blame, branches, ' +
      'tags, remotes, stash_list, file_history, current, root, config_get. Write: add, unstage, ' +
      'commit, checkout, branch_create, branch_delete, merge, rebase, reset, revert, restore, ' +
      'stash, stash_pop, tag_create, fetch, pull, push, apply, clean, init. ' +
      'Anything else: action="raw" with args=["..."]. git runs directly, not through a shell, so ' +
      'commit messages with quotes and newlines need no escaping.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...READ_ACTIONS, ...WRITE_ACTIONS, 'raw'],
          description: 'What to do. Use "raw" with args for any git command not listed.',
        },
        cwd: { type: 'string', description: 'Repository directory. Default: server cwd.' },
        args: { type: 'array', items: { type: 'string' }, description: 'For action="raw": the full git argv, e.g. ["bisect","start"]. For other actions: extra flags appended to the command.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Files/paths the action applies to (add, diff, checkout, restore, blame, file_history, ...).' },
        message: { type: 'string', description: 'commit/tag_create/stash: the message.' },
        ref: { type: 'string', description: 'Branch, tag, commit or range — depends on the action (show, diff, checkout, merge, reset, ...).' },
        limit: { type: 'integer', description: 'log/file_history: how many commits. Default 20.' },
        stat: { type: 'boolean', description: 'diff/show/log: summarise as changed files + line counts instead of full patch. Much cheaper.' },
        staged: { type: 'boolean', description: 'diff: show the staged changes (--cached).' },
        all: { type: 'boolean', description: 'add: stage everything. commit: stage tracked changes first (-a). branches: include remotes.' },
        amend: { type: 'boolean', description: 'commit: amend the previous commit.' },
        hard: { type: 'boolean', description: 'reset: --hard (DISCARDS working tree changes) instead of --mixed.' },
        force: { type: 'boolean', description: 'push/branch_delete/clean: force the operation.' },
        remote: { type: 'string', description: 'fetch/pull/push: remote name. Default origin.' },
        patch: { type: 'string', description: 'apply: the unified diff text to apply.' },
        key: { type: 'string', description: 'config_get: the config key, e.g. user.email.' },
        timeout_ms: { type: 'integer', description: 'Kill git after this long. Network actions default to 120000.' },
        max_bytes: { type: 'integer', description: 'Byte cap on returned output.' },
      },
      required: ['action'],
    },
  },
];

const NETWORK_ACTIONS = new Set(['fetch', 'pull', 'push', 'clone']);

/** git porcelain XY status codes -> a human bucket. */
function statusBucket(x, y) {
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'conflict';
  if (x === '?' && y === '?') return 'untracked';
  if (x === '!' && y === '!') return 'ignored';
  const buckets = [];
  if (x !== ' ' && x !== '?') buckets.push('staged');
  if (y !== ' ' && y !== '?') buckets.push('unstaged');
  return buckets.join('+') || 'staged';
}

const CODE_NAMES = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange', U: 'unmerged' };

function renderStatus(stdout) {
  const lines = stdout.split('\n').filter(Boolean);
  let branch = null;
  let upstream = null;
  let ahead = 0;
  let behind = 0;
  const groups = { conflict: [], staged: [], unstaged: [], 'staged+unstaged': [], untracked: [] };

  for (const line of lines) {
    if (line.startsWith('## ')) {
      const info = line.slice(3);
      const m = /^(.+?)(?:\.\.\.(\S+))?(?:\s+\[(.+)\])?$/.exec(info);
      if (m) {
        branch = m[1];
        upstream = m[2] ?? null;
        const tracking = m[3] ?? '';
        ahead = Number((/ahead (\d+)/.exec(tracking) || [])[1] || 0);
        behind = Number((/behind (\d+)/.exec(tracking) || [])[1] || 0);
      }
      continue;
    }
    const x = line[0];
    const y = line[1];
    const path = line.slice(3);
    const bucket = statusBucket(x, y);
    if (bucket === 'ignored') continue;
    const code = (x !== ' ' && x !== '?' ? x : y);
    const label = CODE_NAMES[code] ? `${CODE_NAMES[code]}: ` : '';
    (groups[bucket] ?? groups.staged).push(`${label}${path}`);
  }

  const head = [`branch ${branch ?? '(unknown)'}`];
  if (upstream) head.push(`upstream ${upstream}`);
  if (ahead) head.push(`ahead ${ahead}`);
  if (behind) head.push(`behind ${behind}`);
  const total = Object.values(groups).reduce((n, g) => n + g.length, 0);
  head.push(total === 0 ? 'clean' : `${total} change(s)`);

  const out = [head.join(' | ')];
  const order = [
    ['conflict', 'CONFLICTS'],
    ['staged', 'staged'],
    ['staged+unstaged', 'staged + further changes'],
    ['unstaged', 'not staged'],
    ['untracked', 'untracked'],
  ];
  for (const [key, title] of order) {
    if (!groups[key].length) continue;
    out.push(`${title} (${groups[key].length}):`);
    out.push(...groups[key].map((p) => `  ${p}`));
  }
  return out.join('\n');
}

function renderLog(stdout) {
  // Fields come from a %x1f-separated pretty format, one commit per line.
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, when, author, subject, refs] = line.split('');
      const decor = refs ? ` (${refs})` : '';
      return `${hash} ${when} ${author}${decor}: ${subject}`;
    })
    .join('\n');
}

export function createHandlers({ cfg }) {
  async function git(p, args, { write = false, timeout } = {}) {
    const cwd = resolveSafePath(cfg, p.cwd ?? '.', { forWrite: write });
    // Respect the same policy gates as shell_exec: a git write IS a mutation.
    if (write) assertCommandAllowed(cfg, `git ${args.join(' ')}`);

    const run = await runArgv(cfg, {
      file: 'git',
      args,
      cwd,
      timeoutMs: p.timeout_ms ?? timeout ?? cfg.timeoutMs,
      env: { GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C' },
    });
    if (run.error) throw new Error(run.error);
    return run;
  }

  const cap = (p) => p.max_bytes ?? cfg.maxOutputBytes;

  function out(run, p, { label = null, render = null } = {}) {
    const body = render ? render(run.stdout) : shapeOutput(run.stdout, { maxBytes: cap(p), ansi: false }).text;
    const cut = truncateMiddle(body, cap(p));
    const failed = run.exitCode !== 0;
    const head = [
      label,
      failed ? `git exit=${run.exitCode}` : null,
      run.timedOut ? `TIMED_OUT after ${ms(run.durationMs)}` : null,
    ].filter(Boolean);
    const err = run.stderr.trim();
    return [
      head.length ? head.join(' ') : null,
      cut.text || (failed ? null : '(no output)'),
      failed || err ? (err ? `[git stderr] ${shapeOutput(err, { maxBytes: 2000 }).text}` : null) : null,
    ]
      .filter(Boolean)
      .join('\n');
  }

  return {
    async git(p) {
      const a = p.action;
      if (!a) throw new Error(`"action" is required. Read: ${READ_ACTIONS.join(', ')}. Write: ${WRITE_ACTIONS.join(', ')}. Or "raw".`);
      const extra = Array.isArray(p.args) ? p.args : [];
      const paths = Array.isArray(p.paths) ? p.paths : [];
      const netTimeout = NETWORK_ACTIONS.has(a) ? 120000 : undefined;

      switch (a) {
        case 'raw': {
          if (!extra.length) throw new Error('action="raw" needs args, e.g. args:["bisect","start"]');
          return out(await git(p, extra, { write: true, timeout: netTimeout }), p);
        }

        case 'status': {
          const run = await git(p, ['status', '--porcelain=v1', '--branch', ...extra]);
          if (run.exitCode !== 0) return out(run, p);
          return renderStatus(run.stdout);
        }

        case 'current': {
          const branch = await git(p, ['rev-parse', '--abbrev-ref', 'HEAD']);
          const sha = await git(p, ['rev-parse', '--short', 'HEAD']).catch(() => null);
          const dirty = await git(p, ['status', '--porcelain']);
          const changes = dirty.stdout.split('\n').filter(Boolean).length;
          return (
            `${branch.stdout.trim()} @ ${sha?.stdout.trim() ?? 'no commits yet'}` +
            ` — ${changes === 0 ? 'clean' : `${changes} uncommitted change(s)`}`
          );
        }

        case 'root':
          return (await git(p, ['rev-parse', '--show-toplevel'])).stdout.trim();

        case 'config_get': {
          if (!p.key) throw new Error('config_get needs "key", e.g. key:"user.email"');
          const run = await git(p, ['config', '--get', p.key]);
          return run.exitCode === 0 ? run.stdout.trim() : `${p.key} is not set`;
        }

        case 'log': {
          const fmt = '--pretty=format:%h%x1f%ad%x1f%an%x1f%s%x1f%D';
          const args = ['log', `-n${p.limit ?? 20}`, '--date=short', fmt];
          if (p.stat) args.push('--stat');
          if (p.ref) args.push(p.ref);
          if (paths.length) args.push('--', ...paths);
          const run = await git(p, [...args, ...extra]);
          if (run.exitCode !== 0) return out(run, p);
          return p.stat
            ? out(run, p)
            : out(run, p, { render: renderLog }) || '(no commits)';
        }

        case 'file_history': {
          if (!paths.length) throw new Error('file_history needs "paths"');
          const run = await git(p, [
            'log', `-n${p.limit ?? 20}`, '--date=short', '--follow',
            '--pretty=format:%h%x1f%ad%x1f%an%x1f%s%x1f%D', '--', ...paths,
          ]);
          return out(run, p, { render: renderLog }) || '(no history)';
        }

        case 'diff': {
          const args = ['diff'];
          if (p.staged) args.push('--cached');
          if (p.stat) args.push('--stat');
          if (p.ref) args.push(p.ref);
          if (paths.length) args.push('--', ...paths);
          const run = await git(p, [...args, ...extra]);
          if (run.exitCode !== 0) return out(run, p);
          return run.stdout.trim()
            ? out(run, p)
            : `no ${p.staged ? 'staged ' : ''}changes${paths.length ? ` in ${paths.join(', ')}` : ''}`;
        }

        case 'show': {
          const args = ['show', p.stat ? '--stat' : '--patch', p.ref || 'HEAD'];
          if (paths.length) args.push('--', ...paths);
          return out(await git(p, [...args, ...extra]), p);
        }

        case 'blame': {
          if (!paths.length) throw new Error('blame needs "paths" (one file)');
          return out(await git(p, ['blame', '--line-porcelain=0', '-c', ...extra, '--', paths[0]]), p);
        }

        case 'branches': {
          const args = ['branch', '-vv'];
          if (p.all) args.push('--all');
          return out(await git(p, [...args, ...extra]), p);
        }

        case 'tags':
          return out(await git(p, ['tag', '--sort=-creatordate', '-n1', ...extra]), p) || '(no tags)';

        case 'remotes':
          return out(await git(p, ['remote', '-v', ...extra]), p) || '(no remotes)';

        case 'stash_list':
          return out(await git(p, ['stash', 'list', ...extra]), p) || '(no stashes)';

        // ------------------------------------------------------------ writes
        case 'init':
          return out(await git(p, ['init', ...extra], { write: true }), p);

        case 'add': {
          const args = ['add'];
          if (p.all || !paths.length) args.push('-A');
          if (paths.length) args.push('--', ...paths);
          const run = await git(p, [...args, ...extra], { write: true });
          if (run.exitCode !== 0) return out(run, p);
          const st = await git(p, ['diff', '--cached', '--stat']);
          return `staged${paths.length ? ` ${paths.join(', ')}` : ' everything'}\n${st.stdout.trim() || '(nothing to stage)'}`;
        }

        case 'unstage': {
          const args = ['restore', '--staged'];
          args.push(...(paths.length ? paths : ['.']));
          return out(await git(p, [...args, ...extra], { write: true }), p, { label: 'unstaged' });
        }

        case 'commit': {
          if (!p.message && !p.amend) throw new Error('commit needs "message" (or amend:true)');
          const args = ['commit'];
          if (p.all) args.push('-a');
          if (p.amend) args.push('--amend');
          // -m with an argv array: no shell, so any message content is safe.
          if (p.message) args.push('-m', p.message);
          else if (p.amend) args.push('--no-edit');
          if (paths.length) args.push('--', ...paths);
          const run = await git(p, [...args, ...extra], { write: true });
          if (run.exitCode !== 0) return out(run, p);
          const head = await git(p, ['log', '-1', '--pretty=format:%h %s']);
          return `committed ${head.stdout.trim()}\n${shapeOutput(run.stdout, { maxBytes: 1200 }).text}`;
        }

        case 'checkout': {
          if (!p.ref && !paths.length) throw new Error('checkout needs "ref" (or "paths" to discard changes)');
          const args = ['checkout'];
          if (p.ref) args.push(p.ref);
          if (paths.length) args.push('--', ...paths);
          return out(await git(p, [...args, ...extra], { write: true }), p);
        }

        case 'branch_create': {
          if (!p.ref) throw new Error('branch_create needs "ref" (the new branch name)');
          return out(await git(p, ['checkout', '-b', p.ref, ...extra], { write: true }), p);
        }

        case 'branch_delete': {
          if (!p.ref) throw new Error('branch_delete needs "ref"');
          return out(await git(p, ['branch', p.force ? '-D' : '-d', p.ref, ...extra], { write: true }), p);
        }

        case 'restore': {
          const args = ['restore', ...(paths.length ? paths : ['.'])];
          return out(await git(p, [...args, ...extra], { write: true }), p, { label: 'restored' });
        }

        case 'reset': {
          const args = ['reset', p.hard ? '--hard' : '--mixed', p.ref || 'HEAD'];
          return out(await git(p, [...args, ...extra], { write: true }), p);
        }

        case 'revert':
          if (!p.ref) throw new Error('revert needs "ref"');
          return out(await git(p, ['revert', '--no-edit', p.ref, ...extra], { write: true }), p);

        case 'merge':
          if (!p.ref) throw new Error('merge needs "ref"');
          return out(await git(p, ['merge', '--no-edit', p.ref, ...extra], { write: true }), p);

        case 'rebase':
          if (!p.ref) throw new Error('rebase needs "ref"');
          return out(await git(p, ['rebase', p.ref, ...extra], { write: true }), p);

        case 'stash': {
          const args = ['stash', 'push'];
          if (p.message) args.push('-m', p.message);
          if (paths.length) args.push('--', ...paths);
          return out(await git(p, [...args, ...extra], { write: true }), p);
        }

        case 'stash_pop':
          return out(await git(p, ['stash', 'pop', ...(p.ref ? [p.ref] : []), ...extra], { write: true }), p);

        case 'tag_create': {
          if (!p.ref) throw new Error('tag_create needs "ref" (the tag name)');
          const args = ['tag'];
          if (p.message) args.push('-a', p.ref, '-m', p.message);
          else args.push(p.ref);
          return out(await git(p, [...args, ...extra], { write: true }), p, { label: `tagged ${p.ref}` });
        }

        case 'fetch':
          return out(await git(p, ['fetch', p.remote || 'origin', ...extra], { write: true, timeout: netTimeout }), p);

        case 'pull':
          return out(await git(p, ['pull', p.remote || 'origin', ...(p.ref ? [p.ref] : []), ...extra], { write: true, timeout: netTimeout }), p);

        case 'push': {
          const args = ['push'];
          if (p.force) args.push('--force-with-lease');
          args.push(p.remote || 'origin');
          if (p.ref) args.push(p.ref);
          return out(await git(p, [...args, ...extra], { write: true, timeout: netTimeout }), p);
        }

        case 'apply': {
          if (!p.patch) throw new Error('apply needs "patch" (unified diff text)');
          const cwd = resolveSafePath(cfg, p.cwd ?? '.', { forWrite: true });
          assertCommandAllowed(cfg, 'git apply');
          const run = await runArgv(cfg, {
            file: 'git',
            args: ['apply', '--verbose', ...extra],
            cwd,
            stdin: p.patch.endsWith('\n') ? p.patch : `${p.patch}\n`,
            timeoutMs: p.timeout_ms ?? cfg.timeoutMs,
            env: { LC_ALL: 'C' },
          });
          if (run.error) throw new Error(run.error);
          return out(run, p, { label: run.exitCode === 0 ? 'patch applied' : 'patch FAILED' });
        }

        case 'clean': {
          const args = ['clean', p.force ? '-fd' : '-nd'];
          const run = await git(p, [...args, ...extra], { write: true });
          return out(run, p, { label: p.force ? 'cleaned' : 'DRY RUN (pass force:true to delete)' });
        }

        default:
          throw new Error(
            `Unknown git action "${a}". Read: ${READ_ACTIONS.join(', ')}. ` +
            `Write: ${WRITE_ACTIONS.join(', ')}. Or "raw" with args.`,
          );
      }
    },
  };
}
