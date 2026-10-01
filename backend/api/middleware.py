"""Correlation IDs + request logging (spec 20.2). Every response carries X-Request-ID."""
import logging
import re
import time

from django.conf import settings

from engine import context

log = logging.getLogger("rxguard.request")
_VALID_ID = re.compile(r"^[A-Za-z0-9\-_.]{8,64}$")
_ID_IN_PATH = re.compile(r"/\d+(?=/|$)")


class CorrelationIdMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        incoming = request.headers.get("X-Request-ID", "")
        ctx = context.RequestContext()
        if _VALID_ID.match(incoming):
            ctx.correlation_id = incoming
        ctx.endpoint = _ID_IN_PATH.sub("/{id}", request.path)
        sim = request.headers.get("X-RxGuard-Simulate", "")
        if sim and settings.RXGUARD["DEMO_TOGGLES_ENABLED"]:
            ctx.simulate = {s.strip() for s in sim.split(",") if s.strip()}  # admin check happens in the view
        request.correlation_id = ctx.correlation_id
        token = context.set_context(ctx)
        t0 = time.perf_counter()
        try:
            response = self.get_response(request)
        finally:
            ms = (time.perf_counter() - t0) * 1000
        response["X-Request-ID"] = ctx.correlation_id
        user = getattr(request, "user", None)
        uid = user.id if user is not None and getattr(user, "is_authenticated", False) else None
        if request.path.startswith("/api/"):
            try:
                from api.models import RequestLog
                RequestLog.objects.create(correlation_id=ctx.correlation_id, endpoint=ctx.endpoint,
                                          method=request.method, status_code=response.status_code, latency_ms=ms,
                                          user_id=uid, llm_calls=ctx.llm_calls)
            except Exception:  # noqa: BLE001 - DB may be down; the JSON log line below still records it
                pass
        log.info("request", extra={"endpoint": ctx.endpoint, "method": request.method, "status": response.status_code,
                                   "latency_ms": round(ms, 1), "user_id": uid, "llm_calls": ctx.llm_calls})
        context.reset_context(token)
        return response
