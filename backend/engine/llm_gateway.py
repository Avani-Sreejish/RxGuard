"""LLM gateway: per-query token cap, usage/cost logging, validation -> retry -> fallback chain.

Chain (spec 4.2): primary model (1 retry on schema failure, with the validation error)
-> fallback model (same) -> LlmUnavailable, and the caller switches to template mode.
Raw LLM text is never returned to callers - only validated Pydantic objects.

Providers are chosen per model ID: "gemini-*" -> Google Gemini (GEMINI_API_KEY), anything else -> Anthropic
(ANTHROPIC_API_KEY). Both use JSON-schema structured output and the same validation, cap and logging.
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


def provider(model: str) -> str:
    return "gemini" if model.startswith("gemini") else "anthropic"


def _gemini_key() -> str | None:
    return os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")


def _has_key(model: str) -> bool:
    return bool(_gemini_key()) if provider(model) == "gemini" else bool(os.environ.get("ANTHROPIC_API_KEY"))


def configured() -> bool:
    """True if at least one model in the chain has an API key (used by readiness and the eval report)."""
    return any(_has_key(m) for m in (settings.RXGUARD["LLM_PRIMARY_MODEL"], settings.RXGUARD["LLM_FALLBACK_MODEL"]))


class _KeyMissing(Exception):
    pass


def _client():
    import anthropic

    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise _KeyMissing("ANTHROPIC_API_KEY not configured")
    return anthropic.Anthropic(api_key=key, timeout=settings.RXGUARD["LLM_TIMEOUT_S"], max_retries=0)


_gemini_client = None


def _gemini():
    global _gemini_client
    key = _gemini_key()
    if not key:
        raise _KeyMissing("GEMINI_API_KEY not configured")
    if _gemini_client is None:
        from google import genai
        from google.genai import types

        _gemini_client = genai.Client(api_key=key, http_options=types.HttpOptions(
            timeout=int(settings.RXGUARD["LLM_TIMEOUT_S"] * 1000), retry_options=types.HttpRetryOptions(attempts=1)))
    return _gemini_client


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
    """-> (text, input_tokens, output_tokens, status, error). Never raises for provider errors."""
    try:
        if provider(model) == "gemini":
            return _one_call_gemini(model, system, user, schema, max_tokens)
        return _one_call_anthropic(model, system, user, schema, max_tokens)
    except _KeyMissing as e:
        return None, 0, 0, "api_error", str(e)


_GEMINI_BLOCKED = {"SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY"}


def _one_call_gemini(model: str, system: str, user: str, schema: dict, max_tokens: int):
    import httpx
    from google.genai import errors, types

    cfg = dict(system_instruction=system, response_mime_type="application/json", response_json_schema=schema,
               max_output_tokens=max_tokens, temperature=0)
    level = settings.RXGUARD["LLM_GEMINI_THINKING_LEVEL"]
    if level and "lite" not in model:
        # Thinking tokens count toward max_output_tokens; "low" keeps latency and spend down.
        cfg["thinking_config"] = types.ThinkingConfig(thinking_level=level)
    try:
        resp = _gemini().models.generate_content(model=model, contents=user,
                                                 config=types.GenerateContentConfig(**cfg))
    except (httpx.TimeoutException, TimeoutError) as e:
        return None, 0, 0, "timeout", str(e)
    except errors.APIError as e:
        status = {429: "rate_limited", 504: "timeout"}.get(e.code, "api_error")
        return None, 0, 0, status, f"{e.code}: {str(e.message or e)[:500]}"
    except httpx.HTTPError as e:
        return None, 0, 0, "api_error", str(e)
    um = resp.usage_metadata
    in_tok = (um.prompt_token_count or 0) if um else 0
    out_tok = ((um.candidates_token_count or 0) + (um.thoughts_token_count or 0)) if um else 0
    if resp.prompt_feedback and resp.prompt_feedback.block_reason:
        return None, in_tok, out_tok, "refusal", f"prompt blocked: {resp.prompt_feedback.block_reason}"
    cand = resp.candidates[0] if resp.candidates else None
    reason = getattr(cand.finish_reason, "name", str(cand.finish_reason)) if cand and cand.finish_reason else ""
    if reason in _GEMINI_BLOCKED:
        return None, in_tok, out_tok, "refusal", f"finish_reason={reason}"
    if reason == "MAX_TOKENS":
        return None, in_tok, out_tok, "schema_error", "output truncated at max_output_tokens"
    return resp.text or "", in_tok, out_tok, "ok", ""


def _one_call_anthropic(model: str, system: str, user: str, schema: dict, max_tokens: int):
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
    if not any(_has_key(m) for m in chain):
        budget.fallback_level = 2
        needed = sorted({"GEMINI_API_KEY" if provider(m) == "gemini" else "ANTHROPIC_API_KEY" for m in chain})
        raise LlmUnavailable(f"no API key configured for the LLM chain (set {' or '.join(needed)})")
    max_out = settings.RXGUARD["LLM_MAX_OUTPUT_TOKENS_PER_CALL"]
    last_error = ""
    for level, model in enumerate(chain):
        if not _has_key(model):
            # A model without a key is skipped, not attempted: it must not use up the per-query call budget
            # or show up as an LLM call / fallback in the metrics.
            continue
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
