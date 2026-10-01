"""Tamper-evident audit trail (spec section 17.2) - a per-prescription hash chain, not a blockchain.

hash = SHA-256(prev_hash + canonical JSON of the entry). verify() recomputes the chain and
reports the first sequence number whose stored hash or link no longer matches.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

from django.db import transaction

from engine import context

GENESIS = "0" * 64


def _clean(v):
    """JSON-stable payload: floats become strings so DB round-trips cannot change the hash."""
    if isinstance(v, float):
        return repr(round(v, 6))
    if isinstance(v, dict):
        return {str(k): _clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_clean(x) for x in v]
    if v is None or isinstance(v, (str, int, bool)):
        return v
    return str(v)


def canonical(entry: dict) -> str:
    return json.dumps(entry, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def entry_dict(prescription_id, seq, correlation_id, actor, event_type, entity, payload, kb_version, timestamp):
    return {"prescription_id": prescription_id, "seq": seq, "correlation_id": correlation_id, "actor": actor,
            "event_type": event_type, "entity": entity, "payload": payload, "kb_version": kb_version,
            "timestamp": timestamp}


def compute_hash(prev_hash: str, entry: dict) -> str:
    return hashlib.sha256((prev_hash + canonical(entry)).encode("utf-8")).hexdigest()


def append(prescription, event_type: str, entity: str, payload: dict, actor: str = "system"):
    from api.models import AuditLog, Prescription

    with transaction.atomic():
        Prescription.objects.select_for_update().filter(pk=prescription.pk).first()  # serialise appends
        last = AuditLog.objects.filter(prescription=prescription).order_by("-seq").first()
        seq = (last.seq + 1) if last else 1
        prev = last.hash if last else GENESIS
        ts = datetime.now(timezone.utc).isoformat(timespec="microseconds")
        clean = _clean(payload)
        kb = prescription.kb_version.label
        cid = context.current().correlation_id
        entry = entry_dict(prescription.pk, seq, cid, actor, event_type, entity, clean, kb, ts)
        return AuditLog.objects.create(prescription=prescription, seq=seq, correlation_id=cid, actor=actor,
                                       event_type=event_type, entity=entity, payload=clean, kb_version=kb,
                                       timestamp=ts, prev_hash=prev, hash=compute_hash(prev, entry))


def verify(prescription_id: int) -> dict:
    from api.models import AuditLog

    prev = GENESIS
    n = 0
    for row in AuditLog.objects.filter(prescription_id=prescription_id).order_by("seq"):
        n += 1
        expected_seq = n
        entry = entry_dict(row.prescription_id, row.seq, row.correlation_id, row.actor, row.event_type, row.entity,
                           row.payload, row.kb_version, row.timestamp)
        if row.seq != expected_seq or row.prev_hash != prev or compute_hash(prev, entry) != row.hash:
            return {"status": "TAMPERED", "first_broken_seq": row.seq, "entries_checked": n}
        prev = row.hash
    return {"status": "VALID", "entries_checked": n, "head_hash": prev}
