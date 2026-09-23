"""TerminalMCP playtest bridge for Unreal Engine 5 — no C++, no rebuild.

Run it inside the editor (the Python Editor Script Plugin must be enabled, as it
is in most UE5 projects):

    Output Log, "Cmd" box set to Python  ->  exec(open(r"<path>/terminalmcp_bridge.py").read())
    or the console command                ->  py "<path>/terminalmcp_bridge.py"

Then press Play (PIE) and start the playtest from TerminalMCP:

    laya { action: "playtest", bridge: 8080, log_file: "<Project>/Saved/Logs/<Project>.log",
           error_pattern: "Error:|Accessed None|Ensure condition failed", ... }

It listens on 127.0.0.1:8080 (TERMINALMCP_BRIDGE_PORT to change it). While a
PIE session runs it sends one JSON line of state, waits for one JSON line with
the action, applies it for HOLD seconds of game time, and sends the next state.
Everything happens on the editor tick — the game thread — because the Unreal
API must not be touched from another thread.

Running the script again replaces the running bridge. terminalmcp_bridge_stop()
in the Python console stops it.

State sent each tick:
    pos [x, y, z] metres, speed m/s, yaw degrees, falling, wall_ahead,
    map, pawn class, playing
Actions understood:
    move_forward, move_back, move_left, move_right, turn_left, turn_right,
    turn_around, jump, crouch, look_up, look_down, wait
    plus {"action": "console", "command": "..."} to run a console command.
"""

import builtins
import json
import os
import socket

import unreal

PORT = int(os.environ.get("TERMINALMCP_BRIDGE_PORT", "8080"))
HOLD = float(os.environ.get("TERMINALMCP_BRIDGE_HOLD", "0.25"))  # seconds each action lasts
TURN_DEG = 30.0
PROBE_CM = 120.0  # how far ahead counts as "a wall ahead"


def _log(msg):
    unreal.log(f"[terminalmcp bridge] {msg}")


class Bridge:
    def __init__(self, port):
        self.port = port
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(("127.0.0.1", port))
        self.server.listen(1)
        self.server.setblocking(False)
        self.client = None
        self.inbox = b""
        self.awaiting = False       # a state was sent, the action has not come back yet
        self.hold_left = 0.0        # game seconds the current action still runs
        self.current = None
        self.handle = unreal.register_slate_post_tick_callback(self.tick)
        _log(f"listening on 127.0.0.1:{port}; press Play, then start the playtest")

    # -- plumbing --------------------------------------------------------------

    def stop(self):
        try:
            unreal.unregister_slate_post_tick_callback(self.handle)
        except Exception:  # noqa: BLE001
            pass
        for s in (self.client, self.server):
            try:
                if s:
                    s.close()
            except Exception:  # noqa: BLE001
                pass
        self.client = None
        _log("stopped")

    def accept(self):
        if self.client:
            return
        try:
            conn, _ = self.server.accept()
        except (BlockingIOError, OSError):
            return
        conn.setblocking(False)
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.client, self.inbox, self.awaiting, self.current, self.hold_left = conn, b"", False, None, 0.0
        _log("playtest connected")

    def drop(self, why):
        _log(f"playtest disconnected ({why})")
        try:
            self.client.close()
        except Exception:  # noqa: BLE001
            pass
        self.client = None

    def send(self, obj):
        try:
            self.client.sendall((json.dumps(obj) + "\n").encode("utf-8"))
            return True
        except OSError as err:
            self.drop(err)
            return False

    def receive(self):
        """Complete lines that have arrived, without blocking the editor."""
        try:
            chunk = self.client.recv(65536)
            if not chunk:
                self.drop("closed")
                return []
            self.inbox += chunk
        except (BlockingIOError, InterruptedError):
            pass
        except OSError as err:
            self.drop(err)
            return []
        *lines, self.inbox = self.inbox.split(b"\n")
        return [l for l in lines if l.strip()]

    # -- the game --------------------------------------------------------------

    @staticmethod
    def world():
        try:
            return unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_game_world()
        except Exception:  # noqa: BLE001
            return None

    def state(self, world, pawn):
        loc = pawn.get_actor_location()
        rot = pawn.get_actor_rotation()
        falling = None
        move = getattr(pawn, "character_movement", None)
        if move is not None:
            try:
                falling = bool(move.is_falling())
            except Exception:  # noqa: BLE001
                falling = None
        return {
            "playing": True,
            "pos": [round(loc.x / 100, 2), round(loc.y / 100, 2), round(loc.z / 100, 2)],
            "speed": round(pawn.get_velocity().length() / 100, 2),
            "yaw": round(rot.yaw, 1),
            "falling": falling,
            "wall_ahead": self.wall_ahead(world, pawn),
            "map": world.get_name(),
            "pawn": pawn.get_class().get_name(),
        }

    @staticmethod
    def wall_ahead(world, pawn):
        try:
            start = pawn.get_actor_location()
            end = start + pawn.get_actor_forward_vector() * PROBE_CM
            hit = unreal.SystemLibrary.line_trace_single(
                world, start, end, unreal.TraceTypeQuery.TRACE_TYPE_QUERY1, False, [pawn],
                unreal.DrawDebugTrace.NONE, True)
            if isinstance(hit, tuple):
                hit = hit[0]
            return bool(hit) and bool(getattr(hit, "blocking_hit", True))
        except Exception:  # noqa: BLE001 - a probe that fails is "unknown", not a crash
            return None

    def start_action(self, pawn, msg):
        action = msg.get("action") if isinstance(msg, dict) else None
        self.current, self.hold_left = action, HOLD
        controller = pawn.get_controller()
        if action in ("turn_left", "turn_right", "turn_around", "look_up", "look_down") and controller:
            rot = controller.get_control_rotation()
            if action == "turn_left":
                rot.yaw -= TURN_DEG
            elif action == "turn_right":
                rot.yaw += TURN_DEG
            elif action == "turn_around":
                rot.yaw += 180
            elif action == "look_up":
                rot.pitch = min(rot.pitch + 15, 80)
            else:
                rot.pitch = max(rot.pitch - 15, -80)
            controller.set_control_rotation(rot)
        elif action == "jump" and hasattr(pawn, "jump"):
            pawn.jump()
        elif action == "crouch" and hasattr(pawn, "crouch"):
            pawn.crouch()
        elif action == "console" and msg.get("command"):
            unreal.SystemLibrary.execute_console_command(pawn.get_world(), str(msg["command"]))

    def continue_action(self, pawn, dt):
        """Movement input lasts one frame, so a held move is re-applied every tick."""
        dirs = {
            "move_forward": pawn.get_actor_forward_vector(),
            "move_back": pawn.get_actor_forward_vector() * -1.0,
            "move_right": pawn.get_actor_right_vector(),
            "move_left": pawn.get_actor_right_vector() * -1.0,
        }
        if self.current in dirs:
            pawn.add_movement_input(dirs[self.current], 1.0, False)
        self.hold_left -= dt
        if self.hold_left <= 0:
            if self.current == "jump" and hasattr(pawn, "stop_jumping"):
                pawn.stop_jumping()
            if self.current == "crouch" and hasattr(pawn, "un_crouch"):
                pawn.un_crouch()
            self.current = None
            return True
        return False

    def tick(self, dt):
        try:
            self.accept()
            if not self.client:
                return
            lines = self.receive()
            if not self.client:
                return
            world = self.world()
            pawn = unreal.GameplayStatics.get_player_pawn(world, 0) if world else None
            if not pawn:
                # Not playing: say so once in a while so the playtest does not
                # time out, and act on nothing.
                if not self.awaiting:
                    self.awaiting = self.send({"playing": False})
                for _ in lines:
                    self.awaiting = False
                return
            for line in lines:
                try:
                    msg = json.loads(line.decode("utf-8"))
                except ValueError:
                    msg = {"action": line.decode("utf-8", "replace").strip()}
                self.awaiting = False
                self.start_action(pawn, msg)
            finished = self.continue_action(pawn, dt) if self.current else True
            if finished and not self.awaiting:
                self.awaiting = self.send(self.state(world, pawn))
        except Exception as err:  # noqa: BLE001 - never take the editor tick down with us
            _log(f"tick error: {err}")


def terminalmcp_bridge_stop():
    old = getattr(builtins, "_terminalmcp_bridge", None)
    if old:
        old.stop()
        builtins._terminalmcp_bridge = None


builtins.terminalmcp_bridge_stop = terminalmcp_bridge_stop
terminalmcp_bridge_stop()
builtins._terminalmcp_bridge = Bridge(PORT)
