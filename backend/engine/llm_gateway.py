"""LLM gateway: per-query token cap, usage/cost logging, validation -> retry -> fallback chain.

Chain (spec 4.2): primary model (1 retry on schema failure, with the validation error)
-> fallback model (same) -> LlmUnavailable, and the caller switches to template mode.
Raw LLM text is never returned to callers - only validated Pydantic objects.
"""
from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from decimal import Decimal

from django.conf import settings
from pydantic import BaseModel, ValidationError

from engine import context
from engine.schemas import json_schema_for

log = logging.getLogger("rxguard.llm")


class LlmUnavailable(Exception):
    """Every model in the chain failed, or the per-query cap was reached. Use template mode."""


@dataclass
class Budget:
    """Per-query limits (spec 20.5). One Budget per /check, /explain or /ask request."""
    max_calls: int = field(default_factory=lambda: settings.RXGUARD["LLM_MAX_CALLS_PER_QUERY"])
    max_input_tokens: int = field(default_factory=lambda: settings.RXGUARD["LLM_MAX_INPUT_TOKENS_PER_QUERY"])
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    fallback_level: int = 0  # 0 primary, 1 fallback model, 2 template

    def to_dict(self):
        return dict(self.__dict__)


def prices() -> dict[str, tuple[Decimal, Decimal]]:
    out = {}
    for part in settings.RXGUARD["LLM_PRICES"].split(";"):
        if "=" in part:
            m, p = part.split("=", 1)
            i, o = p.split(":")
            out[m.strip()] = (Decimal(i), Decimal(o))
    return out


def estimate_cost(model: str, in_tok: int, out_tok: int) -> Decimal:
    p = prices().get(model)
    if not p:
        return Decimal(0)
    return (Decimal(in_tok) * p[0] + Decimal(out_tok) * p[1]) / Decimal(1_000_000)


def _client():
    import anthropic

    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise LlmUnavailable("ANTHROPIC_API_KEY not configured")
    return anthropic.Anthropic(api_key=key, timeout=settings.RXGUARD["LLM_TIMEOUT_S"], max_retries=0)


def _record(node, model, prompt_version, in_tok, out_tok, ms, level, status, error=""):
    from api.models import LlmCall

    cost = estimate_cost(model, in_tok, out_tok)
    ctx = context.current()
    ctx.llm_calls += 1
    try:
        LlmCall.objects.create(correlation_id=ctx.correlation_id, node=node, model=model,
                               prompt_version=prompt_version, input_tokens=in_tok, output_tokens=out_tok,
                               est_cost_usd=cost, latency_ms=ms, fallback_level=level, status=status,
                               error=error[:2000])
    except Exception:  # noqa: BLE001
        pass
    log.info("llm_call", extra={"node": node, "model": model, "input_tokens": in_tok, "output_tokens": out_tok,
                                "latency_ms": round(ms, 1), "cost_usd": str(cost), "fallback_level": level,
                                "status": status})


def _one_call(model: str, system: str, user: str, schema: dict, max_tokens: int):
    import anthropic

    kwargs = dict(model=model, max_tokens=max_tokens, system=system,
                  messages=[{"role": "user", "content": user}],
                  output_config={"format": {"type": "json_schema", "schema": schema}})
    if not model.startswith("claude-haiku"):
        # Short, bounded structured tasks: low effort keeps latency and spend down.
        kwargs["output_config"]["effort"] = "low"
    try:
        resp = _client().messages.create(**kwargs)
    except anthropic.APITimeoutError as e:
        return None, 0, 0, "timeout", str(e)
    except anthropic.RateLimitError as e:
        return None, 0, 0, "rate_limited", str(e)
    except anthropic.APIStatusError as e:
        return None, 0, 0, "api_error", f"{e.status_code}: {e.message}"
    except anthropic.APIConnectionError as e:
        return None, 0, 0, "api_error", str(e)
    in_tok, out_tok = resp.usage.input_tokens, resp.usage.output_tokens
    if resp.stop_reason == "refusal":
        return None, in_tok, out_tok, "refusal", "model declined"
    if resp.stop_reason == "max_tokens":
        return None, in_tok, out_tok, "schema_error", "output truncated at max_tokens"
    text = next((b.text for b in resp.content if b.type == "text"), "")
    return text, in_tok, out_tok, "ok", ""


def _mock_explanation(node, prompt, user, sleep_ms, budget):
    """LOAD-TEST ONLY (LLM_MOCK_SLEEP_MS): sleep like a provider call, then return the exact database claims.
    Isolates RxGuard's own overhead from provider latency (spec 20.4 run C). Never enable in normal operation."""
    from engine.schemas import ExplanationClaims

    time.sleep(sleep_ms / 1000)
    blocks = json.loads(user.split(":\n", 1)[1])
    claims = [{"claim_id": f"c{i}", "finding_ordinal": b["finding_ordinal"], "source_type": "DATABASE",
               "source_id": b["interaction_id"],
               "text": f"DDInter records {b['drug_a']} and {b['drug_b']} as a {b['severity']} interaction."}
              for i, b in enumerate(blocks, start=1)]
    budget.calls += 1
    _record(node, "mock", prompt.version_tag, 0, 0, sleep_ms, 0, "ok", "LLM_MOCK_SLEEP_MS")
    return ExplanationClaims.model_validate({"claims": claims}), {"model": "mock", "fallback_level": 0,
                                                                  "prompt_version": prompt.version_tag}


def call_structured(node: str, prompt, user: str, output_model: type[BaseModel], budget: Budget,
                    validation_context: dict | None = None) -> tuple[BaseModel, dict]:
    """Return (validated object, meta). Raises LlmUnavailable -> caller uses template mode."""
    from engine import prompts

    mock_ms = os.environ.get("LLM_MOCK_SLEEP_MS")
    if mock_ms and output_model.__name__ == "ExplanationClaims":
        return _mock_explanation(node, prompt, user, float(mock_ms), budget)
    if context.simulating("llm_down"):
        _record(node, "(simulated)", prompt.version_tag, 0, 0, 0, 0, "api_error", "simulated: LLM unavailable")
        budget.fallback_level = 2
        raise LlmUnavailable("simulated: LLM unavailable")
    prompts.register(prompt)
    schema = json_schema_for(output_model)
    chain = [settings.RXGUARD["LLM_PRIMARY_MODEL"], settings.RXGUARD["LLM_FALLBACK_MODEL"]]
    max_out = settings.RXGUARD["LLM_MAX_OUTPUT_TOKENS_PER_CALL"]
    last_error = ""
    for level, model in enumerate(chain):
        feedback = ""
        for attempt in range(2):  # first try + one retry carrying the validation error
            est_in = (len(prompt.system) + len(user) + len(feedback) + len(json.dumps(schema))) // 3
            if budget.calls >= budget.max_calls or budget.input_tokens + est_in > budget.max_input_tokens:
                _record(node, model, prompt.version_tag, 0, 0, 0, level, "cap_reached",
                        f"calls={budget.calls} input_tokens={budget.input_tokens} est_next={est_in}")
                budget.fallback_level = 2
                raise LlmUnavailable("per-query token/call cap reached")
            budget.calls += 1
            t0 = time.perf_counter()
            text, in_tok, out_tok, status, err = _one_call(model, prompt.system, user + feedback, schema, max_out)
            ms = (time.perf_counter() - t0) * 1000
            budget.input_tokens += in_tok
            budget.output_tokens += out_tok
            if status == "ok":
                try:
                    obj = output_model.model_validate_json(text, context=validation_context)
                    _record(node, model, prompt.version_tag, in_tok, out_tok, ms, level, "ok")
                    budget.fallback_level = max(budget.fallback_level, level)
                    return obj, {"model": model, "fallback_level": level, "prompt_version": prompt.version_tag}
                except ValidationError as e:
                    status, err = "schema_error", e.json(include_url=False)[:1500]
                    feedback = ("\n\nYour previous output failed validation with these errors; return corrected "
                                f"JSON only:\n{err}")
            _record(node, model, prompt.version_tag, in_tok, out_tok, ms, level, status, err)
            last_error = f"{model}: {status} {err[:200]}"
            if status != "schema_error":
                break  # API/timeout/refusal: go straight to the next model
    budget.fallback_level = 2
    raise LlmUnavailable(last_error or "all models failed")
