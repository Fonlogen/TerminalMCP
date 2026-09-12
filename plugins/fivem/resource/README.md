# terminalmcp_bridge

An **optional** FiveM/RedM resource. Install it only if you want TerminalMCP to
reach *into* the game — into a player's F8 console, or into Lua on the server.

Everything else the `fivem` plugin does works without this: server status,
player lists, RCON commands, the F8 **log**, txAdmin. The bridge exists for the
one thing no remote protocol can otherwise do — typing into a running game
client's console.

## Read this part

The bridge evaluates arbitrary Lua on your server and on connected clients.
Whoever holds `terminalmcp_secret` can do anything your server can do: read
your database through your resources, move players, run any command. That is
not a side effect, it is the feature.

So:

- **Use a long random secret.** The resource refuses to start below 16
  characters.
- **Do not expose the FXServer HTTP port to the internet** any more than you
  already do. The bridge listens on the same port as `/info.json`, and the
  secret is the only thing in front of it. If that port is public, so is the
  bridge.
- **Treat it like an admin console**, because it is one. Installing it on a
  server you share with other admins gives whoever holds the secret more
  access than most of them have.

If that trade is not worth it for your server, do not install this. The plugin
degrades cleanly: `f8_exec`, `client_lua` and `server_lua` explain that the
bridge is missing, and everything else carries on.

## Install

1. Copy this folder into your server's resources:

   ```
   resources/[terminalmcp]/terminalmcp_bridge/
   ```

2. In `server.cfg`:

   ```cfg
   set terminalmcp_secret "a-long-random-string-you-generate"
   ensure terminalmcp_bridge
   ```

3. In TerminalMCP's config file:

   ```json
   {
     "plugins": ["fivem"],
     "pluginConfig": {
       "fivem": {
         "host": "127.0.0.1",
         "port": 30120,
         "bridge": { "secret": "env:FIVEM_BRIDGE_SECRET" }
       }
     }
   }
   ```

   and export the same value as `FIVEM_BRIDGE_SECRET`.

4. Check it:

   ```
   fivem { action: "bridge" }
   ```

## What it adds

```
fivem { action: "f8_exec", player: "3", command: "say hello" }
fivem { action: "client_lua", player: "3", lua: "GetEntityCoords(PlayerPedId())" }
fivem { action: "server_lua", lua: "return #GetPlayers()" }
```

`client_lua` and `server_lua` take either an expression or a block with a
`return` in it — both shapes work, the resource tries the expression first.

## What it cannot do

**Read the F8 console's output.** FiveM gives no API for reading back what the
console printed, on the client or the server. So:

- to send input to a client console → `f8_exec` (this resource)
- to read a client console's output → `fivem { action: "f8" }`, which reads
  `CitizenFX.log` on that machine
- to read the server console → `shell_job` if TerminalMCP started the FXServer,
  otherwise `tx_log`

`client_lua` is usually the better tool anyway: it hands you the value instead
of making you go and read for it.

## Endpoints

For reference, in case you want to firewall or proxy them. All are POST, all
require the `X-Terminalmcp-Secret` header, all answer JSON.

| Endpoint | Body | Does |
| --- | --- | --- |
| `/terminalmcp_bridge/ping` | — | version, resource name, player count |
| `/terminalmcp_bridge/client_exec` | `{player, command}` | runs the command in that client's console |
| `/terminalmcp_bridge/client_lua` | `{player, lua, timeout_ms?}` | evaluates Lua on that client, returns the value |
| `/terminalmcp_bridge/server_lua` | `{lua}` | evaluates Lua on the server, returns the value |
