"""Human-in-the-loop (spec section 14). Only a pharmacist can act; the AI cannot approve, reject or close.

A prescription cannot reach REVIEWED until every P1 finding has a recorded pharmacist action
and every unresolved item has been confirmed (or marked "not in database").
"""
from __future__ import annotations

from django.db import transaction

from engine import audit, context, triage
from engine.tools import escalate as tool3
from engine.tools import interaction_lookup as tool1
from engine.tools.base import run_tool

ACTION_STATUS = {"ACKNOWLEDGE": "acknowledged", "ESCALATE": "escalated",
                 "REQUEST_MORE_EVIDENCE": "more_evidence_requested", "MARK_FOR_FOLLOW_UP": "follow_up"}


class GateNotMet(Exception):
    def __init__(self, reasons):
        super().__init__("; ".join(reasons))
        self.reasons = reasons


def record_review(user, prescription, action: str, note: str, finding=None, duplication=None):
    from api.models import KbVersion, PharmacistReview, Prescription

    kb_seen = prescription.kb_version  # the version whose facts the pharmacist is looking at
    with transaction.atomic():
        r = PharmacistReview.objects.create(prescription=prescription, finding=finding, duplication=duplication,
                                            user=user, action=action, note=note, kb_version_seen=kb_seen,
                                            correlation_id=context.current().correlation_id)
        if finding is not None:
            finding.review_status = ACTION_STATUS[action]
            finding.save(update_fields=["review_status"])
        if prescription.status in ("AWAITING_PHARMACIST", "CHECKED", "EXPLAINED", "CLEAR"):
            Prescription.objects.filter(pk=prescription.pk).update(status="IN_REVIEW")
    if action == "ESCALATE":
        target = f"finding {finding.ordinal}" if finding else f"duplicate {duplication.drug.generic_name}"
        run_tool("escalate", tool3.escalate, dict(reason_code="MAJOR_INTERACTION" if finding and
                                                  finding.severity == "Major" else "CONFLICT",
                                                  trigger_rule_id="MANUAL",
                                                  detail=f"Pharmacist escalated {target}: {note[:300]}",
                                                  prescription_id=prescription.id, created_by=f"user:{user.id}"))
    current = KbVersion.objects.filter(is_current=True).first()
    audit.append(prescription, "pharmacist_action", f"finding:{finding.id}" if finding else
                 f"duplication:{duplication.id}", {
                     "action": action, "note": note, "kb_version_seen": kb_seen.label,
                     "current_kb_version": current.label if current else None,
                     "finding_ordinal": finding.ordinal if finding else None}, actor=f"user:{user.id}")
    return r


def gate_reasons(prescription) -> list[str]:
    reasons = []
    for f in prescription.findings.all():
        if f.priority == "P1" and not f.reviews.exists():
            reasons.append(f"P1 finding {f.ordinal} ({f.drug_a_name} + {f.drug_b_name}) has no pharmacist action")
        if f.review_status == "follow_up":
            reasons.append(f"finding {f.ordinal} is marked for follow-up")
    for i in prescription.items.filter(drug__isnull=True).exclude(method="pharmacist"):
        reasons.append(f"line {i.line_no} ('{i.raw_span[:60]}') is unresolved and needs confirmation")
    return reasons


def complete_review(user, prescription):
    from api.models import Prescription

    reasons = gate_reasons(prescription)
    if reasons:
        raise GateNotMet(reasons)
    Prescription.objects.filter(pk=prescription.pk).update(status="REVIEWED")
    audit.append(prescription, "final_state", "prescription", {"status": "REVIEWED", "by": f"user:{user.id}"},
                 actor=f"user:{user.id}")


def confirm_item(user, prescription, item, drug=None, not_in_database=False):
    """Pharmacist confirms an unresolved line. A confirmed drug is re-checked against Tool 1."""
    from api.models import InteractionFinding, TriageRuleHit

    new_findings = []
    with transaction.atomic():
        if not_in_database:
            item.method, item.needs_confirmation = "pharmacist", False
            item.matched_text = "(marked not in database by pharmacist)"
            item.save()
        else:
            item.drug, item.method, item.needs_confirmation, item.confidence = drug, "pharmacist", False, None
            item.matched_text = drug.generic_name
            item.save()
    audit.append(prescription, "item_confirmed", f"prescription_item:{item.id}", {
        "line": item.line_no, "drug": drug.generic_name if drug else None, "not_in_database": not_in_database},
        actor=f"user:{user.id}")
    if drug is not None:
        items = list(prescription.items.all())
        resolved = [(n, i.drug_id) for n, i in enumerate(items) if i.drug_id]
        res = run_tool("interaction_lookup", tool1.lookup,
                       dict(drug_ids=[d for _, d in resolved], kb_id=prescription.kb_version_id,
                            kb_label=prescription.kb_version.label, item_drugs=resolved),
                       summarize=tool1.summarize)
        existing = set(prescription.findings.values_list("interaction_id", flat=True))
        next_ord = (prescription.findings.count() or 0) + 1
        for f in res["findings"]:
            if f["interaction_id"] in existing:
                continue
            rule = triage.SEVERITY_RULE[f["severity"]]
            nf = InteractionFinding.objects.create(
                prescription=prescription, ordinal=next_ord, interaction_id=f["interaction_id"],
                drug_a_id=f["drug_a_id"], drug_b_id=f["drug_b_id"], drug_a_name=f["drug_a"], drug_b_name=f["drug_b"],
                severity=f["severity"], source=f["source"], source_record_id=f["source_record_id"],
                kb_version_id=prescription.kb_version_id, priority=triage.RULES[rule][0], rule_id=rule)
            TriageRuleHit.objects.create(prescription=prescription, rule_id=rule, priority=nf.priority,
                                         description=triage.RULES[rule][1],
                                         input_summary=f"finding {nf.ordinal} (after pharmacist confirmation)",
                                         result=nf.priority)
            new_findings.append(nf)
            next_ord += 1
        if new_findings:
            prescription.priority = triage.best([prescription.priority] + [f.priority for f in new_findings])
            prescription.save(update_fields=["priority"])
        audit.append(prescription, "lookup_performed", "interaction_findings", {
            "trigger": "pharmacist_confirmation", "new_findings": [f.ordinal for f in new_findings]})
    return new_findings
