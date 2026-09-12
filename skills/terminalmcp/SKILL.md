---
name: terminalmcp
description: Drive a machine through the TerminalMCP server — run shell commands, background long jobs, batch whole command pipelines in one call, and read or patch files surgically. Use whenever the tools shell_exec, shell_bulk, shell_exec_async, shell_job, file_read, file_write, file_edit, fs_list or shell_info are available, and especially before running several commands in a row or editing a file, so the work costs one round-trip instead of many.
---

# TerminalMCP

Full terminal and filesystem control over MCP. Nine tools, built so a whole
task fits in as few calls — and as few tokens — as possible.

## The one rule

**Never send commands one at a time when you already know the sequence.**
Each MCP round-trip re-sends the conversation. Five `shell_exec` calls cost
roughly five times the tokens of one `shell_bulk` with five steps.

```
BAD:  shell_exec "cd app"  ->  shell_exec "npm ci"  ->  shell_exec "npm test"
GOOD: shell_bulk { steps: [
        { id: "deps",  command: "npm ci" },
        { id: "test",  command: "npm test" }
      ], cwd: "app" }
```

`cd` between calls is pointless anyway — each command gets a fresh shell. Use
`cwd` instead.

## Choosing a tool

| Need | Tool |
| --- | --- |
| One quick command, need the output now | `shell_exec` |
| Several commands you can plan up front | `shell_bulk` |
| Build, install, dev server, watcher, long test run | `shell_exec_async` + `shell_job` |
| See part of a file | `file_read` with a range or `match` |
| Create or replace a whole file | `file_write` |
| Change a few lines of an existing file | `file_edit` |
| See what is in a directory | `fs_list` |
| Find out which OS / shell you are driving | `shell_info` |

## shell_bulk — the workhorse

Steps run in order, in their own shell each. What each step can do:

- `id` — name it, so later steps can test `step.<id>.ok`
- `when` — run only if a condition holds
- `expect_exit` — which exit codes count as success (number, array, or `"any"`)
- `on_failure` — `"stop"` (default) or `"continue"`
- `retry: { count, delay_ms }` — for flaky commands
- `delay_before_ms` / `delay_after_ms` — wait for a service to come up
- `assign` — capture the output into `vars.<name>` for later steps
- `capture` — how much output to return: `full` (default), `head`, `tail`,
  `on_failure`, `none`

### Conditions and interpolation

`when` takes shorthands — `always`, `never`, `prev_success`, `prev_failure`,
`all_success`, `any_failure` — or an expression over earlier steps:

```
prev.ok                              the step before succeeded
prev.exit == 0
contains(prev.stdout, "0 failing")
step.build.ok && !step.lint.ok       by step id
steps[0].exit == 0                   by position
vars.branch == "main"
failed_count == 0
```

Functions: `contains`, `icontains`, `matches`, `empty`, `exists`, `len`,
`lines`, `first_line`, `last_line`, `int`, `num`, `lower`, `upper`, `trim`.
Operators: `== != > < >= <= && || !`, `=~` and `!~` for regex, plus
`and` / `or` as words.

`${...}` interpolates the same expressions into `command`, `cwd` and `stdin`:

```json
{"steps": [
  {"id": "rev", "command": "git rev-parse --short HEAD", "assign": "sha"},
  {"command": "docker build -t app:${vars.sha} .",
   "when": "prev.ok && !empty(vars.sha)"}
]}
```

Write `$${...}` when you want a literal `${...}` to reach the shell.

### Worked example: test, then deploy only if green

```json
{
  "cwd": "/srv/app",
  "stop_on_failure": false,
  "capture": "on_failure",
  "steps": [
    {"id": "deps",   "command": "npm ci"},
    {"id": "lint",   "command": "npm run lint", "on_failure": "continue"},
    {"id": "test",   "command": "npm test", "timeout_ms": 600000},
    {"id": "build",  "command": "npm run build", "when": "step.test.ok"},
    {"id": "deploy", "command": "./deploy.sh",
     "when": "step.build.ok && step.lint.ok", "retry": {"count": 2, "delay_ms": 5000}},
    {"id": "smoke",  "command": "curl -fsS localhost:8080/health",
     "when": "step.deploy.ok", "delay_before_ms": 3000, "retry": {"count": 5, "delay_ms": 2000}}
  ]
}
```

`capture: "on_failure"` is the big token win on pipelines like this: silence
while everything passes, full output exactly where it broke.

## Long-running work

Never block on a 10-minute build. Start it, then poll with one call:

```
shell_exec_async { command: "npm run build", name: "build" }   -> job_id=job1
shell_job { action: "wait",   job_id: "job1", wait_ms: 60000 } -> blocks until it exits
shell_job { action: "output", job_id: "job1", offset: 4096 }   -> only what is new
```

- `action: "output"` with `wait_ms` blocks until new output appears — that
  replaces a polling loop with a single request.
- Feed `next_offset` back as `offset` so you never re-read the same bytes.
- `interactive: true` keeps stdin open; send input with `action: "write"`.
- `action: "kill"` stops a dev server; `action: "list"` shows everything running.

## Reading files cheaply

Never read a whole large file to find one thing.

```
file_read { path, match: "function handleLogin", context: 5 }   grep mode
file_read { path, start_line: 120, end_line: 180 }              just that range
file_read { path, tail_lines: 50 }                              end of a log
file_read { path, start_line: -30 }                             last 30 lines
```

Output is line-numbered as `  12│content`, so you can plan edits straight from
it. Binary files are flagged rather than dumped; pass `encoding: "base64"` if
you really want the bytes.

## Editing files

`file_write` replaces a whole file (or appends/prepends). For a change inside
an existing file use `file_edit`, which applies **several ops in one call**:

```json
{"path": "src/app.js", "ops": [
  {"type": "replace_lines", "start_line": 42, "end_line": 45,
   "content": "  const port = 8080;", "expect_match": "const port"},
  {"type": "replace_text", "old": "DEBUG = true", "new": "DEBUG = false"},
  {"type": "insert_after", "start_line": 1, "content": "'use strict';"},
  {"type": "delete_lines", "start_line": 100, "end_line": 110}
]}
```

Three things to remember:

1. **Line numbers always refer to the original file**, and line ranges must
   not overlap. So you can plan every edit from one `file_read` without doing
   arithmetic on shifting line numbers.
2. It is **all-or-nothing** — if any op fails, the file is left untouched.
3. `replace_text` fails unless it matches exactly once. Pass `all: true` to
   replace every occurrence, or `expect_count: n` when you know there are
   several. `expect_match` on a line op does the same job for line numbers you
   may have read a while ago.

Pass `dry_run: true` to see the diff before committing to it.

## Shells

Commands run in the system default shell unless you say otherwise. Override
per call with `shell`:

```
shell: "gitbash"     Git Bash on Windows — POSIX commands on a Windows box
shell: "pwsh"        PowerShell 7
shell: "cmd"         cmd.exe
shell: "wsl"         bash inside WSL
shell: "/bin/zsh"    any absolute path
```

Call `shell_info` when you are unsure what is installed — it lists the
available shells, the server cwd, the effective limits, and any guardrails the
operator has configured (`readOnly`, `allowedRoots`, `denyCommands`). If a
command is refused with `Policy: ...`, that is a deliberate operator setting:
report it, do not try to work around it.

## Token discipline, in short

1. `shell_bulk` over repeated `shell_exec`.
2. `capture: "on_failure"` or `"none"` for steps whose output you do not need.
3. `file_read` with `match`, a line range, or `tail_lines` — not whole files.
4. `file_edit` with several ops, not one call per edit.
5. Lower `max_output_bytes` when you only need to know whether something worked.
6. `quiet: true` on `shell_exec` when the exit code is the whole answer.
7. Background anything slow instead of waiting on it.

## Things that will bite you

- Each command is a **fresh shell**: `cd`, `export` and `source` do not carry
  over between steps or calls. Use `cwd`, `env`, or chain within one command
  string (`cd x && make`).
- `timeout_ms` kills the **whole process tree**, not just the top process.
- Output is middle-truncated at `max_output_bytes` — raise it if you genuinely
  need the middle of a long log, or use `file_read` with `tail_lines` on a log
  file instead.
- On Windows, `cmd` and PowerShell commands are run via a temp script file, so
  multi-line scripts and quotes work normally.
