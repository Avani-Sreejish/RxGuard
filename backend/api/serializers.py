"""Response builders. The UI builds citations from these metadata fields, never from LLM text."""
from __future__ import annotations

from api.models import (AuditLog, Escalation, Explanation, InteractionFinding, KbVersion, PharmacistReview,
                        Prescription)
from engine import safety
from engine.tools.interaction_lookup import no_row_wording
from engine.triage import RULES


def _kb_current():
    kb = KbVersion.objects.filter(is_current=True).first()
    return kb.label if kb else None


def review_dict(r: PharmacistReview, current_kb: str | None):
    return {"id": r.id, "finding_id": r.finding_id, "duplication_id": r.duplication_id, "action": r.action,
            "note": r.note, "user": r.user.username, "kb_version_seen": r.kb_version_seen.label,
            "stale": current_kb is not None and r.kb_version_seen.label != current_kb,
            "created_at": r.created_at.isoformat()}


def chunk_card(chunk, score=None, span=""):
    d = chunk.document
    return {"chunk_id": chunk.id, "document": d.title, "doc_type": d.doc_type, "source": d.source,
            "version": d.version, "license": d.license, "url": d.url, "section": chunk.section_path,
            "page": chunk.page, "file_name": getattr(d, "file_name", "") or d.title,
            "text": chunk.text, "text_hash": chunk.text_hash, "score": score,
            "support_span": span, "label": "SOURCE TEXT (retrieved, not AI-generated)"}


def claim_dict(c):
    out = {"claim_id": c.claim_key, "text": c.text, "source_type": c.source_type, "kept": c.kept,
           "drop_reason": c.drop_reason, "support_score": c.support_score, "support_span": c.support_span,
           "finding_ordinal": c.finding.ordinal if c.finding_id else None,
           "badge": "DATABASE FACT" if c.source_type == "DATABASE" else "AI EXPLANATION — VERIFIED"}
    if c.interaction_id:
        i = c.interaction
        out["database_record"] = {"interaction_id": i.id, "drug_a": i.drug_a.generic_name,
                                  "drug_b": i.drug_b.generic_name, "severity": i.severity, "source": i.source,
                                  "source_record_id": i.source_record_id, "kb_version": i.kb_version.label}
    if c.chunk_id:
        out["chunk"] = chunk_card(c.chunk, span=c.support_span)
    if c.claim_key.startswith("t"):
        out["badge"] = "DATABASE FACT"
        out["generated_by"] = "template (no LLM)"
    return out


def finding_dict(f: InteractionFinding, current_kb, with_evidence=True):
    d = {"id": f.id, "ordinal": f.ordinal, "drug_a": f.drug_a_name, "drug_b": f.drug_b_name,
         "drug_a_id": f.drug_a_id, "drug_b_id": f.drug_b_id, "severity": f.severity,
         "severity_label": f"{f.severity} (as recorded in {f.source})", "source": f.source,
         "source_record_id": f.source_record_id, "interaction_id": f.interaction_id, "kb_version": f.kb_version.label,
         "priority": f.priority, "rule_id": f.rule_id, "rule_description": RULES[f.rule_id][1],
         "evidence_status": f.evidence_status, "review_status": f.review_status,
         "badge": "DATABASE FACT",
         "reviews": [review_dict(r, current_kb) for r in f.reviews.select_related("user", "kb_version_seen")]}
    if with_evidence:
        cards = []
        from api.models import ChunkDrugMention
        names = {f.drug_a_id: f.drug_a_name, f.drug_b_id: f.drug_b_name}
        for link in f.evidence.select_related("chunk__document"):
            if link.chunk_id:
                via = {names[d]: v for d, v in ChunkDrugMention.objects.filter(
                    chunk_id=link.chunk_id, drug_id__in=list(names)).values_list("drug_id", "via")}
                cards.append({**chunk_card(link.chunk, link.score), "retrieval_mode": link.retrieval_mode,
                              "matched_via": via})
        d["evidence"] = cards
        if f.evidence_status == "INSUFFICIENT":
            d["evidence_message"] = safety.INSUFFICIENT
        d["degraded_retrieval"] = any(link.retrieval_mode == "fulltext" for link in f.evidence.all())
    return d


def latest_explanation(p: Prescription):
    return p.explanations.order_by("-id").first()


def explanation_dict(e: Explanation | None):
    if e is None:
        return None
    claims = list(e.claims.select_related("finding", "interaction__drug_a", "interaction__drug_b",
                                         "interaction__kb_version", "chunk__document").order_by("id"))
    return {"id": e.id, "mode": e.mode, "model": e.model, "prompt_version": e.prompt_version,
            "fallback_level": e.fallback_level, "degraded_retrieval": e.degraded_retrieval,
            "correlation_id": e.correlation_id,
            "mode_badge": "TEMPLATE MODE (no LLM)" if e.mode == "template" else "AI EXPLANATION — VERIFIED",
            "claims": [claim_dict(c) for c in claims if c.kept],
            "dropped": [{"claim_id": c.claim_key, "reason": c.drop_reason,
                         "finding_ordinal": c.finding.ordinal if c.finding_id else None} for c in claims
                        if not c.kept]}


def escalation_dict(e: Escalation):
    return {"id": e.id, "reason_code": e.reason_code, "trigger_rule_id": e.trigger_rule_id, "detail": e.detail,
            "status": e.status, "created_by": e.created_by, "created_at": e.created_at.isoformat()}


def prescription_dict(p: Prescription, include_text=True):
    current_kb = _kb_current()
    items = list(p.items.select_related("drug", "product"))
    findings = list(p.findings.select_related("kb_version").prefetch_related("evidence"))
    flags = safety.precheck_prescription(p.raw_text, p.note, p.age_band)
    banners = []
    if p.injection_flag:
        banners.append({"kind": "INJECTION", "text": safety.INJECTION_BANNER, "patterns": p.injection_patterns})
    if flags.red_flags:
        banners.append({"kind": "RED_FLAG", "text": "Red-flag terms detected and escalated. Findings are still "
                                                    "shown.", "terms": flags.red_flags})
    if flags.dosing:
        banners.append({"kind": "DOSING", "text": safety.DOSING_REFUSAL})
    if flags.is_pediatric:
        banners.append({"kind": "PEDIATRIC", "text": "Pediatric signal. Escalated for pharmacist review."})
    unresolved = [i for i in items if i.drug_id is None and i.method != "pharmacist"]
    if unresolved:
        banners.append({"kind": "UNRESOLVED", "text": f"{len(unresolved)} item(s) could not be verified. "
                                                      f"Pharmacist confirmation required."})
    pairs = 0
    resolved_ids = sorted({i.drug_id for i in items if i.drug_id})
    pairs = len(resolved_ids) * (len(resolved_ids) - 1) // 2
    e = latest_explanation(p)
    return {
        "id": p.id, "session_id": p.session_id, "status": p.status, "priority": p.priority, "age_band": p.age_band,
        "note": p.note,
        "raw_text": p.raw_text if include_text else None, "correlation_id": p.correlation_id,
        "kb_version": p.kb_version.label, "current_kb_version": current_kb,
        "created_at": p.created_at.isoformat(), "injection_flag": p.injection_flag, "lines_ignored": p.lines_ignored,
        "synthetic_notice": "SYNTHETIC DEMO DATA",
        "items": [{"id": i.id, "line_no": i.line_no, "raw_span": i.raw_span, "matched_text": i.matched_text,
                   "drug_id": i.drug_id, "drug": i.drug.generic_name if i.drug_id else None,
                   "product": i.product.brand_name if i.product_id else None,
                   "is_synthetic": bool(i.product_id and i.product.is_synthetic), "method": i.method,
                   "confidence": i.confidence, "needs_confirmation": i.needs_confirmation,
                   "candidates": i.candidates,
                   "nlem_listed": i.drug.nlem_listed if i.drug_id else None} for i in items],
        "findings": [finding_dict(f, current_kb) for f in findings],
        "duplications": [{"id": d.id, "drug_id": d.drug_id, "drug": d.drug.generic_name, "items": d.items,
                          "item_labels": d.item_labels, "priority": "P2", "rule_id": "R8",
                          "reviews": [review_dict(r, current_kb) for r in d.reviews.select_related(
                              "user", "kb_version_seen")]}
                         for d in p.duplications.select_related("drug")],
        "rule_hits": [{"rule_id": h.rule_id, "priority": h.priority, "description": h.description,
                       "input": h.input_summary, "result": h.result} for h in p.rule_hits.all()],
        "escalations": [escalation_dict(x) for x in p.escalations.order_by("id")],
        "pairs_checked": pairs, "absent_pairs_count": pairs - len(findings),
        "absent_pairs_wording": no_row_wording(p.kb_version.label),
        "pairwise_notice": "DDInter is pairwise. This map makes no claim about combined effects of three or more "
                           "drugs.",
        "priority_notice": "Priority is a queue-ordering label, not a clinical risk score.",
        "banners": banners,
        "explanation": explanation_dict(e),
        "reviews": [review_dict(r, current_kb) for r in p.reviews.select_related("user", "kb_version_seen")],
        "llm_tokens_check": _check_tokens(p),
    }


def _check_tokens(p):
    from django.db.models import Sum

    from api.models import LlmCall
    agg = LlmCall.objects.filter(correlation_id=p.correlation_id).aggregate(i=Sum("input_tokens"),
                                                                             o=Sum("output_tokens"))
    return {"input": agg["i"] or 0, "output": agg["o"] or 0,
            "calls": LlmCall.objects.filter(correlation_id=p.correlation_id).exclude(model="(simulated)").count()}


def queue_row(p: Prescription):
    return {"id": p.id, "status": p.status, "priority": p.priority, "created_at": p.created_at.isoformat(),
            "interaction_count": p.findings.count(),
            "unresolved_count": p.items.filter(drug__isnull=True).exclude(method="pharmacist").count(),
            "escalation_count": p.escalations.count(),
            "reviewed_count": p.findings.exclude(review_status="pending").count(),
            "injection_flag": p.injection_flag, "kb_version": p.kb_version.label,
            "first_line": (p.raw_text.strip().splitlines() or [""])[0][:80]}


def audit_rows(p: Prescription, page: int, size: int):
    qs = AuditLog.objects.filter(prescription=p).order_by("seq")
    total = qs.count()
    rows = qs[(page - 1) * size: page * size]
    return {"total": total, "page": page, "page_size": size,
            "entries": [{"seq": a.seq, "event_type": a.event_type, "actor": a.actor, "entity": a.entity,
                         "payload": a.payload, "kb_version": a.kb_version, "timestamp": a.timestamp,
                         "correlation_id": a.correlation_id, "prev_hash": a.prev_hash, "hash": a.hash}
                        for a in rows]}
