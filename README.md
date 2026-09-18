<div align="center">

# TerminalMCP

### Give your AI agent a real terminal — and stop paying for it in tokens.

A zero-dependency MCP server that hands an AI complete control of a machine —
shell, filesystem, git, package managers, processes, network, a real browser and
the screen itself — plus optional plugins for the places that work actually gets
reported: Discord, Telegram, and FiveM servers. Built so the whole thing costs a
fraction of the tokens a naive tool server burns.

[![Node](https://img.shields.io/badge/node-%E2%89%A5%2018-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-success)](package.json)
[![Tests](https://img.shields.io/badge/tests-828%20assertions-success)](test)
[![MCP](https://img.shields.io/badge/MCP-stdio%20%2B%20HTTP-635BFF)](https://modelcontextprotocol.io)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-informational)](#compatibility)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

---

```bash
git clone https://github.com/Fonlogen/TerminalMCP && cd TerminalMCP
./start.sh --doctor          # or: start.cmd --doctor  on Windows
```

No `npm install`. No build step. No dependencies. Just Node 18+.

---

## The problem this solves

Most shell MCP servers expose `run_command` and stop there. That works, and it
is ruinously expensive, because of something easy to miss:

> **Tool schemas are re-sent to the model on every single request.**

On this server's full profile that is **~11,500 tokens of JSON schema per
call**. An agent that runs five commands one at a time pays it five times —
roughly 57,000 tokens of schema, where one batched call would have spent
11,500 — plus the whole conversation, re-sent five times instead of once. The
five commands themselves were under 600 bytes.

So token efficiency here is not a nice-to-have that got bolted on. It is the
constraint the whole design answers:

| | Naive approach | TerminalMCP |
| --- | --- | --- |
| Five commands in sequence | 5 round-trips | **1** (`shell_bulk`) |
| Find a symbol in a repo | read the files | **`search_text`** returns matching lines only |
| Change 3 lines of a 2,000-line file | rewrite the file | **`file_edit`** patches 3 lines |
| Understand an unfamiliar repo | a dozen `ls` + `cat` | **1** (`project_info`) |
| Reuse a value from an earlier step | re-send it every time | **`${vars.name}`**, kept server-side |
| Find the button on a web page | read the page's HTML | **`browser snapshot`** lists what you can click |
| Tools you don't need this session | pay for them anyway | **`--tools` profiles** |

Everything else — 28 tools, two transports, cross-platform shells — exists so
the agent never has to fall back to an expensive pattern to get something done.

---

## Quick start

### 1. Check the environment

```bash
./start.sh --doctor          # Linux / macOS / Git Bash / WSL
start.cmd --doctor           # Windows
```

`--doctor` reports the platform, which shells it found, the working directory,
the active limits and what the current tool profile costs per request.

### 2. Register it with your client

```bash
node bin/terminalmcp.js --print-config
```

That prints ready-to-paste snippets with the correct absolute path. In short:

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add terminal -- node "/absolute/path/to/TerminalMCP/bin/terminalmcp.js"
```
</details>

<details>
<summary><b>Claude Desktop / Cursor</b> — <code>claude_desktop_config.json</code>, <code>.mcp.json</code></summary>

```json
{
  "mcpServers": {
    "terminal": {
      "command": "node",
      "args": ["C:\\path\\to\\TerminalMCP\\bin\\terminalmcp.js"],
      "env": { "TERMINALMCP_SHELL": "gitbash" }
    }
  }
}
```
</details>

<details>
<summary><b>VS Code</b> — <code>.vscode/mcp.json</code></summary>

```json
{
  "servers": {
    "terminal": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/TerminalMCP/bin/terminalmcp.js"]
    }
  }
}
```
</details>

### 3. Install the skill (optional, recommended)

```bash
npm run install-skill                      # → ~/.claude/skills/terminalmcp
node scripts/install-skill.mjs --project    # → ./.claude/skills/terminalmcp
```

The bundled skill teaches the model *how* to use the server cheaply — which
tool to reach for, when to batch, how to avoid reading whole files. Without it
the tools still work; with it they get used well.

---

## What this makes possible

Concrete things that are awkward or impossible with a bare `run_command`:

**Autonomous build-test-fix loops.** `shell_bulk` runs a whole pipeline with
conditions and retries in one call, so the agent plans the sequence up front
instead of narrating it step by step:

```json
{
  "cwd": "/srv/app",
  "capture": "on_failure",
  "steps": [
    { "id": "deps",  "command": "npm ci" },
    { "id": "test",  "command": "npm test", "timeout_ms": 600000 },
    { "id": "build", "command": "npm run build", "when": "step.test.ok" },
    { "id": "deploy", "command": "./deploy.sh",
      "when": "step.build.ok", "retry": { "count": 2, "delay_ms": 5000 } },
    { "id": "smoke", "command": "curl -fsS localhost:8080/health",
      "when": "step.deploy.ok", "delay_before_ms": 3000,
      "retry": { "count": 5, "delay_ms": 2000 } }
  ]
}
```

`capture: "on_failure"` means: silence while everything passes, full output
exactly where it broke.

**Running dev servers and long builds without blocking.** Start it in the
background, then read new output with a single blocking call instead of a
polling loop:

```
shell_exec_async { command: "npm run dev", name: "dev" }   → job_id=job1
shell_job { action: "output", job_id: "job1", wait_ms: 30000, offset: 4096 }
```

**Driving a remote machine.** The same server speaks HTTP, so an agent can
operate a build box, a NAS or a VPS from anywhere on your network.

**Working in repos it has never seen.** `project_info` returns languages,
package manager, dependencies, frameworks, scripts, entry points, likely
test/build commands and git state in one call.

**Carrying state between calls.** Capture a value once and reference it
forever, without it travelling back through the conversation:

```
shell_exec { command: "git rev-parse --short HEAD", assign: "sha" }
shell_exec { command: "docker build -t app:${vars.sha} ." }
```

**Using secrets without exposing them.** A variable marked `secret: true` works
everywhere `${vars.…}` works but is never echoed back — not in listings, not in
results, not in the audit log.

**Testing the web app it just changed.** It drives a real browser over the
DevTools Protocol — the same protocol Playwright is built on, with no driver to
install and no browser to download — and reads a page as a short list of things
it can act on rather than as HTML:

```
browser { action: "launch", url: "localhost:3000" }
browser { action: "snapshot" }
    e4   email     "Email"  name=user  placeholder="you@example.com"
    e5   password  "Password"  name=pass
    e8   button    "Sign in"
browser { action: "fill", ref: "e4", text: "ada@example.com" }
browser { action: "fill", ref: "e5", text: "hunter2", press_enter: true }
browser { action: "screenshot" }              it can see the result
browser { action: "console", level: "error" } and read what the page complained about
```

Or `attach` to the browser already open on the desktop — its profile, its
extensions, its logged-in sessions. No extension to install: start Chrome once
with `--remote-debugging-port=9222` and the agent can drive the session you are
already signed into.

**Seeing what is on the screen.** Desktop capture, for everything that is not a
web page — a native app, an installer, a chart in a viewer — plus `view`, which
turns any image already on disk into something the model can actually look at:

```
screen { action: "shot" }                                    the whole desktop
screen { action: "shot", mode: "window", window: "Figma" }   one window
screen { action: "shot", mode: "region", x: 0, y: 0, width: 900, height: 240 }
screen { action: "view", path: "designs/mockup.png" }
```

**Acting on what you see.** Some software has no other way in: an installer
with no silent switch, a launcher, a native dialog, a legacy admin panel. The
loop is capture, decide, act, capture again — and `shot: true` makes the last
two one call:

```
screen { action: "windows" }                                  what is open
input  { action: "click", x: 812, y: 455, window: "Setup", shot: true }
input  { action: "type", text: "D:\\Games\\server" }
input  { action: "key", keys: "enter", shot: true }
```

**Closing the loop with a person.** The work is only finished when somebody
knows about it. Optional plugins put the result where they already are — and
`wait` blocks until they answer, so asking a question costs one call rather
than a polling loop:

```
screen   { action: "shot", mode: "window", window: "Grafana" }
telegram { action: "send_file", path: ".terminalmcp/shots/…png", caption: "before the fix" }
telegram { action: "updates", wait: 120 }      blocks until they reply
```

**Running a game server.** The `fivem` plugin answers "is it up and who is on
it" with no credentials at all, then drives the rest over RCON or txAdmin —
including the F8 client console, which is where client-side script errors
actually appear:

```
fivem { action: "status" }
fivem { action: "resource", resource: "esx_ambulancejob", op: "restart" }
fivem { action: "f8", errors: true }
```

---

## The four ideas that make it different

### 1. Batching — `shell_bulk`

One call, many commands, with real control flow. Each step supports:

| Field | Effect |
| --- | --- |
| `id` | Name the step, so later steps can test `step.<id>.ok` |
| `when` | Run only if a condition holds |
| `expect_exit` | Which exit codes count as success — a number, an array, or `"any"` |
| `on_failure` | `"stop"` (default) or `"continue"` |
| `retry` | `{ count, delay_ms }` for flaky commands |
| `delay_before_ms` / `delay_after_ms` | Wait for a service to come up |
| `assign` | Capture the output into a variable, for later steps *and* later calls |
| `capture` | How much output to return: `full`, `head`, `tail`, `on_failure`, `none` |
| `cwd`, `shell`, `env`, `timeout_ms`, `stdin` | Per-step overrides |

Conditions are a real (if small) expression language, evaluated by a dedicated
parser — no `eval`, no access to arbitrary functions:

```
prev.ok                                    the step before succeeded
prev.exit == 0 && contains(prev.stdout, "0 failing")
step.build.ok && !step.lint.ok             by step id
steps[0].exit == 0                         by position
vars.branch == "main"
failed_count == 0
```

Shorthands: `always`, `never`, `prev_success`, `prev_failure`, `all_success`,
`any_failure`. Functions: `contains`, `icontains`, `matches`, `empty`,
`exists`, `len`, `lines`, `first_line`, `last_line`, `int`, `num`, `lower`,
`upper`, `trim`. Operators: `== != > < >= <= && || !`, plus `=~` / `!~` for
regex and `and` / `or` as words.

### 2. Server-side variables

Values the agent captures can stay on the server. Store once, reference as
`${vars.<name>}` in any later call — the value itself never returns to the
conversation.

```
vars { action: "set", name: "api", value: "https://api.example.com" }
vars { action: "list" }          names, types, sizes — never full values
vars { action: "get", name: "api" }
vars { action: "load", name: "conf", path: "config.json", json: true }
```

Three tools write straight into the store: `shell_exec` `assign`,
`http_request` `assign`, and per-step `assign` in `shell_bulk`.

`${...}` expands in commands, `cwd`, `env` values, `stdin`, file paths, URLs,
request headers, query params, git messages and refs, and every bulk step.
Deliberately **not** in file content, regex patterns or patch bodies — a
JavaScript template literal, a GitHub Actions workflow and a regex all
legitimately contain `${...}`, and rewriting them silently would be worse than
asking. The eligible fields are declared in a single table
([`src/tools/interpolate.js`](src/tools/interpolate.js)) rather than scattered
across handlers, so the expansion surface is auditable at a glance.

**It does not fight the shell.** `${...}` is shell syntax too. Anything that
does not name a variable the server knows is passed through untouched, so
`echo ${HOME}`, `${PATH%%:*}` and `${#arr}` reach bash intact. A
`${vars.typo}` that looks like ours but matches nothing is passed through
literally *and* reported in the result, so a mistyped name reads as a mistake
rather than becoming a silent empty string.

### 3. Tool profiles

Since schemas cost tokens on every request, you choose how many you want to
carry. Measured on this repo:

| Profile | Tools | Schema tokens per request |
| --- | --- | --- |
| `core` | 10 | ~4,800 |
| `ops` | 18 | ~8,500 |
| `dev` | 20 | ~9,200 |
| `web` | 17 | ~9,800 |
| `all` (default) | 28 | ~13,900 |

```bash
node bin/terminalmcp.js --tools core             # shell, jobs, bulk, files, vars
node bin/terminalmcp.js --tools dev              # + search, git, fs, dev, data
node bin/terminalmcp.js --tools web              # + browser, screen, net, search
node bin/terminalmcp.js --tools core,git,search  # pick groups
node bin/terminalmcp.js --tools all,-browser     # everything except one
```

`core` and `vars` are always included. `--list-tools` and `--doctor` print the
cost of every group, and `shell_info` reports it to the model at runtime — so
trimming is an informed decision rather than a guess. Nothing is ever lost:
whatever isn't exposed as a tool is still reachable through `shell_exec`.

### 4. Reading a web page without reading its HTML

Handing a model 400KB of markup to find a login button is the browser
equivalent of `cat`-ing a whole file to find one function. So the primary way
to read a page is `snapshot`: every element you can actually act on, named the
way a person would name it, each with a short ref.

```
browser { action: "snapshot" }

https://example.com/login  —  Example — Sign in

e1   h1         "Sign in to Example"
e2   link       "Forgot your password?"  -> /reset
e3   email      "Email"  name=user  placeholder="you@example.com"  required
e4   password   "Password"  name=pass
e5   select     "Free Pro"  name=plan  options=["free","pro"]
e6   checkbox   "Remember me"  name=remember  unchecked
e7   button     "Sign in"
```

Then `click { ref: "e7" }`. A few hundred tokens for a page instead of tens of
thousands — and it survives a redesign of the markup, which a hand-written CSS
selector does not. Refs live in the page itself, so navigating away invalidates
them and a stale ref says so rather than quietly clicking the wrong thing.

`html` is still there for when you genuinely need the markup, with
`clean: true` to drop scripts, styles and comments first.

The same logic applies to images. A vision model is billed by area — roughly
`width × height / 750` tokens — so a raw 4K screenshot is about 11,000 tokens
and the same screenshot at 1200px wide is about 1,100 and just as readable.
Every capture is therefore scaled to `max_width` (1200 by default) before it is
returned, and the reply tells you what that cost:

```
viewport of http://localhost:3000/
saved .terminalmcp/shots/2026-04-11_18-22-03.png (184320 bytes, 1280x800)
1280x800 scaled to 1200x750, ~1200 image tokens
```

---

## Tool reference

28 tools in 13 groups. Most use an `action` parameter rather than one tool per
verb — `git` alone would otherwise be twenty tools, and `browser` thirty.

### `core` — always on

| Tool | Purpose |
| --- | --- |
| `shell_exec` | Run a command and wait. Exit code, stdout, stderr. |
| `shell_exec_async` | Start a command in the background, return a `job_id`. |
| `shell_job` | `list`, `status`, `output`, `wait`, `write`, `kill`, `remove`. |
| `shell_bulk` | Many commands in one call, with delays, conditions, retries, variables. |
| `file_read` | Whole file, a line range, the tail, or only lines matching a regex. |
| `file_write` | `overwrite`, `append`, `prepend`, `create_new`. |
| `file_edit` | Several surgical edits in one atomic call. |
| `fs_list` | Directory listing with depth and glob filter. |
| `shell_info` | Platform, shells, config, guardrails, active profile. |

### `vars` — always on

| Tool | Purpose |
| --- | --- |
| `vars` | `set`, `get`, `list`, `delete`, `clear`, `append`, `incr`, `load`, `save`. |

### `search`

| Tool | Purpose |
| --- | --- |
| `search_text` | Grep a whole tree: regex or literal, matching lines with optional context. Skips `.git`, `node_modules`, build output and binaries; honours `.gitignore`. `files_only` and `count_only` cost even less. With `replace`, a project-wide find-and-replace (`dry_run` shows a diff first). |
| `search_files` | Find files and directories by glob, name, size or age. Sort by path, size or mtime. |

### `git`

One tool, ~30 actions, compact output, plus `action: "raw"` for anything not
covered.

**Read:** `status`, `log`, `diff`, `show`, `blame`, `branches`, `tags`,
`remotes`, `stash_list`, `file_history`, `current`, `root`, `config_get`
**Write:** `add`, `unstage`, `commit`, `checkout`, `branch_create`,
`branch_delete`, `merge`, `rebase`, `reset`, `revert`, `restore`, `stash`,
`stash_pop`, `tag_create`, `fetch`, `pull`, `push`, `apply`, `clean`, `init`

git is invoked directly rather than through a shell, so a commit message
containing quotes, newlines or `$` needs no escaping.

### `fs`

| Tool | Purpose |
| --- | --- |
| `fs_op` | `copy`, `move`, `delete`, `mkdir`, `touch`, `stat`, `chmod`, `symlink`, `readlink`, `hash` (md5/sha1/sha256/sha512), `disk_usage` (what's eating space), `tree`. `delete` refuses a non-empty directory without `recursive: true`. |

### `archive`

| Tool | Purpose |
| --- | --- |
| `archive` | `create`, `list`, `extract`, `gzip`, `gunzip` for zip, tar, tar.gz and gzip. ZIP and TAR are implemented in-process (Node ships only zlib), so archives behave identically everywhere with no `tar`/`zip` binary required. Extraction refuses entries whose path escapes the destination. |

### `sys`

| Tool | Purpose |
| --- | --- |
| `sys_info` | `overview`, `cpu`, `memory`, `disk` (free space per mount), `network`, `env`, `uptime`, `user`. |
| `proc` | `list` (filter by name, sort by cpu/memory), `tree`, `info`, `kill` (by pid, optionally with children, or by name — which requires `confirm: true`). |

### `net`

| Tool | Purpose |
| --- | --- |
| `http_request` | HTTP(S) client: status, timing, headers, body. JSON is pretty-printed, long bodies truncated. `json`, `form`, `query`, `insecure`, `headers_only`, `assign`. |
| `net` | `dns` (A/AAAA/MX/TXT/CNAME/NS/PTR/ALL), `tcp_check`, `listening` (open ports and which pid owns them), `interfaces`, `ping`. |

### `dev`

| Tool | Purpose |
| --- | --- |
| `pkg` | Drive whichever package manager the project actually uses, detected from its lockfile: npm, pnpm, yarn, bun, deno, pip, uv, poetry, pipenv, cargo, go, composer, bundler, maven, gradle, dotnet. Actions: `detect`, `install`, `add`, `remove`, `run`, `scripts`, `list`, `outdated`. |
| `project_info` | Orient yourself in an unfamiliar repository in one call. |
| `code` | `outline` (functions, classes and types with line numbers — read this *before* the file), `imports`, `todos`, `stats` (lines of code by language). |

### `data`

| Tool | Purpose |
| --- | --- |
| `json_tool` | `get`, `set`, `delete`, `merge` (deep), `keys`, `validate`, `format` on a JSON file or inline text. Paths look like `scripts.build` or `items[0].name`. Patches one path instead of rewriting the document. |
| `diff` | `files` (unified diff between two files), `text`, `apply` (hunks are located by context, so a patch still applies after unrelated edits shifted the file). |
| `encode` | base64 / hex / url / html encode and decode, `hash`, `uuid`, `random`, `jwt_decode` (signature **not** verified), `timestamp`. |

### `watch`

| Tool | Purpose |
| --- | --- |
| `watch` | `start` returns a `watch_id`; `poll` blocks up to `wait_ms` for changes (one call instead of a polling loop); `list`, `stop`. Events are coalesced per path, so one save reads as one change. |

### `browser`

One tool, thirty actions, driving Chrome / Chromium / Edge / Brave over the
DevTools Protocol.

| Group | Actions |
| --- | --- |
| Lifecycle | `launch` (headless or windowed), `attach` to a browser started with `--remote-debugging-port`, `status`, `close` |
| Tabs | `tabs`, `tab_new`, `tab_select`, `tab_close` |
| Navigation | `navigate`, `back`, `forward`, `reload`, `resize` |
| Reading | `snapshot` (the cheap element map), `html` (with `clean`), `text`, `eval` |
| Interaction | `click`, `type`, `fill`, `press`, `hover`, `scroll`, `select` |
| Waiting | `wait` for a selector, text, its disappearance, a lifecycle state, network idle, or just a delay |
| Capture | `screenshot` (viewport, `full_page`, or one element — returned inline so the model can see it), `pdf` |
| Files | `download` (a URL, or a link/button to click) waits for the file and reports where it landed; `downloads` lists them |
| State | `cookies`, `cookie_set`, `cookies_clear` |
| Diagnostics | `console` (filterable by level), `network` (filterable by URL, or `failed: true` for just the problems) |

Every element target accepts one of three things: `ref` from the last snapshot
(cheapest and sturdiest), `selector` for a CSS selector, or `text` to find an
element by what it says. Ambiguous text prefers the thing you can act on and
the innermost match, so `text: "Sign in"` picks the button rather than the
heading above it that says the same words.

#### Downloads

A download is the one thing a browser does that produces no page, which is why
it used to look broken: navigating to a file URL aborts its own navigation —
Chromium hands the bytes to the download manager and no document is ever
committed — so `navigate` reported a failure while the file was, in fact,
arriving.

```
browser { action: "download", url: "https://example.com/pack.zip" }
browser { action: "download", text: "Download release" }     a link or button
browser { action: "download" }                    just wait for what the page started
browser { action: "downloads", wait: true }
```

`download` blocks until the file is on disk and answers with its real name,
its size and its path. The point is the session: a file behind a login comes
down with the cookies the browser already has, which is the whole reason not to
reach for `http_request`. `navigate` now recognises a download too, instead of
reporting a navigation failure.

Files land in `.terminalmcp/downloads` (configurable with `browser.downloadDir`),
named by what the server suggested — sanitised, because a `Content-Disposition`
filename is attacker-controlled input, and never overwriting: a second
`pack.zip` becomes `pack (2).zip`.

Browsers are found automatically: the usual install locations per platform,
then `$CHROME_PATH`, then a Playwright or Puppeteer cache if you already have
one on disk. Nothing is downloaded.

### `screen`

| Tool | Purpose |
| --- | --- |
| `screen` | `shot` captures the whole desktop, one monitor (`mode: "display"`), one window matched on its title (`mode: "window"`), or an exact rectangle (`mode: "region"`). `view` shows any image file on disk — png, jpeg, gif, webp — so the model can look at a screenshot from ten minutes ago or a mockup someone dropped in a folder. `displays` and `windows` list what there is to capture. `probe` says whether capture can work here at all, and why not. |

Captures are saved at full resolution and shown scaled to `max_width`, so the
file on disk stays the good copy while the reply stays cheap.

#### When every shot fails but `displays` and `windows` work

That combination is not a broken tool — it is the signature of a process that
can see the desktop's furniture but not its pixels. Enumerating monitors and
windows works from any session; copying pixels needs the **interactive
desktop**, which a Windows service, a scheduled task, session 0 and an
SSH/WinRM login do not have.

```
screen { action: "probe" }
```

reports the window station (only `WinSta0` can capture), the Windows session
id, the PowerShell version, and the result of a one-pixel test capture with the
exact exception — then tries a real 8×8 capture end to end. The fix is almost
always to start the server from a terminal inside your own logged-in session.

### `input`

| Tool | Purpose |
| --- | --- |
| `input` | `move` (absolute or by an offset), `click` (any button, any count), `drag`, `scroll`, `type` (real characters, so accents and any layout work), `key` (chords and sequences, with `hold_ms` for software that needs the key held), `position`, `focus` a window by title, and `probe`. |

Two things make it usable rather than merely present:

- **`shot: true`** returns a screenshot taken straight after the action, so one
  call both acts and shows the result. Acting blind and then capturing is two
  calls and a race.
- **`window`** raises that window first. Input follows the focus, and the
  window that had focus is not always the one you meant — this is the
  difference between typing a path into an installer and typing it into
  somebody's chat.

```
input { action: "key", keys: "ctrl+shift+esc" }      a chord
input { action: "key", keys: "alt+f x" }             a sequence, in order
input { action: "key", keys: "w", hold_ms: 800 }     held down, not tapped
input { action: "type", text: "città" }              characters, not keystrokes
input { action: "drag", x: 100, y: 100, to_x: 400, to_y: 300 }
```

`readOnly` blocks all of it. `position` and `probe` still answer.

#### What "HID" does and does not mean here

Input is synthesised by the operating system — `SendInput` on Windows,
`xdotool` on X11, `osascript` or `cliclick` on macOS. Applications receive
those events through the same path as real ones and cannot tell the difference.

What they are not is *physical*. Software that reads raw HID and deliberately
checks — which is what anti-cheat does — can refuse injected input, and no
setting changes that. A game that ignores this needs a microcontroller
presenting itself as a real USB keyboard, which is a different backend and not
a flag. Everything that is not actively looking for injection works.

Wayland refuses input injection by design; there `ydotool` (pointer, via
`/dev/uinput`) and `wtype` (keyboard) are the way through, and `probe` says
which of them is installed. An X11 session needs only `xdotool`.

Every failure the Windows side can hit comes back named rather than as a
generic "capture failed": no interactive desktop, a temp directory that cannot
be written, a `pwsh` install without the Windows Desktop runtime, a minimized
window (pass `activate: true`), a title that matches nothing. And a web page
never needs a desktop at all — `browser screenshot` renders headlessly,
including the full scrolling page.

---

## Optional plugins

Three integrations ship with the server and **none of them are on by default**.
That is the same logic as tool profiles: a schema in the model's context costs
tokens on every single request, and most sessions have no business talking to
Discord.

```bash
node bin/terminalmcp.js --plugin discord
node bin/terminalmcp.js --plugin fivem --plugin telegram
```

or in the config file:

```json
{ "plugins": ["fivem", "telegram"] }
```

A plugin is never part of `all` — naming it is what enables it. Once loaded it
behaves like any other group, so `--tools all,-telegram` still removes it, and
`--doctor` reports whether it is actually configured:

```
plugins
  fivem     server 10.0.0.5:30120, rcon password set, txAdmin http://10.0.0.5:40120 (env token)
  telegram  token set (…4f2a), default chat -1001234567890
```

### Credentials

Secrets never have to live in the config file. Any string value may be written
`"env:NAME"` and is read from that environment variable instead:

```json
{
  "plugins": ["telegram"],
  "pluginConfig": {
    "telegram": { "token": "env:TELEGRAM_BOT_TOKEN", "defaultChat": "-1001234567890" }
  }
}
```

An unset variable is reported as *not configured*, with instructions — not as a
mysterious 401 three calls later.

Every plugin registers its secrets with a redactor, and everything it returns
passes through it. This matters more than it sounds: the Telegram Bot API puts
the token **in the URL**, so a naive error message publishes it to the
transcript and the audit log. Here it comes back as `<redacted>`, and there is a
test that fails if it ever does not.

### `fivem` — FiveM / RedM servers

Four different things get called "the console", and the plugin is explicit
about which is which.

| Action | What it uses |
| --- | --- |
| `status`, `players`, `resources` | The public `/info.json`, `/players.json`, `/dynamic.json`. **No credentials at all.** |
| `rcon`, `resource`, `say`, `kick` | RCON — the Quake-style UDP protocol, implemented here by hand. Needs `rcon_password` in `server.cfg`. |
| `f8` | The game client's `CitizenFX.log`, which is where client-side `SCRIPT ERROR` lines land. |
| `f8_exec`, `client_lua`, `server_lua` | The optional bridge resource (below). |
| `tx_status`, `tx_control`, `tx_announce`, `tx_log` | txAdmin. |

Two honest notes rather than marketing:

- **If TerminalMCP started the FXServer, don't use RCON.** `shell_exec_async` +
  `shell_job` gives you its real stdout and stdin — nothing to lose to a
  dropped datagram, and you can type into it. The plugin says so in its own
  error messages.
- **Only `/host/status` is a documented txAdmin API.** The other `tx_*` actions
  drive txAdmin's own panel interface, which can change between versions. They
  work, they are tested against the shapes txAdmin's source actually uses, and
  they will tell you plainly when a version has moved underneath them.

**Typing into a player's F8 console** is not something any remote protocol can
do — so an optional in-game resource ships in
[`plugins/fivem/resource/`](plugins/fivem/resource/). Install it and `f8_exec`
runs a command in a chosen player's console for real, while `client_lua` and
`server_lua` evaluate Lua and hand back the value:

```
fivem { action: "client_lua", player: "3", lua: "GetEntityCoords(PlayerPedId())" }
```

Read [its README](plugins/fivem/resource/README.md) before installing it. It
grants arbitrary Lua execution on your server and on connected clients to
whoever holds its secret. That is the feature, and it is not for every server.

One thing to know because it is the easiest way to lose an afternoon: FiveM
routes an HTTP request to a resource by the **first path segment, which is the
resource's folder name** — not the `name` in `fxmanifest.lua`. If you install
the bridge under a different folder name, set `bridge.resource` to it.
`fivem { action: "bridge" }` reads the server's own resource list when it
cannot connect, and tells you which name to use.

### `discord`

Works with a bot token, a webhook URL, or both. A webhook needs no application
and no permissions but can only post; a bot can read, edit, react and list.

```
discord { action: "send", text: "Deploy finished: 3 services updated" }
discord { action: "upload", path: "build.log", caption: "the failure" }
discord { action: "read", limit: 20 }
discord { action: "wait", wait: 60 }          blocks until someone replies
```

`@everyone` and role pings are **suppressed unless you pass `mentions: true`**.
A tool that can ping four thousand people by accident is a bad tool.

Rate limits are handled: a 429 is answered by waiting exactly as long as
Discord asks, once.

### `telegram`

```
telegram { action: "send", text: "Backup finished, 4.2GB in 6m12s" }
telegram { action: "send_file", path: "shot.png", caption: "the dashboard" }
telegram { action: "updates", wait: 60 }
```

`updates` uses Telegram's own long polling, so it returns the instant a message
arrives rather than on a timer, and the read offset is kept server-side — each
message reaches you exactly once.

### Writing your own

A plugin is an ES module exporting `TOOLS` and `createHandlers` — the same
shape as [`src/tools/*.js`](src/tools). There is no plugin API to learn beyond
that. Point at it by path:

```json
{ "plugins": ["./my-plugins/jira.js"] }
```

Two extras are worth declaring. `MUTATING_ACTIONS` lists the actions that
change something outside this machine, and `readOnly` then refuses them
centrally rather than in each handler. `describe()` returns the one line
`--doctor` prints, so "is this thing configured" is answerable without making a
call.

A plugin that fails to load is reported on stderr and skipped. It never stops
the server — everything else on the machine still works.

---

## Transports

### stdio (local, default)

The normal way to run an MCP server. Your client spawns the process and talks
over stdin/stdout.

### HTTP (remote)

The same server can run as a network service. **There is no authentication** —
see [Security](#security) before exposing it.

```bash
./start-http.sh                  # 0.0.0.0:8787, reachable from other machines
start-http.cmd                   # same, on Windows
PORT=9000 ./start-http.sh

./start.sh --http                # local only (127.0.0.1:8787)
node bin/terminalmcp.js --http --host 0.0.0.0 --port 8787
```

Both MCP HTTP transports are served at once, so current and older clients work
against the same port:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/mcp` | **Streamable HTTP** (MCP 2025-03-26 / 2025-06-18) |
| `GET` | `/mcp` | SSE stream for server-initiated messages |
| `DELETE` | `/mcp` | End the session |
| `GET` | `/sse` | **Legacy HTTP+SSE** (MCP 2024-11-05) handshake |
| `POST` | `/messages?sessionId=…` | Legacy message channel |
| `GET` | `/health` or `/` | Status, tools, sessions, running jobs, as JSON |

```bash
claude mcp add --transport http terminal http://<ip>:8787/mcp
curl http://<ip>:8787/health
node bin/terminalmcp.js --print-config --http --host 0.0.0.0
```

**Sessions.** `initialize` issues an `Mcp-Session-Id`, returned as a header and
echoed back by the client. Each session keeps its own negotiated protocol
version, so clients on different MCP revisions can talk to one server
simultaneously. Idle sessions expire after 30 minutes. By default an unknown
session id is still served rather than 404'd — nothing here is authenticated,
so strictness would only break clients that forget the header; `--strict-sessions`
turns that on.

**Shared state, deliberately.** Jobs and variables are shared across sessions,
because this server drives *one machine*: a job started by one client stays
readable from another, and from the same client after a reconnect.

**Long commands.** HTTP-level timeouts are disabled, so a ten-minute command
isn't cut off. Behind a reverse proxy that closes idle responses, add
`--sse-replies` for keepalive comments — though `shell_exec_async` plus
`shell_job` is the better answer regardless.

---

## Configuration

Precedence, strongest first: **per-call parameters → `TERMINALMCP_*` environment
variables → config file → defaults.**

The config file is looked up in this order:

1. `$TERMINALMCP_CONFIG`
2. `./terminalmcp.config.json`
3. `./.terminalmcp.json`
4. `~/.terminalmcp/config.json`

```bash
cp terminalmcp.config.example.json terminalmcp.config.json
```

`//` comments and trailing commas are tolerated.

### Choosing a shell

`"auto"` picks the system default: `pwsh` → `powershell` → `cmd` on Windows,
`$SHELL` then `bash` → `zsh` → `sh` elsewhere.

| Value | Shell |
| --- | --- |
| `"bash"` | Bash (finds Git Bash on Windows) |
| `"gitbash"` | Git Bash, Windows only |
| `"zsh"`, `"fish"`, `"sh"` | The respective POSIX shells |
| `"cmd"` | `cmd.exe` |
| `"powershell"` | Windows PowerShell 5.x |
| `"pwsh"` | PowerShell 7+ |
| `"wsl"` | bash inside WSL |
| `"C:/Program Files/Git/bin/bash.exe"` | any absolute path |

Custom shells can be named and then selected per call:

```json
{
  "shells": {
    "docker": { "command": "docker", "args": ["exec", "-i", "web", "sh", "-c"] }
  }
}
```

On Windows, `cmd` and PowerShell commands run via a temporary script file, so
multi-line scripts and quoting behave the way you expect.

### Main options

| Field | Default | Meaning |
| --- | --- | --- |
| `shell` | `"auto"` | Shell to use. |
| `login` | `false` | Use a login shell (`-lc`) so `~/.profile` aliases and PATH apply. |
| `cwd` | start dir | Default working directory. |
| `timeoutMs` | `120000` | Per-command timeout. Kills the **whole process tree**. `0` = unlimited. |
| `maxOutputBytes` | `16000` | Byte cap per returned stream (~4 bytes per token). |
| `maxBufferBytes` | `8388608` | In-memory buffer per stream for background jobs. |
| `env` | `{}` | Environment variables injected into every command. |
| `keepAnsi` | `false` | Keep ANSI colour codes (they cost tokens). |
| `maxJobs` | `32` | Concurrent background jobs. |
| `jobRetentionMs` | `1800000` | How long finished jobs stay readable. |
| `tools` | `"all"` | Tool profile — see [Tool profiles](#3-tool-profiles). |
| `plugins` | `[]` | Optional plugins to load — see [Optional plugins](#optional-plugins). Never implied by `all`. |
| `pluginConfig` | `{}` | Per-plugin settings, keyed by name. `"env:NAME"` reads a value from the environment. |
| `varsFile` | `null` | Mirror the variable store to this file so it survives a restart. |
| `persistSecrets` | `false` | Also write `secret` variables to that file. |
| `maxVars` / `maxVarBytes` / `maxVarsTotalBytes` | `200` / `1MB` / `8MB` | Variable store limits. |
| `browser.executable` | `null` | Path to a Chromium-family binary. `null` = auto-detect. |
| `browser.headless` | `true` | `false` opens a real window, which is what you want when a human is watching. |
| `browser.userDataDir` | `null` | Profile directory, so logins survive between runs. `null` = a throwaway temp profile. |
| `browser.viewport` | `1280x800` | Window and viewport size for browsers we launch. |
| `browser.dialogs` | `"accept"` | What to do with `alert()` / `confirm()`. An unanswered dialog freezes the page, so one of them has to happen. |
| `browser.downloadDir` | `null` | Where the browser puts downloads, so the file tools can find them. `null` = `<cwd>/.terminalmcp/downloads`. |
| `browser.args` | `[]` | Extra browser command-line flags. |
| `screenshots.dir` | `null` | Where captures are saved. `null` = `<cwd>/.terminalmcp/shots`. |
| `screenshots.maxWidth` | `1200` | Scale images to this width before returning them. The real token dial. |
| `screenshots.maxImageBytes` | `5242880` | Refuse to return an image larger than this. |

### Command-line options

```bash
node bin/terminalmcp.js --help
```

`--cwd`, `--shell`, `--config`, `--timeout-ms`, `--max-output-bytes`,
`--login`, `--tools`, `--vars-file`, `--persist-secrets`, `--max-vars`,
`--max-var-bytes`, `--read-only`, `--allowed-root`, `--log-file`.

Browser and screen: `--browser-path`, `--no-headless`, `--shots-dir`,
`--max-image-width`.

Plugins: `--plugin <name|path>`, repeatable.

HTTP: `--http`, `--host`, `--port`, `--path`, `--no-cors`, `--strict-sessions`,
`--sse-replies`, `--max-body-bytes`.

Commands: `--doctor`, `--print-config`, `--list-tools`, `--help`, `--version`.

### Environment variables

`TERMINALMCP_SHELL`, `TERMINALMCP_CWD`, `TERMINALMCP_TIMEOUT_MS`,
`TERMINALMCP_MAX_OUTPUT_BYTES`, `TERMINALMCP_LOGIN`, `TERMINALMCP_KEEP_ANSI`,
`TERMINALMCP_READ_ONLY`, `TERMINALMCP_LOG_FILE`, `TERMINALMCP_ALLOWED_ROOTS`,
`TERMINALMCP_CONFIG`, `TERMINALMCP_TOOLS`, `TERMINALMCP_VARS_FILE`,
`TERMINALMCP_BROWSER_PATH`, `TERMINALMCP_BROWSER_HEADLESS`,
`TERMINALMCP_SHOTS_DIR`, `TERMINALMCP_PLUGINS`, `TERMINALMCP_HTTP`,
`TERMINALMCP_HTTP_HOST`, `TERMINALMCP_HTTP_PORT`, `TERMINALMCP_HTTP_PATH`,
`TERMINALMCP_HTTP_CORS`.

Plugins also read their own conventional variables when the config says so:
`TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `DISCORD_WEBHOOK_URL`,
`FIVEM_RCON_PASSWORD`, `TXADMIN_PASSWORD`, `TXHOST_API_TOKEN`,
`FIVEM_BRIDGE_SECRET`.

---

## Security

**Be clear-eyed about what this is.** TerminalMCP gives an AI the same
privileges as the user account running it. There is no sandbox, and that is
the point — a sandboxed terminal cannot install a dependency, restart a
service or read a log. Run it where you would be comfortable handing someone a
shell.

### Network exposure

The library default binds `127.0.0.1`, because opening up should be a
deliberate act. `start-http.sh` / `start-http.cmd` bind `0.0.0.0` — they exist
for remote use — and the server says so loudly at startup.

**There is no authentication, so the port is the credential.** Two cheap
measures that change a lot:

- Keep it off the public internet. A LAN, a VPN (Tailscale, WireGuard) or an
  SSH tunnel is enough: `ssh -L 8787:127.0.0.1:8787 user@host`, then point the
  client at `http://127.0.0.1:8787/mcp` while the server stays bound to
  localhost.
- On an untrusted network, put a reverse proxy (Caddy, nginx) in front with TLS
  and Basic Auth. The server neither knows nor cares.

### The browser and the screen deserve their own thought

Two of the newer capabilities reach further than a shell does, and it is worth
knowing exactly how far.

- **`browser attach` inherits a real session.** Attaching to a browser you
  started with `--remote-debugging-port` gives the agent that browser's
  profile: your cookies, your logged-in accounts, your extensions. It can act
  as you on every site you are signed into. That is precisely why the feature
  is useful, and precisely why `attach` should be a decision you make rather
  than a default. `launch` is the safer sibling — a throwaway profile that is
  signed into nothing.
- **A screenshot captures whatever is on the screen**, including windows that
  have nothing to do with the task: a password manager, somebody else's chat, a
  medical record. `mode: "region"` and `mode: "window"` exist so a capture can
  be narrow on purpose.
- `readOnly` blocks `browser launch` (it starts a process) and blocks writing
  captures to disk, but it cannot police what a page does once it is open.
- macOS will ask for permission the first time: Screen Recording for captures,
  Accessibility for listing windows. Nothing can be captured until you grant
  it, and the error says so rather than returning a black image.
- The `screen` tool needs a desktop, and on Windows specifically the
  *interactive* one: a service or an SSH login can list windows but not copy
  pixels. `screen { action: "probe" }` says which case you are in. On a server,
  in a container or over plain SSH there is nothing to capture, and it says so —
  browser screenshots still work there, because they render headlessly.

### Plugins reach outside the machine

A shell command affects this computer. Sending a Discord message, kicking a
player or restarting a game server affects other people, and cannot be undone
by deleting a file.

- Each plugin declares which of its actions mutate, and **`readOnly` refuses
  exactly those** while leaving the read-only ones working. So `--read-only`
  gives you a server that can look at your Discord, your Telegram and your game
  server without being able to say or break anything.
- `allowedChannels`, `allowedChats` and the FiveM `allowCommands` /
  `denyCommands` lists narrow what is reachable at all. A refusal is reported
  as `Policy: …` so the model knows it was a deliberate setting rather than a
  bug to route around.
- Discord pings are suppressed unless explicitly allowed.
- Plugin secrets are registered with a redactor and scrubbed from every result
  and every error, including the audit log.

### Optional guardrails

All off by default, because the server's purpose is unrestricted access. Turn
them on to narrow capability rather than network:

| Field | Effect |
| --- | --- |
| `allowedRoots` | File tools cannot leave these directories — symlink escapes included. |
| `denyCommands` | Regexes; a matching command is refused. |
| `denyPaths` | Regexes; a matching write is refused. |
| `readOnly` | Blocks all writes and all command execution. |
| `logFile` | Appends one JSONL audit line per tool call. |

A refusal reaches the model as `Policy: …`, so it understands this is an
operator decision rather than an error to route around. Guardrails apply
uniformly: a `git` write and a `pkg` install pass through the same gates as
`shell_exec`, not around them.

### Handling of secrets

A variable marked `secret: true` is usable via `${vars.…}` but never returned:
listings show `(secret)`, `get` masks it unless `reveal: true`, the audit log
records `<secret>`, and it is not written to the store file unless
`persistSecrets` is explicitly enabled.

---

## Architecture

```
bin/terminalmcp.js        CLI: arguments, --doctor, --print-config, startup
src/server.js             JSON-RPC 2.0, MCP methods, sessions, audit log
src/http.js               HTTP transport: Streamable HTTP + legacy HTTP+SSE
src/exec.js               spawning, timeouts, process-tree kills, buffering
src/jobs.js               background job registry
src/bulk.js               sequential runner: conditions, retries, variables
src/expr.js               the mini-language for `when` and `${...}`
src/vars.js               variable store: TTL, caps, secrets, atomic persistence
src/diff.js               line diff (LCS) and unified-patch application
src/glob.js               glob matching and .gitignore semantics
src/walk.js               one directory walker, shared by every crawling tool
src/archive.js            ZIP and TAR, written by hand
src/files.js              file_read / file_write / file_edit / fs_list
src/ws.js                 a WebSocket client, written by hand (RFC 6455)
src/cdp.js                Chrome DevTools Protocol: discovery, launch, sessions
src/browser.js            page operations: snapshot, input, capture, network
src/image.js              PNG decode / resize / encode, and image token maths
src/screen.js             desktop capture per platform, display and window lists
src/input.js              mouse and keyboard per platform, key tables, chords
src/shells.js             shell detection and per-platform invocation
src/config.js             configuration loading and precedence
src/guards.js             optional guardrails
src/plugins.js            plugin loading, secret resolution, redaction
plugins/fivem/            RCON, txAdmin, the F8 log, and an in-game bridge
plugins/discord/          bot REST API and webhooks
plugins/telegram/         bot API with server-side long polling
src/format.js             output cleanup and truncation
src/tools/index.js        registry: groups, profiles, token cost
src/tools/interpolate.js  which fields accept ${...}, declared in one place
src/tools/*.js            one module per tool group
skills/terminalmcp/       the skill that teaches a model to use it well
```

Roughly 18,000 lines of source, 4,800 lines of tests, zero dependencies.

### Implementation notes

- **The MCP protocol is implemented by hand** (JSON-RPC 2.0, newline-delimited
  on stdio) specifically to keep the dependency count at zero. Clone and run.
- **`stdout` carries only protocol.** Every diagnostic goes to `stderr`.
- **Requests don't block each other.** A long `shell_exec` doesn't stop a
  concurrent `shell_job` poll.
- **Timeouts kill the whole process group** — `process.kill(-pid)` on POSIX,
  `taskkill /T /F` on Windows — so a command that spawned children doesn't
  leave orphans behind. There's a regression test for exactly that.
- **Over HTTP, replies are plain JSON when the client accepts JSON.** Clients
  send `Accept: application/json, text/event-stream` on every request, so
  wrapping every short reply in an event stream would buy nothing. SSE is used
  when the client won't take JSON, or on demand via `--sse-replies`.
- **`when` and `${...}` use a dedicated parser.** No `eval`, no reachable
  arbitrary functions.
- **The browser is driven over a hand-written WebSocket client.** Node 22 has a
  global `WebSocket`, Node 18 does not, and adding `ws` for one transport would
  have ended the zero-dependency promise. RFC 6455 is a handshake plus a frame
  header; the fiddly part is that a full-page screenshot arrives as one
  multi-megabyte message, so frames are read from a chunk queue rather than by
  re-concatenating a growing buffer.
- **PNG is decoded, resized and re-encoded in process.** Shelling out to
  ImageMagick would mean the feature silently degrades on machines that do not
  have it — which is most Windows machines. The encoder picks a row filter per
  row and drops the alpha channel when nothing is transparent, which takes a
  flat UI screenshot from 1.4MB of raw pixels to a couple of kilobytes.
- **Atomic where it matters.** `file_edit` is all-or-nothing; `diff apply`
  refuses a partial patch rather than leaving a half-edited file; the variable
  store persists via write-then-rename.

### Output shaping

Every result passes through the same pipeline, because this is where tokens
quietly disappear:

- ANSI escape codes stripped, trailing whitespace trimmed, runs of blank lines
  collapsed.
- Truncation **in the middle**, keeping head and tail — errors live at the end
  of a log — with a note of how many bytes were dropped.
- Empty sections omitted entirely. No `stderr: (empty)`.
- Background job output read incrementally by offset, so bytes already seen
  never come back.

---

## Testing

```bash
npm test                 # 932 assertions
npm run test:smoke       # stdio protocol, exec, jobs, bulk, files, profiles (101)
npm run test:guards      # guardrails: readOnly, allowedRoots, deny*         (14)
npm run test:tools       # extended tools: search, git, fs, archive, …      (156)
npm run test:vars        # variables, interpolation, secrets, persistence    (67)
npm run test:image       # PNG codec, resizing, capture back-end selection   (68)
npm run test:screen      # the screen tool: real captures on a virtual X display (99)
npm run test:input       # the input tool: real clicks and keys, witnessed by xev (104)
npm run test:plugins     # loader + fivem, discord, telegram vs mocks       (144)
npm run test:browser     # a real browser: 32 actions end to end, downloads  (130)
npm run test:http        # HTTP transport: streamable + legacy SSE           (49)
```

The tests spawn the **real server** and speak MCP to it — over stdio for the
main suites, over real HTTP (sessions, SSE, CORS, batching, 413s) for the
transport suite. So they cover the handshake, JSON-RPC framing and protocol
negotiation, not just internal logic. Fixtures include a synthetic repository
and a local HTTP server, so `git`, `pkg`, `search_text` and `http_request` are
exercised against something real.

The browser suite is the same kind of thing rather than a mock: it serves
fixture pages over HTTP, launches an actual Chromium, and drives a login form
through snapshot, fill, select, click and submit, checking that the page
received the values. Two parts degrade honestly instead of pretending:

- **No browser installed** — the browser suite reports that and exits 0. A
  missing browser is a missing browser, not a broken server.
- **No desktop** — when `Xvfb` is installed, the screen suite starts a virtual
  X display, puts a window on it and captures it for real: the whole screen,
  one display, one window, an exact rectangle, saved to disk and viewed back.
  That is the test that matters, because the bugs live in the commands, not
  around them. Without `Xvfb` the suite says so and skips that block, and what
  remains still runs: the PNG codec, the token maths, the back-end decision
  table, and — for Windows — the failure protocol, the explanation each failure
  produces, and the temp path Node and .NET have to agree on.

The plugin suite needs no accounts and no secrets: it stands up local mock
servers that speak the real wire formats — including an actual UDP socket that
checks the RCON packet byte for byte, and a Telegram mock that holds a long
poll open until a message arrives. It asserts the things that would be
embarrassing to get wrong: that a token never appears in an error, that
`readOnly` refuses exactly the outward-facing actions, and that an allow-list
refusal happens *before* anything goes out on the wire.

---

## When tools go missing in your client

The server logs what it exposes; the client decides what it keeps. Those two
numbers can disagree, and nothing in the protocol reports it.

Seen in the wild: a server reporting `tools=29` while the client listed 26.
The three missing ones were the **last three in the list** — the tail had been
dropped silently, at around 41 KB of accumulated schema. The server was sending
all of them, over a working transport, as valid JSON.

So when a tool you expect is not there:

```bash
node bin/terminalmcp.js --list-tools     # what the server exposes
curl localhost:8787/health               # the same, over HTTP
```

If those show the tool and your client does not, the client dropped it. Two
things fix it, both about making the list smaller:

```bash
--tools all,-browser        # drop the biggest single tool (~6 KB)
--tools core,screen,fivem   # or name only what this session needs
```

**Groups are sent in the order you name them.** `--tools screen,git` puts
`screen` first, so it survives a client that truncates; `all` and the bundles
keep registry order. That ordering is the only lever you have over which tools
live through a cap you cannot see, so it belongs to you rather than to the
registry.

The server prints a note at startup once the schema passes 40 KB, so this is
signposted rather than discovered.

---

## Compatibility

| | Status |
| --- | --- |
| **Node.js** | 18 and later |
| **Linux** | Supported and tested |
| **macOS** | Supported; shares the POSIX code paths with Linux |
| **Windows** | Supported and tested — Git Bash, `cmd`, PowerShell 5, `pwsh` 7, WSL, `taskkill` process trees, CIM process listing, PowerShell disk queries |
| **MCP protocol** | 2024-11-05, 2025-03-26, 2025-06-18 (negotiated per session) |
| **Browser control** | Chrome, Chromium, Edge, Brave, Vivaldi — anything Chromium-family, on all three platforms. Not Firefox: it dropped most of its CDP surface in favour of WebDriver BiDi, which is a different protocol. |
| **Desktop capture** | Windows: PowerShell + System.Drawing, nothing to install — but it must run in the interactive desktop session, and `screen { action: "probe" }` says whether it does. macOS: `screencapture`, built in. Linux: whichever of `grim` (Wayland), `maim`, `import`, `scrot`, `spectacle`, `gnome-screenshot` is present — `--doctor` says which it found and what to install if none. |
| **Mouse and keyboard** | Windows: `SendInput` through PowerShell, nothing to install. X11: `xdotool`. macOS: `osascript`, plus `cliclick` for pointer moves and drags. Wayland: `ydotool` and `wtype`, because the compositor allows nothing else. `input { action: "probe" }` says what is available. |
| **Plugins** | Platform-independent: HTTPS and UDP. The FiveM client log that `f8` reads is Windows-only, because the FiveM client is. |

The browser paths are tested on Linux against a real Chromium, and the Windows
and macOS browser paths use the same protocol code — only the search for the
binary differs per platform. Desktop capture is the one part where the
per-platform commands differ substantially: the Linux ones are now captured for
real against a virtual X display, and the PowerShell script is parsed and its
failure protocol exercised by an actual PowerShell — but a successful Windows
capture, and every macOS capture, still depend on a machine we cannot run here.
If one misbehaves, please open an issue: `screen { action: "probe" }` output is
the useful thing to paste.

---

## Things worth knowing

- **Every command runs in a fresh shell.** `cd`, `export` and `source` do not
  carry across calls or bulk steps. Use `cwd`, `env`, or chain inside one
  command string (`cd x && make`).
- Output is middle-truncated at `maxOutputBytes`. Raise it if you genuinely
  need the middle of a long log, or read the log file with
  `file_read { tail_lines: n }` instead.
- `search_text` honours `.gitignore` by default. Pass
  `respect_gitignore: false` when you're looking for something in build output.
- `code outline` is pattern-based, not a real parser. It's for orientation;
  `file_read` is the source of truth.
- **Browser refs are invalidated by navigation**, deliberately: they live in
  the page as `window.__tmcpRefs`, so a reload or a new URL makes them stale and
  using one then says exactly that. Call `snapshot` again.
- **JavaScript dialogs are answered automatically** (`accept` by default), else
  the page would sit frozen forever waiting for a click nobody can make. The
  message is kept and reported, since an unexplained `alert()` is usually the
  reason something appeared not to work.
- **Only a browser this server launched is ever closed by it.** `close` on a
  browser you attached to disconnects and leaves it running; killing the
  browser a person is using would be unforgivable.
- Screenshots and downloads land under `.terminalmcp/` in the working
  directory. Worth adding to `.gitignore` — this repo already does.
- A JPEG screenshot is scaled by the renderer rather than afterwards, because
  this server can resize PNG but not JPEG. That also means the saved JPEG is
  the scaled one, while a saved PNG is full resolution.

---

## Roadmap

- Parallel step groups in `shell_bulk`
- Persistent shell sessions (keeping `cd` / `export` state)
- Mouse and keyboard control of the desktop, not just capture of it
- Firefox via WebDriver BiDi, alongside CDP
- The Discord gateway, for push delivery instead of polled `wait`
- A SQL client
- An optional token for the HTTP transport

Contributions and issues are welcome. The test suite is the contract: if you
add a tool, add assertions that drive it through the real server.

---

## License

[MIT](LICENSE)
