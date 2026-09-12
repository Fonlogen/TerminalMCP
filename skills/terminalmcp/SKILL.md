---
name: terminalmcp
description: Drive a machine through the TerminalMCP server — run shell commands, background long jobs, batch whole command pipelines in one call, grep and patch code, drive git and package managers, inspect processes and the network, and read or write files surgically. Use whenever tools like shell_exec, shell_bulk, search_text, git, file_edit, project_info, fs_op, sys_info, proc, http_request, json_tool or archive are available, and especially before running several commands in a row, before reading a whole file, or when orienting yourself in an unfamiliar repository.
---

# TerminalMCP

Full terminal, filesystem and system control over MCP. Up to 25 tools in ten
groups, built so a whole task fits in as few calls — and as few tokens — as
possible.

Not every group is always enabled. Call `shell_info` once if you need to know
what you have; it reports the active profile. Anything not exposed as a tool is
still reachable through `shell_exec`.

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
| Find where something is in the code | `search_text` |
| Find files by name, size or age | `search_files` |
| See part of a file | `file_read` with a range or `match` |
| See a file's shape before reading it | `code` action `outline` |
| Create or replace a whole file | `file_write` |
| Change a few lines of an existing file | `file_edit` |
| Apply a patch someone gave you | `diff` action `apply` |
| See what is in a directory | `fs_list`, or `fs_op` action `tree` |
| Copy, move, delete, chmod, hash, disk usage | `fs_op` |
| Anything git | `git` |
| Install deps, run a script, whatever the ecosystem | `pkg` |
| Orient yourself in an unfamiliar repo | `project_info` |
| Read or patch a JSON file | `json_tool` |
| Call an HTTP API | `http_request` |
| Zip/tar something, or unpack it | `archive` |
| CPU, memory, disk, env | `sys_info` |
| Processes and ports | `proc`, `net` |
| React to files changing | `watch` |
| base64, hashes, JWTs, timestamps | `encode` |
| Which OS / shell / profile am I on | `shell_info` |

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

## Starting work in an unfamiliar repository

One call, before anything else:

```
project_info {}
```

You get languages, package manager, dependencies, frameworks, scripts, entry
points, likely test/build commands, git branch and dirty state, and the config
files that exist. That replaces a dozen `ls` and `cat` calls.

Then locate code rather than reading it:

```
search_text { pattern: "createUser", context: 3 }      where is it used
code { action: "outline", path: "src/users.ts" }       what is in this file
code { action: "todos" }                               what is unfinished
```

## Finding things

`search_text` is a grep over the whole tree. It skips `.git`,
`node_modules`, build output and binaries, and honours `.gitignore` by default.

```
search_text { pattern: "TODO|FIXME" }                      regex by default
search_text { pattern: "foo(", literal: true }             no regex escaping
search_text { pattern: "useState", glob: ["*.tsx"] }       narrow by glob
search_text { pattern: "apiKey", files_only: true }        cheapest: paths only
search_text { pattern: "v1/users", count_only: true }      tallies per file
search_text { pattern: "oldName", replace: "newName", dry_run: true }
```

Order of preference by cost: `files_only` < `count_only` < normal < `context: n`.

`search_files` finds by name, size or age:

```
search_files { glob: ["**/*.test.ts"] }
search_files { min_size: 1000000, sort: "size" }        what is big
search_files { modified_within_hours: 2 }               what changed recently
```

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

`dry_run: true` shows the diff first.

For the same change across many files, use `search_text` with `replace`
instead of editing them one at a time.

## git

One tool, many actions, with output shaped down to what matters.

```
git { action: "status" }                     grouped, with ahead/behind
git { action: "log", limit: 10 }             one line per commit
git { action: "diff", stat: true }           changed files + counts, not the patch
git { action: "add" }                        stages everything
git { action: "commit", message: "..." }     quotes and newlines are safe
git { action: "branch_create", ref: "feature/x" }
git { action: "raw", args: ["bisect", "start"] }
```

git runs directly, not through a shell, so a commit message with quotes,
newlines or `$` needs no escaping. `action: "raw"` covers anything not listed.

Reads: status, log, diff, show, blame, branches, tags, remotes, stash_list,
file_history, current, root, config_get.
Writes: add, unstage, commit, checkout, branch_create, branch_delete, merge,
rebase, reset, revert, restore, stash, stash_pop, tag_create, fetch, pull,
push, apply, clean, init.

## Package managers

`pkg` detects which manager the repo really uses from its lockfile, so you do
not have to guess between npm, pnpm, yarn, bun, deno, pip, uv, poetry, pipenv,
cargo, go, composer, bundler, maven, gradle and dotnet.

```
pkg { action: "detect" }
pkg { action: "scripts" }                        what can be run
pkg { action: "run", script: "test" }
pkg { action: "add", packages: ["zod"] }
pkg { action: "add", packages: ["vitest"], dev: true }
pkg { action: "install" }
```

A dev server started with `pkg run` will not exit — use `shell_exec_async`
for that instead.

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

`watch` is the same shape for the filesystem: `start`, then `poll` with
`wait_ms`, then `stop`.

## Files, archives, JSON, data

```
fs_op { action: "copy", path: "a", to: "b", recursive: true }
fs_op { action: "delete", path: "dist", recursive: true }
fs_op { action: "tree", path: "src", depth: 3 }
fs_op { action: "disk_usage", path: "." }          what is eating space
fs_op { action: "hash", path: "dist/app.js" }

archive { action: "create", path: "out.tar.gz", from: "src" }
archive { action: "list", path: "release.zip" }
archive { action: "extract", path: "release.zip", to: "tmp" }

json_tool { action: "get", path: "package.json", json_path: "scripts.build" }
json_tool { action: "set", path: "tsconfig.json", json_path: "compilerOptions.strict", value: true }
json_tool { action: "merge", path: "package.json", value: {"scripts": {"lint": "eslint ."}} }

encode { action: "hash", path: "file.zip", algorithm: "sha256" }
encode { action: "jwt_decode", text: "<token>" }
encode { action: "base64_decode", text: "..." }
```

`json_tool` beats `file_read` + `file_write` on a JSON file: it patches one
path instead of rewriting the document, so it cannot mangle the rest.

## System and network

```
sys_info {}                                  host, cpu, memory, load, uptime
sys_info { action: "disk" }                  free space per mount
proc { action: "list", sort: "memory" }      what is using RAM
proc { action: "list", name: "node" }
proc { action: "kill", pid: 1234, tree: true }
net { action: "listening" }                  open ports and their owners
net { action: "tcp_check", host: "localhost", port: 5432 }
net { action: "dns", host: "example.com", type: "ALL" }

http_request { url: "http://localhost:3000/api/users" }
http_request { url: ".../login", method: "POST", json: {"user": "x"} }
```

`proc kill` by `name` needs `confirm: true`, because a regex can match more
than you meant; without it you get a preview of what would be killed.

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
available shells, the server cwd, the effective limits, the active tool
profile, and any guardrails the operator has configured (`readOnly`,
`allowedRoots`, `denyCommands`). If something is refused with `Policy: ...`,
that is a deliberate operator setting: report it, do not try to work around it.

## Token discipline, in short

1. `shell_bulk` over repeated `shell_exec`.
2. `project_info` once, instead of exploring a repo by hand.
3. `search_text` to locate code; never read a file to find a symbol.
4. `code outline` before reading a file you do not know.
5. `file_read` with `match`, a line range, or `tail_lines` — not whole files.
6. `file_edit` with several ops, not one call per edit.
7. `capture: "on_failure"` or `"none"` for bulk steps whose output you do not need.
8. `git diff stat: true` and `git log` instead of raw patches you will not read.
9. `quiet: true` on `shell_exec` when the exit code is the whole answer.
10. Background anything slow instead of waiting on it.

## Things that will bite you

- Each command is a **fresh shell**: `cd`, `export` and `source` do not carry
  over between steps or calls. Use `cwd`, `env`, or chain within one command
  string (`cd x && make`).
- `timeout_ms` kills the **whole process tree**, not just the top process.
- Output is middle-truncated at `max_output_bytes` — raise it if you genuinely
  need the middle of a long log, or use `file_read` with `tail_lines` on a log
  file instead.
- `search_text` skips gitignored files by default. Pass
  `respect_gitignore: false` when you are looking for something in build
  output.
- On Windows, `cmd` and PowerShell commands are run via a temp script file, so
  multi-line scripts and quotes work normally.
- `code outline` is pattern-based, not a real parser. It is for orientation;
  trust `file_read` for exact content.
