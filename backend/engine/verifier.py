"""Claim verifier (spec section 12.2). Checks run in order; the first failure drops the claim.

1 Exists       - the cited source ID exists
2 Whitelisted  - it was actually supplied to the model for this finding
3 DB exactness - a DATABASE claim names both drugs and the severity exactly as stored, and no
                 other severity words
4 Support      - a RAG claim's content words are sufficiently present in the chunk (>= threshold)
5 Scope        - no doses/amounts, no stop/switch/discontinue, no "safe", no treatment advice

Dropped claims are stored with their reason and never displayed.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from django.conf import settings

from engine import safety

SEVERITY_WORDS = {"major", "moderate", "minor", "unknown", "severe", "serious", "mild", "significant",
                  "dangerous", "life-threatening", "fatal", "contraindicated", "critical", "high-risk", "low-risk"}
_STOP = set("""a an the and or of to in on for with without by as at is are was were be been being it its this that
these those from into than then there their they them which who whom whose when where while can may might could
should would will shall do does did not no nor but if so such also both either each other any all some more most
less least very using used use per via about over under between within records recorded record ddinter database
interaction interactions drug drugs medicine medicines patient patients passage states says listed list""".split())
_TOKEN = re.compile(r"[a-z][a-z\-]+")


def _stem(w: str) -> str:
    return w[:5] if len(w) >= 6 else w


def content_words(text: str) -> list[str]:
    return [w for w in _TOKEN.findall(text.lower()) if len(w) >= 3 and w not in _STOP]


def support(claim: str, chunk_text: str) -> tuple[float, str]:
    """Share of the claim's content words found in the chunk (stem match), and the best supporting span."""
    words = content_words(claim)
    if not words:
        return 0.0, ""
    chunk_stems = {_stem(w) for w in content_words(chunk_text)}
    score = sum(1 for w in words if _stem(w) in chunk_stems) / len(words)
    # best supporting span: the chunk sentence/line with the most claim words
    target = {_stem(w) for w in words}
    best, best_n = "", 0
    for piece in re.split(r"(?<=[.;:])\s+|\n", chunk_text):
        n = len(target & {_stem(w) for w in content_words(piece)})
        if n > best_n:
            best, best_n = piece.strip(), n
    return round(score, 3), best[:400]


@dataclass
class Verdict:
    kept: bool
    reason: str = ""
    support_score: float | None = None
    support_span: str = ""


def verify_claim(claim, whitelist: dict, existing_interactions: set[int], existing_chunks: dict[int, str]) -> Verdict:
    """whitelist: {finding_ordinal: {"interaction_id", "drug_a", "drug_b", "severity", "chunk_ids": set}}"""
    wl = whitelist.get(claim.finding_ordinal)
    # 1 exists
    if claim.source_type == "DATABASE" and claim.source_id not in existing_interactions:
        return Verdict(False, "unsupported: cited database record does not exist")
    if claim.source_type == "RAG_CHUNK" and claim.source_id not in existing_chunks:
        return Verdict(False, "unsupported: cited chunk does not exist")
    # 2 whitelisted
    if wl is None:
        return Verdict(False, "not whitelisted: unknown finding")
    if claim.source_type == "DATABASE" and claim.source_id != wl["interaction_id"]:
        return Verdict(False, "not whitelisted: record was not supplied for this finding")
    if claim.source_type == "RAG_CHUNK" and claim.source_id not in wl["chunk_ids"]:
        return Verdict(False, "not whitelisted: chunk was not supplied for this finding")
    text_low = claim.text.lower()
    # 3 DB exactness
    if claim.source_type == "DATABASE":
        for name in (wl["drug_a"], wl["drug_b"]):
            if name.lower() not in text_low:
                return Verdict(False, f"db mismatch: drug name '{name}' not stated as stored")
        sev = wl["severity"].lower()
        if not re.search(rf"\b{re.escape(sev)}\b", text_low):
            return Verdict(False, f"db mismatch: severity '{wl['severity']}' not stated as stored")
        others = [w for w in SEVERITY_WORDS - {sev} if re.search(rf"\b{re.escape(w)}\b", text_low)]
        if others:
            return Verdict(False, f"db mismatch: extra severity words {sorted(others)}")
        score, span = None, ""
    # 4 support
    else:
        score, span = support(claim.text, existing_chunks[claim.source_id])
        if score < settings.RXGUARD["SUPPORT_THRESHOLD"]:
            return Verdict(False, f"unsupported: support {score:.2f} below threshold", score, span)
    # 5 scope
    bad = safety.scope_violations(claim.text)
    if bad:
        return Verdict(False, f"out of scope: {bad}", score, span)
    return Verdict(True, "", score, span)
