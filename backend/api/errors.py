"""Uniform error schema: {"error": {"code", "message", "correlation_id", "details"?}}."""
import logging

from django.db import DatabaseError, InterfaceError, OperationalError
from django.http import Http404, JsonResponse
from pydantic import ValidationError
from rest_framework import exceptions as drf
from rest_framework.views import exception_handler as drf_handler

from engine import context
from engine.pipeline import FailClosed, InputRejected

log = logging.getLogger("rxguard.errors")


def error_response(status: int, code: str, message: str, details=None):
    body = {"error": {"code": code, "message": message, "correlation_id": context.current().correlation_id}}
    if details:
        body["error"]["details"] = details
    return JsonResponse(body, status=status)


def exception_handler(exc, ctx):
    if isinstance(exc, ValidationError):
        errs = [{"loc": ".".join(str(x) for x in e["loc"]), "msg": e["msg"]} for e in exc.errors()]
        msg = "No medications found in input" if any("No medications" in e["msg"] for e in errs) else "Invalid input"
        return error_response(400, "validation_error", msg, errs)
    if isinstance(exc, InputRejected):
        code = {413: "payload_too_large", 404: "not_found"}.get(exc.status, "validation_error")
        return error_response(exc.status, code, str(exc), exc.details)
    if isinstance(exc, (FailClosed, OperationalError, InterfaceError, DatabaseError)):
        log.error("fail_closed", extra={"reason": str(exc)[:300]})
        return error_response(503, "interaction_db_unavailable",
                              "Interaction database unavailable. No check performed.")
    if isinstance(exc, (Http404,)):
        return error_response(404, "not_found", "Not found")
    if isinstance(exc, drf.Throttled):
        return error_response(429, "throttled", "Too many requests", {"retry_after_s": exc.wait})
    if isinstance(exc, drf.APIException):
        resp = drf_handler(exc, ctx)
        code = getattr(exc, "default_code", "error")
        return error_response(resp.status_code if resp else 400, code, str(exc.detail) if hasattr(exc, "detail")
                              else str(exc))
    log.exception("unhandled_error")
    return error_response(500, "internal_error", "Internal error")


def handler404(request, exception=None):
    return error_response(404, "not_found", "Not found")


def handler500(request):
    return error_response(500, "internal_error", "Internal error")
