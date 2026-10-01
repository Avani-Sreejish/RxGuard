"""Interaction map + rule-based triage (spec section 13).

Priority is a queue-ordering label, not a clinical risk score. DDInter is pairwise;
the map makes no claim about combined effects of three or more drugs.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

RULES = {
    "R1": ("P1", "Major severity recorded"),
    "R2": ("P1", "Red-flag term in note"),
    "R3": ("P1", "Pediatric signal or dosing request"),
    "R4": ("P1", "Unresolved drug"),
    "R5": ("P1", "Suspicious instructions in document"),
    "R6": ("P2", "Moderate severity recorded"),
    "R7": ("P2", "Hub drug (>=2 documented interactions)"),
    "R8": ("P2", "Duplicate ingredient"),
    "R9": ("P3", "Minor or Unknown severity only"),
}
RANK = {"P1": 1, "P2": 2, "P3": 3, "CLEAR": 4}
SEVERITY_RULE = {"Major": "R1", "Moderate": "R6", "Minor": "R9", "Unknown": "R9"}


@dataclass
class RuleHit:
    rule_id: str
    input_summary: str
    result: str

    @property
    def priority(self):
        return RULES[self.rule_id][0]

    @property
    def description(self):
        return RULES[self.rule_id][1]

    def to_dict(self):
        return {"rule_id": self.rule_id, "priority": self.priority, "description": self.description,
                "input_summary": self.input_summary, "result": self.result}


def best(priorities) -> str:
    return min(priorities, key=lambda p: RANK[p], default="CLEAR")


def triage(findings: list[dict], duplications: list[dict], unresolved: list[dict], flags: dict) -> dict:
    """findings: [{ordinal, drug_a_id, drug_b_id, drug_a, drug_b, severity}] (mutated: priority, rule_id).

    Returns {"priority", "hits": [RuleHit], "hubs": [drug_id], "finding_priority": {ordinal: (prio, rule)}}.
    """
    hits: list[RuleHit] = []

    degree = Counter()
    for f in findings:
        degree[f["drug_a_id"]] += 1
        degree[f["drug_b_id"]] += 1
    hubs = sorted(d for d, n in degree.items() if n >= 2)

    for f in findings:
        rule = SEVERITY_RULE[f["severity"]]
        prio = RULES[rule][0]
        if rule == "R9" and (f["drug_a_id"] in hubs or f["drug_b_id"] in hubs):
            prio, rule = "P2", "R7"
        f["priority"], f["rule_id"] = prio, rule
        if rule in ("R1", "R6"):
            hits.append(RuleHit(rule, f"finding {f['ordinal']}: {f['drug_a']} + {f['drug_b']}, "
                                      f"severity {f['severity']} (as recorded)", f"{prio} for finding {f['ordinal']}"))

    names = {}
    for f in findings:
        names[f["drug_a_id"]], names[f["drug_b_id"]] = f["drug_a"], f["drug_b"]
    for h in hubs:
        hits.append(RuleHit("R7", f"{names[h]} appears in {degree[h]} documented interactions", "P2 (hub drug)"))
    for d in duplications:
        hits.append(RuleHit("R8", f"{d['drug']} present in items {d['item_labels']}", "P2 (duplicate ingredient)"))
    for u in unresolved:
        hits.append(RuleHit("R4", f"line {u['line_no']}: '{u['raw_span'][:80]}'", "P1 (needs confirmation)"))
    if flags.get("red_flags"):
        hits.append(RuleHit("R2", f"terms: {', '.join(flags['red_flags'])}", "P1 (red flag escalated)"))
    if flags.get("is_pediatric") or flags.get("dosing"):
        what = []
        if flags.get("is_pediatric"):
            what.append("pediatric signal" + (f" ({', '.join(flags['pediatric'])})" if flags.get("pediatric") else
                                              " (age band <12)"))
        if flags.get("dosing"):
            what.append(f"dosing request ({', '.join(flags['dosing'])})")
        hits.append(RuleHit("R3", "; ".join(what), "P1"))
    if flags.get("injection"):
        hits.append(RuleHit("R5", f"patterns: {', '.join(flags['injection'])}", "P1 (instructions ignored)"))

    only_low = findings and all(f["severity"] in ("Minor", "Unknown") for f in findings)
    if only_low:
        hits.append(RuleHit("R9", f"{len(findings)} finding(s), all Minor/Unknown as recorded", "P3"))

    priority = best([h.priority for h in hits] + [f["priority"] for f in findings])
    return {"priority": priority, "hits": hits, "hubs": hubs}
