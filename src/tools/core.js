// MCP tool definitions and dispatch.
//
// Descriptions are deliberately terse: they sit in the model's context on
// every single request, so every word here is paid for repeatedly.

import process from 'node:process';
import { runCommand } from '../exec.js';
import { runBulk, renderBulk } from '../bulk.js';
import { fileRead, fileWrite, fileEdit, fsList } from '../files.js';
import { assertCommandAllowed } from '../guards.js';
import { detectAvailable, resolveShell } from '../shells.js';
import { shapeOutput, renderResult, ms } from '../format.js';

const S = {
  command: { type: 'string', description: 'Command line to run in the shell. Multi-line scripts are supported.' },
  cwd: { type: 'string', description: 'Working directory. Relative paths resolve against the server cwd. Default: server cwd.' },
  shell: { type: 'string', description: 'Override shell for this call: auto|bash|gitbash|zsh|fish|sh|cmd|powershell|pwsh|wsl, a configured name, or an absolute path.' },
  env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment variables.' },
  timeout: { type: 'integer', description: 'Kill the command (whole process tree) after this many ms. 0 = no limit.' },
  maxOut: { type: 'integer', description: 'Byte cap on returned output before middle-truncation. Lower it to save tokens.' },
};

export const CORE_TOOLS = [
  {
    name: 'shell_exec',
    description:
      'Run a shell command and wait for it to finish. Returns exit code, stdout and stderr. ' +
      'Full system access via the default shell (or the one you name). Use for anything short-lived.',
    inputSchema: {
      type: 'object',
      properties: {
        command: S.command,
        cwd: S.cwd,
        shell: S.shell,
        env: S.env,
        timeout_ms: S.timeout,
        stdin: { type: 'string', description: 'Text piped to the command on stdin.' },
        max_output_bytes: S.maxOut,
        merge_streams: { type: 'boolean', description: 'Report stderr inside stdout as one block (fewer tokens). Default false.' },
        quiet: { type: 'boolean', description: 'Return only the exit code line, no output. Default false.' },
        login: { type: 'boolean', description: 'Run through a login shell so ~/.profile aliases and PATH apply.' },
      },
      required: ['command'],
    },
  },

  {
    name: 'shell_exec_async',
    description:
      'Start a command in the background and return a job_id immediately. For long builds, dev servers, ' +
      'watchers and tailing logs. Read or stop it later with shell_job.',
    inputSchema: {
      type: 'object',
      properties: {
        command: S.command,
        cwd: S.cwd,
        shell: S.shell,
        env: S.env,
        timeout_ms: S.timeout,
        name: { type: 'string', description: 'Label for the job, to recognise it in shell_job list.' },
        interactive: { type: 'boolean', description: 'Keep stdin open so you can send input with shell_job action="write".' },
        login: { type: 'boolean', description: 'Run through a login shell.' },
      },
      required: ['command'],
    },
  },

  {
    name: 'shell_job',
    description:
      'Inspect and control background jobs. actions: list | status | output | write | kill | wait | remove. ' +
      'output/wait can block up to wait_ms until new output appears, so one call replaces a polling loop; ' +
      'pass the returned next_offset back as offset to stream without re-reading what you already saw.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'status', 'output', 'write', 'kill', 'wait', 'remove'],
          description: 'list: all jobs. status: one job without output. output: incremental output. wait: block until the job exits. write: send stdin. kill: terminate. remove: kill and forget.',
        },
        job_id: { type: 'string', description: 'Required for every action except "list".' },
        offset: { type: 'integer', description: 'Byte offset to read from (use next_offset from the previous call). Default 0.' },
        wait_ms: { type: 'integer', description: 'Block up to this long for new output / for exit. Default 0 (return at once).' },
        stream: { type: 'string', enum: ['combined', 'stdout', 'stderr'], description: 'Which stream to read. Default combined.' },
        data: { type: 'string', description: 'For action="write": text to send to stdin (add \\n yourself).' },
        signal: { type: 'string', description: 'For action="kill": SIGTERM (default), SIGKILL, SIGINT.' },
        max_output_bytes: S.maxOut,
      },
      required: ['action'],
    },
  },

  {
    name: 'shell_bulk',
    description:
      'Run MANY commands in one call, in order — the token-efficient way to work. Each step supports: ' +
      'delay_before_ms/delay_after_ms, when (condition), expect_exit, retry, on_failure, assign (capture output ' +
      'into a variable) and capture (how much output to return). Conditions and ${...} interpolation can read ' +
      'earlier steps: prev.ok, prev.exit, prev.stdout, step.<id>.ok, steps[0].exit, vars.<name>, failed_count. ' +
      'Prefer capture="on_failure" for long pipelines: silent on success, full output where it broke.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          description: 'Steps executed sequentially. A plain string is shorthand for {command: "..."}.',
          items: {
            type: 'object',
            properties: {
              command: S.command,
              id: { type: 'string', description: 'Name for this step, referenced as step.<id> in later conditions. Default s1, s2, ...' },
              cwd: S.cwd,
              shell: S.shell,
              env: S.env,
              timeout_ms: S.timeout,
              stdin: { type: 'string', description: 'Text piped to stdin (supports ${...}).' },
              delay_before_ms: { type: 'integer', description: 'Sleep this long before running the step.' },
              delay_after_ms: { type: 'integer', description: 'Sleep this long after the step.' },
              when: {
                type: 'string',
                description: 'Run only if this is true. Shorthands: always, never, prev_success, prev_failure, all_success, any_failure. Or an expression, e.g. \'prev.exit == 0 && contains(prev.stdout, "ok")\'. Functions: contains, icontains, matches, empty, len, lines, first_line, last_line, int, num, lower, upper, trim, exists.',
              },
              expect_exit: { description: 'Exit code(s) counting as success: a number, an array of numbers, or "any". Default 0.' },
              on_failure: { type: 'string', enum: ['stop', 'continue'], description: 'stop (default): abort the remaining steps. continue: keep going.' },
              retry: {
                type: 'object',
                properties: {
                  count: { type: 'integer', description: 'Extra attempts after the first failure.' },
                  delay_ms: { type: 'integer', description: 'Wait between attempts. Default 500.' },
                },
                description: 'Retry the step while it keeps failing.',
              },
              assign: { type: 'string', description: 'Store this step output in vars.<name> for later steps / ${...}.' },
              assign_from: { type: 'string', enum: ['stdout', 'stderr', 'combined', 'exit'], description: 'What assign captures. Default stdout (trimmed).' },
              capture: { type: 'string', enum: ['full', 'head', 'tail', 'on_failure', 'none'], description: 'How much of this step output to return. Default full.' },
              max_output_bytes: S.maxOut,
            },
            required: ['command'],
          },
        },
        cwd: S.cwd,
        shell: S.shell,
        env: S.env,
        timeout_ms: S.timeout,
        stop_on_failure: { type: 'boolean', description: 'Abort the run at the first failing step. Default true.' },
        capture: { type: 'string', enum: ['full', 'head', 'tail', 'on_failure', 'none'], description: 'Default capture mode for every step. Default full.' },
        max_output_bytes: S.maxOut,
        max_total_bytes: { type: 'integer', description: 'Total output budget for the whole run; later steps get suppressed once spent. Default 40000.' },
        vars: { type: 'object', additionalProperties: { type: 'string' }, description: 'Initial variables, readable as vars.<name>.' },
      },
      required: ['steps'],
    },
  },

  {
    name: 'file_read',
    description:
      'Read a file, or just the part you need: a line range (start_line/end_line, negatives count from the end), ' +
      'head_lines/tail_lines, or match="regex" to return only matching lines with optional context — far cheaper ' +
      'than reading a whole file. Output is line-numbered and middle-truncated at max_output_bytes.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, absolute or relative to the server cwd.' },
        start_line: { type: 'integer', description: '1-based first line. Negative counts back from the end.' },
        end_line: { type: 'integer', description: '1-based last line, inclusive. Negative counts back from the end.' },
        head_lines: { type: 'integer', description: 'Just the first N lines.' },
        tail_lines: { type: 'integer', description: 'Just the last N lines.' },
        match: { type: 'string', description: 'Regex: return only lines that match (grep mode).' },
        match_flags: { type: 'string', description: 'Regex flags for match, e.g. "i".' },
        ignore_case: { type: 'boolean', description: 'Shorthand for match_flags="i".' },
        context: { type: 'integer', description: 'Lines of context around each match. Default 0.' },
        max_matches: { type: 'integer', description: 'Cap on matches in grep mode. Default 200.' },
        line_numbers: { type: 'boolean', description: 'Prefix lines with numbers. Default true.' },
        max_bytes: S.maxOut,
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'base64 to read binary bytes.' },
        force_text: { type: 'boolean', description: 'Read as UTF-8 even if the file looks binary.' },
      },
      required: ['path'],
    },
  },

  {
    name: 'file_write',
    description:
      'Write a whole file. mode: overwrite (default) | append | prepend | create_new (fails if it exists). ' +
      'Creates parent directories and keeps the file existing EOL style. For a small change to a big file use file_edit.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, absolute or relative to the server cwd.' },
        content: { type: 'string', description: 'Full new content (or the chunk to append/prepend).' },
        mode: { type: 'string', enum: ['overwrite', 'append', 'prepend', 'create_new'], description: 'Default overwrite.' },
        create_dirs: { type: 'boolean', description: 'Create missing parent directories. Default true.' },
        eol: { type: 'string', enum: ['keep', 'lf', 'crlf'], description: 'Line endings. Default keep (detect from the file, else LF).' },
        ensure_trailing_newline: { type: 'boolean', description: 'End the file with a newline. Default true.' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'base64 to write binary content.' },
      },
      required: ['path', 'content'],
    },
  },

  {
    name: 'file_edit',
    description:
      'Patch parts of a file — several edits in ONE call. ops types: replace_lines, delete_lines, insert_before, ' +
      'insert_after, replace_text (exact string), regex_replace, append, prepend. Line numbers in every op refer to ' +
      'the ORIGINAL file and line ranges must not overlap, so you can plan all edits from a single file_read. ' +
      'replace_text fails unless it matches expect_count times (default 1) — pass all=true for every occurrence. ' +
      'Use dry_run=true to preview a diff first.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to patch.' },
        ops: {
          type: 'array',
          minItems: 1,
          description: 'Edits applied atomically: nothing is written unless all of them succeed.',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['replace_lines', 'delete_lines', 'insert_before', 'insert_after', 'replace_text', 'regex_replace', 'append', 'prepend'],
              },
              start_line: { type: 'integer', description: 'Line ops: 1-based first line (negative counts from the end).' },
              end_line: { type: 'integer', description: 'Line ops: 1-based last line, inclusive. Default = start_line.' },
              content: { type: 'string', description: 'Replacement / inserted / appended text.' },
              expect_match: { type: 'string', description: 'Line ops: abort unless the targeted lines contain this text — cheap protection against stale line numbers.' },
              old: { type: 'string', description: 'replace_text: exact text to find.' },
              new: { type: 'string', description: 'replace_text: replacement text.' },
              all: { type: 'boolean', description: 'replace_text: replace every occurrence.' },
              expect_count: { type: 'integer', description: 'replace_text: required number of occurrences. Default 1.' },
              pattern: { type: 'string', description: 'regex_replace: pattern.' },
              flags: { type: 'string', description: 'regex_replace: flags. Default "g".' },
              replacement: { type: 'string', description: 'regex_replace: replacement ($1 backrefs work).' },
              allow_no_match: { type: 'boolean', description: 'regex_replace: succeed even with 0 matches.' },
            },
            required: ['type'],
          },
        },
        dry_run: { type: 'boolean', description: 'Preview the diff without writing.' },
        eol: { type: 'string', enum: ['keep', 'lf', 'crlf'], description: 'Line endings. Default keep.' },
      },
      required: ['path', 'ops'],
    },
  },

  {
    name: 'fs_list',
    description:
      'List a directory (or stat one path). Recurses to "depth", filters with a glob "pattern", and skips ' +
      '.git/node_modules/dist and friends by default.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory (or file) to list. Default: server cwd.' },
        depth: { type: 'integer', description: 'Recursion depth. Default 1.' },
        pattern: { type: 'string', description: 'Glob filter on the relative path, e.g. "*.ts" or "src/**/*.js".' },
        details: { type: 'boolean', description: 'Include file sizes. Default true.' },
        show_hidden: { type: 'boolean', description: 'Include dotfiles. Default false.' },
        skip_dirs: { type: 'array', items: { type: 'string' }, description: 'Directory names not to descend into.' },
        max_entries: { type: 'integer', description: 'Cap on listed entries. Default 500.' },
        max_bytes: S.maxOut,
      },
    },
  },

  {
    name: 'shell_info',
    description:
      'Report the environment: platform, server cwd, active shell, which shells are installed, effective config ' +
      'and any active guardrails. Call this once at the start if you need to know what you are driving.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ------------------------------------------------------------------ handlers

export function createCoreHandlers({ cfg, jobs, server = null }) {
  return {
    async shell_exec(a) {
      requireString(a, 'command');
      assertCommandAllowed(cfg, a.command);
      const run = await runCommand(cfg, {
        command: a.command,
        cwd: a.cwd,
        shell: a.shell,
        env: a.env,
        timeoutMs: a.timeout_ms,
        stdin: a.stdin,
        login: a.login,
      });

      if (a.quiet) {
        return `exit=${run.exitCode === null ? 'killed' : run.exitCode} ${ms(run.durationMs)}` +
          (run.timedOut ? ' TIMED_OUT' : '') + (run.error ? ` error: ${run.error}` : '');
      }

      const limit = a.max_output_bytes ?? cfg.maxOutputBytes;
      const opts = { maxBytes: limit, ansi: cfg.keepAnsi };
      const merged = a.merge_streams === true;
      const view = {
        ...run,
        durationMs: run.durationMs,
        mergedStreams: merged,
        stdout: shapeOutput(merged ? run.combined : run.stdout, opts).text,
        stderr: merged ? '' : shapeOutput(run.stderr, opts).text,
      };
      const body = renderResult(view, { showCwd: Boolean(a.cwd) });
      return run.error ? `${body}\nspawn error: ${run.error}` : body;
    },

    async shell_exec_async(a) {
      requireString(a, 'command');
      assertCommandAllowed(cfg, a.command);
      const job = jobs.start({
        command: a.command,
        cwd: a.cwd,
        shell: a.shell,
        env: a.env,
        timeoutMs: a.timeout_ms,
        login: a.login,
        name: a.name,
        interactive: a.interactive,
      });
      // Give it a beat so an immediate spawn failure is visible right away.
      await Promise.race([job.run.done, sleep(120)]);
      const r = job.run;
      return (
        `job_id=${job.id}${job.name ? ` name=${job.name}` : ''} pid=${r.pid ?? '?'} ` +
        `${r.running ? 'RUNNING' : `EXITED exit=${r.exitCode}`} shell=${r.shellName} cwd=${r.cwd}\n` +
        `$ ${a.command}\n` +
        (r.error ? `spawn error: ${r.error}\n` : '') +
        `Read with shell_job {action:"output", job_id:"${job.id}", wait_ms:5000}`
      );
    },

    async shell_job(a) {
      const action = a.action;
      if (!action) throw new Error('action is required (list|status|output|write|kill|wait|remove)');

      if (action === 'list') {
        const list = jobs.list();
        if (!list.length) return 'No jobs.';
        return list
          .map((j) => {
            const r = j.run;
            return (
              `${j.id}${j.name ? ` (${j.name})` : ''} ` +
              `${r.running ? 'RUNNING' : `exit=${r.exitCode}`} ${ms(r.durationMs)} ` +
              `out=${r.combined.length}B pid=${r.pid ?? '?'} $ ${flat(j.run.command)}`
            );
          })
          .join('\n');
      }

      if (!a.job_id) throw new Error(`action="${action}" needs a job_id`);

      if (action === 'status') {
        const r = jobs.get(a.job_id).run;
        return (
          `${a.job_id} ${r.running ? 'RUNNING' : `EXITED exit=${r.exitCode}`}` +
          `${r.timedOut ? ' TIMED_OUT' : ''}${r.signal ? ` signal=${r.signal}` : ''} ` +
          `${ms(r.durationMs)} buffered=${r.combined.length}B` +
          `${r.droppedBytes ? ` dropped=${r.droppedBytes}B` : ''}` +
          `${r.error ? ` error: ${r.error}` : ''}`
        );
      }

      if (action === 'write') {
        const job = jobs.get(a.job_id);
        if (a.data === undefined) throw new Error('action="write" needs "data"');
        if (!job.run.running) return `${a.job_id} already exited (exit=${job.run.exitCode}); nothing written.`;
        const ok = job.run.write(a.data);
        return ok
          ? `wrote ${a.data.length} chars to ${a.job_id} stdin`
          : `${a.job_id} stdin is closed — start the job with interactive:true to keep it open.`;
      }

      if (action === 'kill') {
        const job = jobs.get(a.job_id);
        if (!job.run.running) return `${a.job_id} already exited (exit=${job.run.exitCode}).`;
        job.run.kill(a.signal || 'SIGTERM');
        await Promise.race([job.run.done, sleep(1500)]);
        return `${a.job_id} ${job.run.running ? 'kill signal sent, still running' : `terminated (exit=${job.run.exitCode})`}`;
      }

      if (action === 'remove') {
        jobs.remove(a.job_id);
        return `${a.job_id} removed.`;
      }

      // output | wait
      const waitMs = action === 'wait' ? (a.wait_ms ?? 60000) : (a.wait_ms ?? 0);
      if (action === 'wait') {
        const job = jobs.get(a.job_id);
        await Promise.race([job.run.done, sleep(waitMs)]);
      }
      const { job, text, nextOffset, stream } = await jobs.read(a.job_id, {
        offset: a.offset ?? 0,
        waitMs: action === 'wait' ? 0 : waitMs,
        stream: a.stream || 'combined',
      });
      const r = job.run;
      const shaped = shapeOutput(text, {
        maxBytes: a.max_output_bytes ?? cfg.maxOutputBytes,
        ansi: cfg.keepAnsi,
      });
      const head =
        `${job.id} ${r.running ? 'RUNNING' : `EXITED exit=${r.exitCode}`}` +
        `${r.timedOut ? ' TIMED_OUT' : ''} ${ms(r.durationMs)} ` +
        `stream=${stream} next_offset=${nextOffset}` +
        `${shaped.truncated ? ' TRUNCATED' : ''}`;
      return `${head}\n${shaped.text || '(no new output)'}`;
    },

    async shell_bulk(a) {
      const out = await runBulk(cfg, a);
      return renderBulk(out);
    },

    file_read: (a) => fileRead(cfg, a),
    file_write: (a) => fileWrite(cfg, a),
    file_edit: (a) => fileEdit(cfg, a),
    fs_list: (a) => fsList(cfg, a),

    async shell_info() {
      const active = resolveShell(cfg.shell, cfg.shells);
      const guards = [
        cfg.readOnly ? 'readOnly=true (no writes, no commands)' : null,
        cfg.allowedRoots.length ? `allowedRoots: ${cfg.allowedRoots.join(', ')}` : null,
        cfg.denyCommands.length ? `denyCommands: ${cfg.denyCommands.length} pattern(s)` : null,
        cfg.denyPaths.length ? `denyPaths: ${cfg.denyPaths.length} pattern(s)` : null,
      ].filter(Boolean);

      const live = jobs.list();
      // Report what the active tool profile costs per request, so trimming it
      // is an informed decision rather than a guess.
      const toolLine = server
        ? `tools: ${server.tools.length} in groups [${server.toolGroups.join(' ')}] ` +
          `— about ${server.toolTokens} tokens of schema per request`
        : null;
      return [
        `TerminalMCP on ${process.platform}/${process.arch}, node ${process.version}`,
        `cwd: ${cfg.cwd}`,
        `active shell: ${active.name} -> ${active.command} (mode=${active.mode}${cfg.login ? ', login' : ''})`,
        `available shells: ${detectAvailable().map((s) => s.name).join(', ') || 'none detected'}`,
        ...(Object.keys(cfg.shells).length ? [`configured shells: ${Object.keys(cfg.shells).join(', ')}`] : []),
        `defaults: timeout=${cfg.timeoutMs}ms maxOutputBytes=${cfg.maxOutputBytes} maxJobs=${cfg.maxJobs}`,
        `config file: ${cfg.configPath || '(none — using defaults)'}`,
        `guardrails: ${guards.length ? guards.join(' | ') : 'none (full access)'}`,
        `jobs: ${live.length} tracked, ${live.filter((j) => j.run.running).length} running`,
        toolLine,
      ]
        .filter(Boolean)
        .join('\n');
    },
  };
}

function requireString(a, key) {
  if (typeof a[key] !== 'string' || a[key].trim() === '') {
    throw new Error(`"${key}" is required and must be a non-empty string`);
  }
}

function flat(s) {
  const one = String(s).replace(/\s*\n\s*/g, ' ; ').trim();
  return one.length > 120 ? `${one.slice(0, 120)}...` : one;
}

const sleep = (n) => new Promise((r) => setTimeout(r, n));
