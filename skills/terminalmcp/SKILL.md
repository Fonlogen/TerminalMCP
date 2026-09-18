---
name: terminalmcp
description: Drive a machine through the TerminalMCP server — run shell commands, background long jobs, batch whole command pipelines in one call, grep and patch code, drive git and package managers, inspect processes and the network, read or write files surgically, keep values in server-side variables so they need not be re-sent, drive a real browser, and screenshot the screen or a window so you can see it. Use whenever tools like shell_exec, shell_bulk, search_text, git, file_edit, project_info, fs_op, sys_info, proc, http_request, json_tool, vars, browser, screen or archive are available, and especially before running several commands in a row, before reading a whole file, before reading a web page's HTML, or when orienting yourself in an unfamiliar repository.
---

# TerminalMCP

Full terminal, filesystem, browser and system control over MCP. Up to 28 tools
in thirteen groups, built so a whole task fits in as few calls — and as few
tokens — as possible.

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
| Keep a value for later without re-sending it | `vars`, or `assign` on shell_exec / http_request / bulk |
| Load a web page and act on it | `browser` |
| See what a page looks like, or what is on screen | `browser` action `screenshot`, `screen` action `shot` |
| Click or type in an app that has no CLI | `input` actions `click`, `type`, `key` — with `shot: true` |
| Look at an image file | `screen` action `view` |
| Which OS / shell / profile am I on | `shell_info` |
| Tell a person the work is done | `discord` / `telegram`, if those tools are present |
| Operate a FiveM/RedM server | `fivem`, if that tool is present |

## shell_bulk — the workhorse

Steps run in order, in their own shell each. What each step can do:

- `id` — name it, so later steps can test `step.<id>.ok`
- `when` — run only if a condition holds
- `expect_exit` — which exit codes count as success (number, array, or `"any"`)
- `on_failure` — `"stop"` (default) or `"continue"`
- `retry: { count, delay_ms }` — for flaky commands
- `delay_before_ms` / `delay_after_ms` — wait for a service to come up
- `assign` — capture the output into `vars.<name>`, for later steps AND for
  later calls (see [Server-side variables](#server-side-variables))
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

## Server-side variables

Values you capture can stay on the server. Store one, then reference it as
`${vars.<name>}` in later calls — the value itself never travels back through
the conversation.

```
shell_exec { command: "git rev-parse --short HEAD", assign: "sha" }
shell_exec { command: "docker build -t app:${vars.sha} ." }
```

The second call spends no tokens on the sha. That is the point.

### Setting and reading

```
vars { action: "set", name: "api", value: "https://api.example.com" }
vars { action: "set", name: "cfg", value: {"port": 8080, "hosts": ["a","b"]} }
vars { action: "list" }              names, types, sizes — NOT full values
vars { action: "get", name: "cfg" }  the actual value, when you need to see it
vars { action: "incr", name: "attempt" }
vars { action: "append", name: "log", text: "another line" }
vars { action: "delete", name: "sha" }
vars { action: "load", name: "conf", path: "config.json", json: true }
vars { action: "save", name: "report", path: "out.txt" }
```

`list` deliberately shows previews, not values — dumping the store would undo
the saving. Call `get` when you actually need to read one.

### Capturing without ever seeing it

Three tools write straight into the store:

```
shell_exec   { command: "...", assign: "name" }     stores trimmed stdout
http_request { url: "...", assign: "body" }         stores the response body
shell_bulk   steps: [{ ..., assign: "name" }]       stores per step
```

A `shell_bulk` `assign` is visible to later steps in the same run *and* kept
for later calls. And every step can already read the whole store, so you do not
need to pass values into a bulk run that are already there.

```json
{"steps": [
  {"id": "ver", "command": "node -p \"require('./package.json').version\"", "assign": "version"},
  {"command": "gh release create v${vars.version}", "when": "prev.ok"}
]}
```

### Where ${...} expands

In commands, `cwd`, `env` values, `stdin`, file and directory paths, URLs,
request headers, query params, git messages and refs, package names, and every
`shell_bulk` step.

**Not** in file content, regex patterns or patch bodies — a JS template
literal, a GitHub Actions workflow and a regex all legitimately contain
`${...}`, and rewriting them would be worse than making you ask.

Also available: `${env.PATH}` for the server's environment.

### It does not fight the shell

`${...}` is shell syntax too. Anything that does not name a variable this
server knows is passed through untouched, so `echo ${HOME}`,
`${PATH%%:*}` and `${#arr}` still reach bash intact. Only names it knows
get substituted.

If you reference `${vars.something}` that is not set, the text is passed
through literally and the result carries a note saying so — that is your cue
that you mistyped a name, not that the value was empty.

Write `${...}` when you want a literal `${...}` regardless.

### Secrets

```
vars { action: "set", name: "token", value: "...", secret: true }
http_request { url: "...", headers: { Authorization: "Bearer ${vars.token}" } }
```

A secret works everywhere `${vars.…}` works but is never echoed back: `list`
shows `(secret)`, `get` masks it unless you pass `reveal: true`, and it is not
written to the store file. Store a token once and use it without it reappearing
in the conversation.

### What to keep there

Good: commit shas, version strings, ids returned by an API, a base URL, a
token, a discovered path, a counter across retries, a JSON blob you will query
repeatedly.

Not: anything large. There is a per-variable size cap (1MB by default). For a
big payload, write it to a file and keep the *path* in a variable.

The store is shared across sessions and lives as long as the server process
(or longer, if the operator configured `varsFile`). `shell_info` reports how
many variables are set.

## The browser

`browser` drives a real Chromium (Chrome, Chromium, Edge, Brave). Start with
`launch`, or with `attach` if the user has a browser open on
`--remote-debugging-port` — attaching gives you their profile and their logged-in
sessions, so prefer it when the task needs an account you cannot sign into.

```
browser { action: "launch", url: "localhost:3000" }
browser { action: "attach" }               a browser already running with the flag
browser { action: "status" }               is one running, and what tabs
```

### Read a page with snapshot, not with html

This is the single most important habit here, and it is the same habit as
`search_text` over `file_read`. `snapshot` lists every element you can act on,
each with a ref:

```
browser { action: "snapshot" }

https://example.com/login  —  Sign in

e3   email     "Email"  name=user  placeholder="you@example.com"  required
e4   password  "Password"  name=pass
e5   select    "Free Pro"  name=plan  options=["free","pro"]
e6   checkbox  "Remember me"  name=remember  unchecked
e7   button    "Sign in"
```

That is a few hundred tokens. The HTML of the same page is tens of thousands.
Reach for `html` only when you actually need the markup — and then pass
`clean: true`, which strips scripts, styles and comments first. Use `text` when
you want what a reader would see.

### Act by ref

```
browser { action: "fill",  ref: "e3", text: "ada@example.com" }
browser { action: "fill",  ref: "e4", text: "hunter2", press_enter: true }
browser { action: "select", ref: "e5", label: "Pro" }
browser { action: "click", ref: "e7" }
```

Every element target accepts one of three things, in order of preference:

1. `ref` — from the last snapshot. Cheapest, and it does not break when the
   markup is restyled.
2. `selector` — a CSS selector, when you know the page.
3. `text` — find it by what it says. Ambiguity resolves to the thing you can
   act on and the innermost match, so `text: "Sign in"` picks the button rather
   than the heading that says the same words.

Refs live in the page, so **navigating or reloading invalidates them**. That is
deliberate: a stale ref tells you to snapshot again instead of silently
clicking the wrong element. After anything that changes the page, snapshot
again.

`fill` replaces a field's contents; `type` appends to them. `press_enter: true`
on either one submits most forms without a second call.

### Waiting, instead of guessing

```
browser { action: "wait", selector: ".results" }        appeared
browser { action: "wait", text: "Order confirmed" }     rendered
browser { action: "wait", selector: ".spinner", gone: true }
browser { action: "wait", until: "networkidle" }        requests settled
browser { action: "wait", ms: 500 }                     last resort
```

`navigate` already waits for the load event, so you rarely need `wait`
immediately after it.

### Seeing and diagnosing

```
browser { action: "screenshot" }                     the viewport, viewable inline
browser { action: "screenshot", full_page: true }    the whole scrolling page
browser { action: "screenshot", ref: "e7" }          just that element
browser { action: "console", level: "error" }        what the page complained about
browser { action: "network", failed: true }          what did not load
browser { action: "eval", expression: "store.getState().user" }
```

When something on a page does not behave, `console` and `network` usually
answer it in one call — much cheaper than screenshotting and squinting.

### Downloading a file

```
browser { action: "download", url: "https://site/pack.zip" }   fetch and wait
browser { action: "download", text: "Download" }               click a link or button
browser { action: "downloads" }                                what came down, and where
```

Use this rather than `http_request` whenever the file is behind a login: the
browser already holds the session, so nothing has to be re-authenticated. It
blocks until the file is written and tells you the path, so the next step can
read it straight away. A URL that turns out to be a page rather than a file
says so instead of waiting out the timeout.

`eval` takes an expression (`document.title`, `({a: 1})`) or a body with a
`return`. It awaits promises.

### Costs and courtesies

- A screenshot is billed by area, about `width × height / 750` tokens. It is
  scaled to `max_width` (1200 by default) before you see it; lower it when you
  only need the gist, and pass `view: false` when you only want the file saved.
- `snapshot` before `screenshot`. The element list is usually the answer, and
  it costs a fraction as much.
- `close` only ever closes a browser this server launched. A browser you
  attached to stays open — do not promise the user otherwise.
- Dialogs (`alert`, `confirm`) are answered automatically, and reported. If a
  click seemed to do nothing, check `console`: an unanswered dialog used to be
  the usual culprit and now the message is simply waiting for you.

## The screen

`screen` is for everything that is not a web page.

```
screen { action: "shot" }                                    the whole desktop
screen { action: "shot", mode: "display", display: "2" }     one monitor
screen { action: "shot", mode: "window", window: "Figma" }   one window by title
screen { action: "shot", mode: "region", x: 0, y: 0, width: 900, height: 240 }
screen { action: "displays" }    what monitors exist, and the coordinate space
screen { action: "windows" }     what windows are open, largest first
screen { action: "view", path: "designs/mockup.png" }   look at any image on disk
screen { action: "probe" }       whether capture can work here, and why not
```

Three things to keep in mind:

- **A full-screen capture shows everything on screen**, including windows that
  have nothing to do with the task. When you only need one thing, use
  `mode: "window"` or `mode: "region"` — it is cheaper and it is more
  considerate.
- **There may be no screen at all.** On a server, in a container or over plain
  SSH, `screen` will tell you there is no graphical session. That is not a
  fault to work around: if you need a picture of a web page, use
  `browser screenshot`, which renders headlessly and needs no display.
- **If `displays` and `windows` work but every `shot` fails, run
  `probe` before trying anything else.** On Windows that pattern means the
  server is not in the interactive desktop session — a service, a scheduled
  task or an SSH login can enumerate windows but cannot copy pixels, and no
  choice of mode will change that. `probe` names the cause (window station,
  session id, a one-pixel test capture) so you can say what the user has to
  change instead of retrying. Report it and move on; `browser screenshot`
  still works for anything that is a web page.

`view` is worth remembering for its own sake: it turns any png/jpeg/gif/webp on
disk into something you can actually look at — a screenshot from earlier in the
task, a chart a script just produced, a mockup the user pointed you at.

## Clicking and typing

When an app has no command-line way in, `input` is it. The loop is: see it, act,
see the result — and `shot: true` collapses the last two into one call.

```
screen { action: "windows" }                        what is open, and where
input  { action: "click", x: 812, y: 455, window: "Setup", shot: true }
input  { action: "type", text: "D:\Games\server" }
input  { action: "key", keys: "enter", shot: true }
input  { action: "key", keys: "w", hold_ms: 800 }   held, not tapped
```

Three things to get right:

- **Pass `window`** whenever you know which window you mean. Input goes where
  the focus is, and the focus is not always where you think — typing a password
  into the wrong window is the failure mode here, and it is not recoverable.
- **Read the coordinates from `screen`**, never guess them. `windows` gives each
  window's position and size; `shot` shows you what is inside it. Clicking a
  remembered coordinate after the window moved clicks on something else.
- **`type` for text, `key` for keys.** `type` sends characters, so accents and
  any keyboard layout work. `key` takes chords (`ctrl+s`, `alt+f4`) and
  sequences (`alt+f x`, in order).

If nothing happens in a game, that is expected rather than broken: anti-cheat
can refuse injected input, and no option changes it. Say so instead of retrying.

On macOS, if clicks do nothing while `focus` works, run `input { action:
"probe" }`. Accessibility belongs to the app that launched the server — the
terminal, the editor, the Claude app — not to node, and without it macOS drops
posted events silently rather than refusing them. The probe posts a one-pixel
move and says which of the two it is.

## Optional integrations

Some setups also expose `fivem`, `discord` or `telegram`. They are off by
default, so do not assume they exist — if one is in your tool list, it is
enabled and configured, and each has its own skill with the detail.

Two habits carry over from everything else here:

- **Blocking beats polling.** `telegram { action: "updates", wait: 60 }` and
  `discord { action: "wait", wait: 60 }` return the moment a message arrives.
  One call, not a loop.
- **Send the artefact, not a description of it.** `screen`/`browser` produce a
  screenshot; `discord upload` and `telegram send_file` put it in front of a
  person. A picture of the broken page beats a paragraph about it.

And one rule that is not about tokens: these reach other people. Sending a
message, kicking a player or restarting a game server is not undoable. Say what
you are about to do before doing it, unless you were asked to do exactly that.

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
10. `assign` a value into a server variable instead of carrying it through
    the conversation, then use `${vars.name}`.
11. `browser snapshot` to read a page; `html` only when you need the markup.
12. Lower `max_width` on a screenshot when you only need the gist — an image
    costs `width × height / 750` tokens.
13. Background anything slow instead of waiting on it.

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
- Browser refs go stale the moment the page navigates or reloads. Snapshot
  again rather than reusing them.
- `browser close` does not close a browser you attached to, only one this
  server launched.
- `screen` needs a desktop; `browser screenshot` does not. On a headless
  machine only the second one works.
- A saved JPEG screenshot is the scaled copy (JPEG cannot be resized in
  process); a saved PNG is full resolution.
