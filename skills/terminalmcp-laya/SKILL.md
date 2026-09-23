---
name: terminalmcp-laya
description: Make fast typed decisions and run automated game playtests through the TerminalMCP `laya` tool — choice/score/noul answers from a local Laya model in tens of milliseconds, batches of states in one call, and a playtest loop that reads a game's state (TCP bridge, file or command), lets Laya pick each action, sends it back or presses real keys, and writes a report of every exception, stuck player or rule-flagged anomaly. Use whenever the `laya` tool is available and the task is triage/classification at volume, or playtesting a Unity, Unreal, Godot or any other game to find bugs.
---

# Laya through TerminalMCP

Laya answers typed questions about a state in one forward pass. It generates no
text, so there is nothing to parse and nothing to hallucinate. It is fast and
cheap, and it is not smart. Use it where a decision has to be made often, and
keep the reasoning for yourself.

## First call

```
laya { action: "status" }
```

It tells you whether the worker is running and whether laya is installed in
the Python it points at. If laya is missing, say so and give the install
command from the reply; do not install torch and gigabytes of weights without
asking. `start` loads the model. The first start downloads the checkpoint and
can take minutes. `decide` also starts the worker on its own.

## Decisions

```
laya { action: "decide", state: {...}, questions: {
  team:   { type: "choice", instructions: "Which team owns this?", criteria: { billing: "payments, refunds", infra: "outages, servers" } },
  sev:    { type: "score",  instructions: "How severe?", criteria: ["cosmetic", "degraded", "down"] },
  secret: { type: "noul",   instructions: "Does it contain a credential?" } } }
laya { action: "decide", states: [ ... ], questions: {...} }      many states, one call
laya { action: "decide", state: "...", preset: "guard" }          router | guard | moderation | triage
```

- **Gate on confidence.** A choice comes back as `label 0.94 (runner-up …)`.
  Below about 0.8, treat it as a hint, not an answer.
- **Name choice labels for what they mean.** `true`/`false`/`yes`/`no` as labels
  bias the model towards the label rather than the state.
- More than about 20 options in one choice degrades sharply. Split it into a
  coarse question and a fine one.

## Playtesting a game

The loop runs without you in it. You set it up, let it run, and read the report.

```
laya { action: "playtest", bridge: "127.0.0.1:8080", duration_s: 90,
  actions: { move_forward: "walk ahead", turn_left: "turn left", turn_right: "turn right", jump: "jump", interact: "use what is in front" },
  questions: { bug: { type: "noul", instructions: "Does this look like a bug or a stuck player?" } },
  anomaly: "state.has_exception || answers.bug.noul > 0.85",
  stuck: { field: "pos", ticks: 40 }, shot_on_anomaly: true, window: "MyGame" }
```

1. **Pick the state source.** Use `bridge` when the game has a TCP listener that
   sends one JSON line per tick and reads `{"action": ...}` back; that is the
   fast path. Bridges ship for Unreal (a Python script run inside the editor,
   with no C++) and Unity (a component); see `plugins/laya/bridges/README.md`
   in the TerminalMCP repo. Use `state_file` when the game writes its state to
   a file. Use `state_command` as a last resort: it costs a shell per tick.
2. **A real game with no bridge (Minecraft, anything)?** Use `desktop: true`
   and `window: "<title>"`. The state then comes from the window (picture
   changing, frozen, closed) and from `log_file`. Give each action `input` in
   `input_bulk` form: `{ action: "key", keys: "w", hold_ms: 600 }` to walk,
   and `{ action: "move", dx: 300, raw: true }` to turn the camera, since
   absolute moves do nothing in a game that captures the mouse. Make the
   window title specific (`"Minecraft 1.21"`, not `"Minecraft"`, which also
   matches the launcher).
   Always add `log_file`: for a real game, the log is the only source of "that
   was an error".
3. **Put the real signal in `anomaly` and `stuck`.** Exceptions from the
   engine log, falling out of the world (`state.pos[1] < -50`), NaN
   velocities, a position that never changes. These checks are deterministic.
   `answers.bug.noul` is a second opinion, not proof.
4. **Long runs: `background: true`.** Then `playtest_status { id, wait_s: 60 }`
   blocks until the run finishes. Do not poll it in a loop.

Then read the report: `file_read` on the path it prints, or `json_tool` for
`anomalies`. Each anomaly holds the state, Laya's answers, the five ticks
before it and a screenshot path, which you can open with `screen view`. The
engine log in `last_log` usually names the file. Find it with `search_text`,
fix it, and run the playtest again to confirm the anomaly is gone.

The base checkpoints are zero-shot and explore with a bias rather than play
well. `epsilon` (default 0.1) keeps them from walking into the same wall
forever. If the histogram shows one action taking nearly every tick, raise
`epsilon` or rewrite the action descriptions.
