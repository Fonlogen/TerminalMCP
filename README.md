<div align="center">

# TerminalMCP

### Give your AI agent a real terminal — and stop paying for it in tokens.

A zero-dependency MCP server that hands an AI complete control of a machine —
shell, filesystem, git, package managers, processes, network — and is built so
that the whole thing costs a fraction of the tokens a naive tool server burns.

[![CI](https://github.com/Fonlogen/TerminalMCP/actions/workflows/ci.yml/badge.svg)](https://github.com/Fonlogen/TerminalMCP/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2018-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-success)](package.json)
[![Tests](https://img.shields.io/badge/tests-383%20assertions-success)](test)
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
| Tools you don't need this session | pay for them anyway | **`--tools` profiles** |

Everything else — 26 tools, two transports, cross-platform shells — exists so
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

---

## The three ideas that make it different

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
| `all` (default) | 26 | ~11,500 |

```bash
node bin/terminalmcp.js --tools core             # shell, jobs, bulk, files, vars
node bin/terminalmcp.js --tools dev              # + search, git, fs, dev, data
node bin/terminalmcp.js --tools core,git,search  # pick groups
node bin/terminalmcp.js --tools all,-watch       # everything except one
```

`core` and `vars` are always included. `--list-tools` and `--doctor` print the
cost of every group, and `shell_info` reports it to the model at runtime — so
trimming is an informed decision rather than a guess. Nothing is ever lost:
whatever isn't exposed as a tool is still reachable through `shell_exec`.

---

## Tool reference

26 tools in 11 groups. Most use an `action` parameter rather than one tool per
verb — `git` alone would otherwise be twenty tools.

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
| `varsFile` | `null` | Mirror the variable store to this file so it survives a restart. |
| `persistSecrets` | `false` | Also write `secret` variables to that file. |
| `maxVars` / `maxVarBytes` / `maxVarsTotalBytes` | `200` / `1MB` / `8MB` | Variable store limits. |

### Command-line options

```bash
node bin/terminalmcp.js --help
```

`--cwd`, `--shell`, `--config`, `--timeout-ms`, `--max-output-bytes`,
`--login`, `--tools`, `--vars-file`, `--persist-secrets`, `--max-vars`,
`--max-var-bytes`, `--read-only`, `--allowed-root`, `--log-file`.

HTTP: `--http`, `--host`, `--port`, `--path`, `--no-cors`, `--strict-sessions`,
`--sse-replies`, `--max-body-bytes`.

Commands: `--doctor`, `--print-config`, `--list-tools`, `--help`, `--version`.

### Environment variables

`TERMINALMCP_SHELL`, `TERMINALMCP_CWD`, `TERMINALMCP_TIMEOUT_MS`,
`TERMINALMCP_MAX_OUTPUT_BYTES`, `TERMINALMCP_LOGIN`, `TERMINALMCP_KEEP_ANSI`,
`TERMINALMCP_READ_ONLY`, `TERMINALMCP_LOG_FILE`, `TERMINALMCP_ALLOWED_ROOTS`,
`TERMINALMCP_CONFIG`, `TERMINALMCP_TOOLS`, `TERMINALMCP_VARS_FILE`,
`TERMINALMCP_HTTP`, `TERMINALMCP_HTTP_HOST`, `TERMINALMCP_HTTP_PORT`,
`TERMINALMCP_HTTP_PATH`, `TERMINALMCP_HTTP_CORS`.

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
src/shells.js             shell detection and per-platform invocation
src/config.js             configuration loading and precedence
src/guards.js             optional guardrails
src/format.js             output cleanup and truncation
src/tools/index.js        registry: groups, profiles, token cost
src/tools/interpolate.js  which fields accept ${...}, declared in one place
src/tools/*.js            one module per tool group
skills/terminalmcp/       the skill that teaches a model to use it well
```

Roughly 9,300 lines of source, 1,900 lines of tests, zero dependencies.

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
npm test                 # 383 assertions
npm run test:smoke       # stdio protocol, exec, jobs, bulk, files, profiles (97)
npm run test:guards      # guardrails: readOnly, allowedRoots, deny*         (14)
npm run test:tools       # extended tools: search, git, fs, archive, …      (156)
npm run test:vars        # variables, interpolation, secrets, persistence    (67)
npm run test:http        # HTTP transport: streamable + legacy SSE           (49)
```

The tests spawn the **real server** and speak MCP to it — over stdio for the
main suites, over real HTTP (sessions, SSE, CORS, batching, 413s) for the
transport suite. So they cover the handshake, JSON-RPC framing and protocol
negotiation, not just internal logic. Fixtures include a synthetic repository
and a local HTTP server, so `git`, `pkg`, `search_text` and `http_request` are
exercised against something real.

---

## Compatibility

| | Status |
| --- | --- |
| **Node.js** | 18 and later |
| **Linux** | Supported and tested |
| **macOS** | Supported; shares the POSIX code paths with Linux |
| **Windows** | Supported and tested — Git Bash, `cmd`, PowerShell 5, `pwsh` 7, WSL, `taskkill` process trees, CIM process listing, PowerShell disk queries |
| **MCP protocol** | 2024-11-05, 2025-03-26, 2025-06-18 (negotiated per session) |

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

---

## Roadmap

- Parallel step groups in `shell_bulk`
- Persistent shell sessions (keeping `cd` / `export` state)
- A SQL client
- An optional token for the HTTP transport

Contributions and issues are welcome. The test suite is the contract: if you
add a tool, add assertions that drive it through the real server.

---

## License

[MIT](LICENSE)
