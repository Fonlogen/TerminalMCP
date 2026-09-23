# Playtest bridges

`laya playtest` needs two things from a game: its **state** on every tick, and
a way to **act** on it. A bridge gives both over one TCP connection, which is
the fast path: tens of decisions per second, and a state that says exactly
where the player is. A real game with no bridge (Minecraft, anything you did
not write) is played through its window instead; see *Games without a bridge*
below.

## The protocol

The game **listens** on a TCP port (8080 by default). TerminalMCP connects.
Messages are one JSON object per line, in turn:

```
game -> {"playing": true, "pos": [3.2, 0, 7.5], "wall_ahead": true, "has_exception": false, ...}
tmcp -> {"action": "turn_left"}
game    applies it for a short hold, then sends the next state
```

- Any fields may be in the state; they reach Laya as they are and can be used
  in the `anomaly` rule (`state.pos[1] < -50`) and by `stuck` (`field: "pos"`).
- `has_exception` + `last_log` is the convention for "the engine reported an
  error". The default anomaly rule is `state.has_exception`.
- `{"playing": false}` means "the bridge is up but nothing is being played" —
  an editor before Play is pressed. TerminalMCP answers `{"action": "wait"}`
  and does not count it as a decision.
- The action object is `{"action": "<name>"}`, or whatever the action's `send`
  says in the playtest call.

## Unreal Engine 5 — `unreal/terminalmcp_bridge.py`

No C++ and no rebuild: it runs inside the editor through the Python Editor
Script Plugin, on the editor tick (the game thread).

1. Enable **Python Editor Script Plugin** (Edit > Plugins) if the project does
   not have it yet.
2. Output Log > switch the command box from `Cmd` to `Python`, and run
   `exec(open(r"D:\MCP\TerminalMCP\plugins\laya\bridges\unreal\terminalmcp_bridge.py").read())`
   — or type `py "D:/MCP/TerminalMCP/plugins/laya/bridges/unreal/terminalmcp_bridge.py"` in the console.
3. Press **Play**, then:

```
laya { action: "playtest", bridge: 8080, duration_s: 120,
  actions: { move_forward: "walk ahead", turn_left: "turn left", turn_right: "turn right", jump: "jump" },
  anomaly: "state.has_exception || state.pos[2] < -20",
  stuck: { field: "pos", ticks: 30, epsilon: 0.05 },
  log_file: "C:/Users/you/Documents/Unreal Projects/MyGame/Saved/Logs/MyGame.log",
  error_pattern: "Error:|Accessed None|Ensure condition failed|Assertion failed" }
```

The state is the pawn's `pos` (metres), `speed`, `yaw`, `falling`,
`wall_ahead` (a 1.2 m trace), `map` and `pawn`. Errors come from the project
log through `log_file`: Blueprint "Accessed None" is only a *warning* in
Unreal's log, which is why the pattern above names it. Running the script
again replaces the bridge; `terminalmcp_bridge_stop()` in the Python console
stops it.

The editor throttles itself when it is not the focused window (Editor
Preferences > General > Performance > "Use Less CPU when in Background").
Turn that off, or keep the editor in front, for a full-speed playtest.

## Unity — `unity/TerminalMcpBridge.cs`

Add the component to the player of a test scene and press Play. It moves a
`CharacterController`, a `Rigidbody`, or the bare transform, whichever the
object has; reports `pos`, `speed`, `yaw`, `grounded`, `wall_ahead`, `scene`;
and catches `Debug.LogError`, exceptions and asserts as `has_exception` /
`last_log`. The socket lives on its own thread and only moves strings — every
Unity call happens in `Update`, since Unity's API is main-thread only.

It is compile-checked against stub Unity types, not yet run inside Unity.

## Games without a bridge

For a game you cannot add code to, the playtest watches its **window** and its
**log** and acts with real keys and mouse:

```
laya { action: "playtest", desktop: true, window: "Minecraft 1.21", duration_s: 120,
  log_file: "%APPDATA%/.minecraft/logs/latest.log",
  actions: {
    walk:       { description: "walk forward",  input: { action: "key", keys: "w", hold_ms: 600 } },
    turn_left:  { description: "look left",     input: { action: "move", dx: -300, dy: 0, raw: true } },
    turn_right: { description: "look right",    input: { action: "move", dx: 300, dy: 0, raw: true } },
    jump:       { description: "jump forward",  input: [{ action: "key", keys: "space" }, { action: "key", keys: "w", hold_ms: 400 }] } } }
```

The state is `window_open`, `focused`, `frame_change` (how much the picture
moved since the last tick), `brightness`, `static_ticks`, `last_action`, and
the new log lines. The built-in checks flag a window that disappeared (crash),
a picture frozen for `frozen_ticks`, and log lines matching `error_pattern`.
Input is never sent while another window has the focus.

`raw: true` on a move sends raw mouse motion, which is what turns the camera in
a game that captures the pointer; an absolute move does nothing there. On
Windows every action goes through a resident input process, a few milliseconds
each. Games with anti-cheat may ignore injected input altogether.
