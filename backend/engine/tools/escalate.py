"""Tool 3 - escalate: raise a pharmacist-facing escalation record (spec section 9).

Escalations go to the pharmacist queue, never to a patient. The LLM can ADD an
escalation in follow-up Q&A but no code path lets it remove one.
"""
from __future__ import annotations

from engine import context
from engine.schemas import EscalationRequest


def escalate_many(items: list[dict], prescription_id: int | None = None, session_id: int | None = None,
                  created_by: str = "system") -> list[dict]:
    """Record several escalations in one call (one dedup query + one bulk insert).
    items: [{"reason_code", "trigger_rule_id", "detail"}]"""
    from api.models import Escalation

    reqs = [EscalationRequest(prescription_id=prescription_id, session_id=session_id, reason_code=i["reason_code"],
                              trigger_rule_id=i["trigger_rule_id"], detail=i["detail"][:500]) for i in items]
    existing = {(e.reason_code, e.trigger_rule_id, e.detail): e.id for e in Escalation.objects.filter(
        prescription_id=prescription_id, session_id=session_id)}
    cid = context.current().correlation_id
    new = [Escalation(prescription_id=prescription_id, session_id=session_id, reason_code=r.reason_code.value,
                      trigger_rule_id=r.trigger_rule_id, detail=r.detail, created_by=created_by, correlation_id=cid)
           for r in reqs if (r.reason_code.value, r.trigger_rule_id, r.detail) not in existing]
    Escalation.objects.bulk_create(new)
    ids = {(e.reason_code, e.trigger_rule_id, e.detail): e.id for e in Escalation.objects.filter(
        prescription_id=prescription_id, session_id=session_id)}
    return [{"escalation_id": ids[(r.reason_code.value, r.trigger_rule_id, r.detail)],
             "reason_code": r.reason_code.value} for r in reqs]


def escalate(reason_code: str, trigger_rule_id: str, detail: str, prescription_id: int | None = None,
             session_id: int | None = None, created_by: str = "system") -> dict:
    from api.models import Escalation

    req = EscalationRequest(prescription_id=prescription_id, session_id=session_id, reason_code=reason_code,
                            trigger_rule_id=trigger_rule_id, detail=detail[:500])
    existing = Escalation.objects.filter(prescription_id=prescription_id, session_id=session_id,
                                         reason_code=req.reason_code.value, trigger_rule_id=req.trigger_rule_id,
                                         detail=req.detail).first()
    if existing:
        return {"escalation_id": existing.id, "reason_code": existing.reason_code, "deduplicated": True}
    e = Escalation.objects.create(prescription_id=prescription_id, session_id=session_id,
                                  reason_code=req.reason_code.value, trigger_rule_id=req.trigger_rule_id,
                                  detail=req.detail, created_by=created_by,
                                  correlation_id=context.current().correlation_id)
    return {"escalation_id": e.id, "reason_code": e.reason_code, "deduplicated": False}
