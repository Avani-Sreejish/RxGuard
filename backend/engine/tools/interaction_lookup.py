"""Tool 1 - interaction_lookup: the ONLY source of interaction facts (spec section 9).

One SQL query checks every pair in the prescription. Read-only. Absence of a row is
reported as a count and worded "No interaction recorded in DDInter <version>" - never "safe".
"""
from __future__ import annotations

import threading
from collections import OrderedDict
from itertools import combinations

from django.db import OperationalError

from engine import context
from engine.schemas import DuplicationFact, InteractionFact, InteractionResult

_cache: OrderedDict = OrderedDict()
_cache_lock = threading.Lock()
_CACHE_MAX = 2048


def no_row_wording(kb_label: str) -> str:
    return f"No interaction recorded in DDInter ({kb_label})"


def lookup(drug_ids: list[int], kb_id: int, kb_label: str, item_drugs: list[tuple[int, int]] | None = None) -> dict:
    """drug_ids: resolved molecule IDs. item_drugs: (item_index, drug_id) for duplication."""
    from api.models import DrugInteraction

    if context.simulating("db_down"):
        raise OperationalError("simulated: interaction database unavailable")
    ids = sorted(set(drug_ids))
    key = (tuple(ids), kb_id)
    with _cache_lock:
        cached = _cache.get(key)
    if cached is None:
        rows = (DrugInteraction.objects.filter(kb_version_id=kb_id, drug_a_id__in=ids, drug_b_id__in=ids)
                .select_related("drug_a", "drug_b").order_by("drug_a__generic_name", "drug_b__generic_name"))
        facts = [InteractionFact(interaction_id=r.id, drug_a_id=r.drug_a_id, drug_b_id=r.drug_b_id,
                                 drug_a=r.drug_a.generic_name, drug_b=r.drug_b.generic_name, severity=r.severity,
                                 source=r.source, source_record_id=r.source_record_id, kb_version=kb_label)
                 for r in rows]
        cached = [f.model_dump() for f in facts]
        with _cache_lock:
            _cache[key] = cached
            if len(_cache) > _CACHE_MAX:
                _cache.popitem(last=False)
    pairs = len(list(combinations(ids, 2)))

    dup: dict[int, list[int]] = {}
    for item_idx, d in item_drugs or []:
        dup.setdefault(d, []).append(item_idx)
    dups = [DuplicationFact(drug_id=d, drug="", item_indexes=sorted(v)) for d, v in dup.items() if len(v) > 1]

    result = InteractionResult(kb_version=kb_label, pairs_checked=pairs,
                               findings=[InteractionFact(**f) for f in cached], duplications=dups,
                               absent_pairs_count=pairs - len(cached))
    return result.model_dump()


def summarize(r: dict) -> str:
    sev = {}
    for f in r["findings"]:
        sev[f["severity"]] = sev.get(f["severity"], 0) + 1
    return (f"kb={r['kb_version']} pairs={r['pairs_checked']} findings={len(r['findings'])} {sev} "
            f"duplications={len(r['duplications'])} absent={r['absent_pairs_count']}")


def clear_cache():
    with _cache_lock:
        _cache.clear()
