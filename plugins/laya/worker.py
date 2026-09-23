"""TerminalMCP <-> Laya worker.

A long-lived process that keeps Laya's checkpoints resident, so a decision
costs one forward pass (tens of milliseconds) instead of a checkpoint load
(seconds). The plugin starts it once and talks to it over stdin/stdout, one
JSON object per line:

    -> {"id": 1, "op": "predict", "state": {...}, "questions": {...}}
    <- {"id": 1, "ok": true, "result": {...}, "ms": 31.2}

ops: predict, predict_batch, route, status. Anything the library prints goes
to stderr: stdout carries the protocol and nothing else, because one stray
line from a progress bar would desynchronise every reply after it.

Configured by environment, set by the plugin:
    LAYA_PRELOAD   "" (lazy) | "all" | comma list of checkpoints
    LAYA_DEVICE    passed to Router(device=...) when set
    LAYA_THREADS   torch intra-op threads, for CPU inference
"""

import json
import os
import sys
import time
import traceback

# Claim stdout for the protocol before anything can print to it.
_proto = sys.stdout
sys.stdout = sys.stderr


def send(obj):
    _proto.write(json.dumps(obj, ensure_ascii=False, default=str) + "\n")
    _proto.flush()


def main():
    t0 = time.time()
    try:
        import laya
        from laya import Router
    except Exception as err:  # noqa: BLE001 - report whatever stops the import
        send({"event": "fatal", "error": f"cannot import laya: {err}", "python": sys.executable})
        return 2

    threads = os.environ.get("LAYA_THREADS")
    if threads:
        try:
            import torch
            torch.set_num_threads(int(threads))
        except Exception as err:  # noqa: BLE001
            print(f"LAYA_THREADS ignored: {err}", file=sys.stderr)

    kwargs = {}
    device = os.environ.get("LAYA_DEVICE") or None
    if device:
        kwargs["device"] = device
    preload = (os.environ.get("LAYA_PRELOAD") or "").strip()

    send({"event": "loading", "preload": preload or None, "device": device})
    try:
        if preload == "all":
            router = Router(preload=True, **kwargs)
        else:
            router = Router(**kwargs)
            models = [m.strip() for m in preload.split(",") if m.strip()]
            if models:
                router.preload(models)
    except Exception as err:  # noqa: BLE001
        send({"event": "fatal", "error": f"loading Laya failed: {err}", "trace": traceback.format_exc()[-2000:]})
        return 3

    send({
        "event": "ready",
        "version": getattr(laya, "__version__", None),
        "python": sys.executable,
        "device": describe_device(device),
        "load_ms": round((time.time() - t0) * 1000),
    })

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError as err:
            send({"id": None, "ok": False, "error": f"bad request line: {err}"})
            continue
        rid = msg.get("id")
        started = time.perf_counter()
        try:
            result = handle(laya, router, msg)
            send({"id": rid, "ok": True, "result": result, "ms": round((time.perf_counter() - started) * 1000, 1)})
        except Exception as err:  # noqa: BLE001 - a bad question must not kill the worker
            send({"id": rid, "ok": False, "error": f"{type(err).__name__}: {err}"})
    return 0


def questions_for(laya, msg):
    preset = msg.get("preset")
    if preset:
        fn = getattr(laya, f"{preset}_questions", None)
        if fn is None:
            raise ValueError(f'unknown preset "{preset}": router, guard, moderation, triage')
        return fn()
    return msg.get("questions") or {}


def routing_kwargs(msg):
    return {k: msg[k] for k in ("model", "lang", "task") if msg.get(k)}


def handle(laya, router, msg):
    op = msg.get("op")
    if op == "predict":
        return router.predict(msg.get("state"), questions_for(laya, msg), **routing_kwargs(msg))
    if op == "predict_batch":
        questions = questions_for(laya, msg)
        extra = routing_kwargs(msg)
        requests = [{"state": s, "questions": questions, **extra} for s in msg.get("states") or []]
        return router.predict_batch(requests)
    if op == "route":
        r = router.route(msg.get("state"), questions_for(laya, msg))
        return {k: getattr(r, k, None) for k in ("model", "repo", "reason")} if not isinstance(r, dict) else r
    if op == "status":
        return {
            "version": getattr(laya, "__version__", None),
            "python": sys.executable,
            "loaded": loaded_models(router),
        }
    raise ValueError(f'unknown op "{op}"')


def loaded_models(router):
    for attr in ("loaded", "_agents", "agents", "_loaded"):
        v = getattr(router, attr, None)
        if v is None:
            continue
        try:
            return sorted(v() if callable(v) else v)
        except Exception:  # noqa: BLE001
            continue
    return None


def describe_device(requested):
    try:
        import torch
        if requested:
            return requested
        if torch.cuda.is_available():
            return f"cuda ({torch.cuda.get_device_name(0)})"
        return "cpu"
    except Exception:  # noqa: BLE001
        return requested or "unknown"


if __name__ == "__main__":
    sys.exit(main())
