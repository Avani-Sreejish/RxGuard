"""Per-request context: correlation ID, user, failure-injection toggles, LLM call count."""
from __future__ import annotations

import contextvars
import uuid
from dataclasses import dataclass, field


@dataclass
class RequestContext:
    correlation_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    user_id: int | None = None
    endpoint: str = ""
    # Judge Attack toggles (admin-only; ignored unless DEMO_TOGGLES_ENABLED)
    simulate: set = field(default_factory=set)  # {"llm_down", "faiss_down", "db_down", "tool_timeout"}
    llm_calls: int = 0


_ctx: contextvars.ContextVar[RequestContext] = contextvars.ContextVar("rxguard_ctx", default=None)


def current() -> RequestContext:
    c = _ctx.get()
    if c is None:
        c = RequestContext()
        _ctx.set(c)
    return c


def set_context(c: RequestContext):
    return _ctx.set(c)


def reset_context(token):
    _ctx.reset(token)


def simulating(flag: str) -> bool:
    return flag in current().simulate
