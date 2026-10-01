"""Tool-call wrapper: timeout, one retry, structured logging to tool_calls (spec 8.3)."""
from __future__ import annotations

import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutTimeout

from django.db import close_old_connections

from engine import context

log = logging.getLogger("rxguard.tools")
_pool = ThreadPoolExecutor(max_workers=16, thread_name_prefix="tool")


class ToolFailure(Exception):
    def __init__(self, tool: str, reason: str):
        super().__init__(f"{tool}: {reason}")
        self.tool, self.reason = tool, reason


def _summ(obj, n=400) -> str:
    try:
        s = json.dumps(obj, default=str)
    except Exception:
        s = str(obj)
    return s if len(s) <= n else s[: n - 3] + "..."


def _in_thread(fn, ctx, *args, **kwargs):
    token = context.set_context(ctx)
    try:
        return fn(*args, **kwargs)
    finally:
        close_old_connections()
        context.reset_context(token)


def run_tool(name: str, fn, args: dict, timeout_s: float | None = None, retries: int = 1, summarize=None):
    """Run fn(**args) with a timeout (spec 8.3, from settings.TOOL_TIMEOUTS_S); retry once; log every attempt.
    Raises ToolFailure."""
    from django.conf import settings

    from api.models import ToolCall

    timeout_s = timeout_s or settings.RXGUARD["TOOL_TIMEOUTS_S"].get(name, 2.0)
    ctx = context.current()
    last = "unknown"
    for attempt in range(retries + 1):
        t0 = time.perf_counter()
        status, result = "ok", None
        try:
            if context.simulating("tool_timeout") and name != "escalate":
                time.sleep(timeout_s + 0.05)
                raise FutTimeout()
            if _in_test_mode():
                result = fn(**args)  # same thread: test DB transactions are not shared across threads
            else:
                result = _pool.submit(_in_thread, fn, ctx, **args).result(timeout=timeout_s)
        except FutTimeout:
            status, last = "timeout", f"timed out after {timeout_s}s"
        except ToolFailure as e:
            status, last = "error", e.reason
        except Exception as e:  # noqa: BLE001 - every failure becomes a structured tool failure
            status, last = "error", f"{type(e).__name__}: {e}"
        ms = (time.perf_counter() - t0) * 1000
        summary = (summarize(result) if summarize and result is not None else _summ(result)) if status == "ok" else last
        try:
            ToolCall.objects.create(correlation_id=ctx.correlation_id, tool=name, args_summary=_summ(args),
                                    result_summary=summary, latency_ms=ms, status=status)
        except Exception:  # noqa: BLE001 - the DB may be the thing that failed
            pass
        log.info("tool_call", extra={"tool": name, "tool_args": _summ(args, 200), "latency_ms": round(ms, 1),
                                     "status": status, "attempt": attempt + 1})
        if status == "ok":
            return result
    raise ToolFailure(name, last)


def _in_test_mode() -> bool:
    import sys
    return "pytest" in sys.modules
