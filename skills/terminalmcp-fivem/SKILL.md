---
name: terminalmcp-fivem
description: Operate a FiveM or RedM server through the TerminalMCP `fivem` tool — check status and players with no credentials, run console commands over RCON, start and restart resources, kick players, read the F8 client console log where client script errors actually appear, drive txAdmin, check which of a resource's files are actually readable before spending tokens on encrypted ones, and (with the optional bridge resource) run commands in a player's F8 console or evaluate Lua on the server. Use whenever the `fivem` tool is available and the task involves a FiveM/RedM server, a resource that is misbehaving, txAdmin, RCON, or the F8 console.
---

# FiveM through TerminalMCP

The `fivem` tool covers four different things people call "the console". Knowing
which one you want is most of the job.

| You want to… | Use |
| --- | --- |
| Know if the server is up, and who is on it | `status`, `players` — **no password needed** |
| Run a server console command | `rcon`, or `shell_job` if this server started the FXServer |
| Restart or reload a resource | `resource` |
| See why a client-side script is broken | `f8` — the client log |
| Type into a player's F8 console | `f8_exec` — needs the bridge resource |
| Get a value out of a running script | `client_lua` / `server_lua` — needs the bridge |
| Restart the whole server | `tx_control`, or `shell_job` |

## Start with the free ones

`status` and `players` hit the server's public JSON endpoints. No RCON
password, no txAdmin login, nothing to configure beyond the host and port:

```
fivem { action: "status" }
fivem { action: "players" }
fivem { action: "resources", match: "esx" }
```

If someone asks "is the server up", that is the whole answer, and it costs
nothing. Do this before reaching for credentials.

## The server console

Two channels, and the difference matters.

**If TerminalMCP started the FXServer**, its stdout is right there and is the
better channel — it cannot drop anything, and you can write to its stdin:

```
shell_exec_async { command: "./run.sh +exec server.cfg", name: "fx" }
shell_job { action: "output", job_id: "fx", wait_ms: 30000 }
shell_job { action: "write", job_id: "fx", text: "refresh\n" }
```

**Otherwise use RCON**, which is UDP and needs `rcon_password` in `server.cfg`:

```
fivem { action: "rcon", command: "status" }
fivem { action: "resource", resource: "esx_ambulancejob", op: "restart" }
fivem { action: "say", message: "Restarting in 5 minutes" }
fivem { action: "kick", player: "3", reason: "afk" }
```

Being UDP, RCON has no delivery guarantee and no end-of-reply marker: the tool
collects packets until the server goes quiet. So a command that prints nothing
looks the same as one that was lost. For anything where that distinction
matters, use the job channel.

If `rcon` times out, the message lists the four things it can mean. The most
common by far is the port: RCON is on the **game port** (usually 30120), not
txAdmin's 40120.

## The F8 console — read and write are different problems

**Reading** it is a log file. `f8` finds it automatically on Windows:

```
fivem { action: "f8", lines: 120 }
fivem { action: "f8", errors: true }        only error-ish lines
fivem { action: "f8", match: "my-resource" }
```

This is where client-side `SCRIPT ERROR` lines land, which is exactly what you
want when a resource works on the server but breaks for players. Note that the
log is on the **player's machine** — reading it means TerminalMCP is running
there, or the file has been copied.

**Writing** to it is impossible over any protocol FiveM offers, unless the
optional `terminalmcp_bridge` resource is installed on the server. With it:

```
fivem { action: "f8_exec", player: "3", command: "say hello" }
```

Without it, that action explains how to install it. Do not promise the user it
works before checking `fivem { action: "bridge" }`.

If the bridge 404s, it is almost always the **resource name**: FiveM routes on
the resource's folder name, not on the `name` in `fxmanifest.lua`. `bridge`
reads the server's resource list when it cannot connect and names the likely
candidate — the fix is `pluginConfig.fivem.bridge.resource`, not a reinstall.

## Getting values out, rather than reading logs

When the bridge is installed, this is usually better than reading any console:

```
fivem { action: "server_lua", lua: "#GetPlayers()" }
fivem { action: "client_lua", player: "3", lua: "GetEntityCoords(PlayerPedId())" }
```

Both take an expression or a block with a `return`. You get the value back as
JSON instead of having to find it in a log.

## txAdmin

```
fivem { action: "tx_status" }                       needs TXHOST_API_TOKEN
fivem { action: "tx_announce", message: "…" }
fivem { action: "tx_control", control: "restart" }
fivem { action: "tx_log", lines: 200, match: "error" }
```

One caveat worth passing on: only `/host/status` is a documented txAdmin API.
The others drive the panel's own internal interface, which can change between
txAdmin versions. If one of them starts failing after an update, that is why —
say so rather than assuming the credentials broke.

## Diagnosing a broken resource

The usual shape of the task, in the cheapest order:

1. `fivem { action: "status" }` — is it even up?
2. `fivem { action: "resources", match: "<name>" }` — is it loaded?
3. `fivem { action: "resource", resource: "<name>", op: "restart" }` — does it
   come back?
4. Server-side errors → `tx_log { match: "error" }`, or `shell_job` output.
5. Client-side errors → `f8 { errors: true }`.
6. Still unclear → `server_lua` / `client_lua` to inspect actual state.
7. Read the code with `search_text` and `file_read`, not by guessing — but
   first read the section below. Half the paid resources on a server cannot be
   read at all.

## Before reading a resource's code: check for escrow

**Always run `inspect` before opening any file of a resource.**

```
fivem { action: "inspect", resource: "esx_policejob" }
fivem { action: "inspect" }        every resource under the server cwd, at a glance
```

Most paid FiveM resources ship through Cfx.re asset escrow: the scripts are
encrypted, the server decrypts them at runtime, and an `.fxap` file sits in the
resource root. The manifest — `fxmanifest.lua`, or `__resource.lua` on legacy
resources — then lists under `escrow_ignore` the files the author left in the
clear, normally the config and whatever is meant to be edited.

**That list is the entire readable surface of the resource.** Everything else is
ciphertext, and it does not announce itself: `file_read` succeeds, bytes come
back, and thousands of tokens buy noise. `search_text` over the folder is worse
— it reads every encrypted file to match nothing.

`inspect` does the reading for you and answers with two lists:

- **readable** — the manifest plus everything `escrow_ignore` matches. Read
  these.
- **encrypted** — every other script. Do not open them, and do not grep them.

It also distinguishes `ESCROWED` (an `.fxap` is present: the build in front of
you really is encrypted) from `ESCROW-READY` (the manifest declares
`escrow_ignore` but there is no `.fxap`, so this is probably the source copy and
all of it is readable). When it says ESCROW-READY, read one of the listed
scripts to settle it: plain Lua means source, binary means escrow.

When the answer is not in the readable files, say so rather than fishing. The
`exports`, events and dependencies declared in the manifest describe the
interface without any of the implementation, and the resource's own
documentation is usually the rest. Decompiling escrowed assets is not something
to attempt or suggest.

## Things that will bite you

- **The port.** Game/HTTP port (30120) for `status`, `players`, `rcon` and the
  bridge. txAdmin's port (40120) only for `tx_*`.
- **RCON is off unless `rcon_password` is set** in `server.cfg`. The error says
  so exactly when that is the cause.
- **`allowCommands` / `denyCommands`** may be configured by the operator. A
  refusal comes back as `Policy: …` — report it, do not try to route around it.
- **`readOnly`** blocks `rcon`, `say`, `kick`, `resource`, `tx_control` and the
  Lua actions. `status`, `players`, `resources`, `inspect`, `f8` and `tx_status`
  still work.
- **An escrowed resource looks readable and is not.** `file_read` on an
  encrypted script returns bytes and burns tokens. `inspect` first, every time.
- **Restarting a live server kicks everyone off it.** It is a real server with
  real people on it. Say what you are about to do before you do it, and prefer
  `say` a warning first.
