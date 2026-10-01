"""Deterministic safety rules (spec sections 4, 15, 16).

Every rule here runs before any LLM call and cannot be suppressed by the LLM.
Pattern lists are team-curated and deliberately conservative; they can miss unusual
phrasings (documented as a known limitation).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# Red-flag terms: emergency presentations listed as danger signs / referral triggers in the
# ICMR STWs used in the corpus (e.g. GI bleed, stroke, fever in children, acute respiratory infections).
RED_FLAG_TERMS = [
    r"chest pain", r"breathing difficult\w*", r"difficulty (in )?breathing", r"short(ness)? of breath", r"breathless\w*",
    r"seizures?", r"convulsions?", r"fits", r"unconscious\w*", r"loss of consciousness", r"unresponsive",
    r"heavy bleeding", r"severe bleeding", r"bleeding heavily", r"vomiting blood", r"blood in (vomit|stool)",
    r"black(,)? tarry stools?", r"melena", r"haematemesis", r"hematemesis", r"altered sensorium", r"confus(ed|ion)",
    r"slurred speech", r"facial droop", r"weakness (of|on) one side", r"suicid\w*", r"self[- ]harm",
    r"anaphyla\w*", r"swelling of (the )?(face|lips|tongue|throat)", r"severe allergic",
    r"stiff neck", r"not feeding", r"lethargic", r"blue lips", r"cyanosis",
    # very high temperature (>= 104 F / 40 C): escalate, never interpret
    r"\b10[4-9](\.\d)?\s*(°|deg(rees?)?)?\s*f\b", r"\b4[0-2](\.\d)?\s*(°|deg(rees?)?)?\s*c\b",
    # Hindi / Malayalam transliterations (common forms)
    r"seene mein dard", r"saans (lene )?mein (taklif|dikkat)", r"behosh", r"daura", r"khoon (ki )?ulti",
    r"nenju vedana", r"shwasam mutt\w*", r"bodham (poyi|illa)", r"apasmaram", r"chora chardi",
]

# Request-shaped dosing patterns: applied to prescription notes AND questions.
DOSING_PATTERNS = [
    r"\bhow (much|many)\b", r"\bwhat (dose|dosage)\b", r"\bhow often\b",
    r"\bmg ?/ ?kg\b", r"\bhow many (tablets|tabs|ml|mg|spoons?)\b", r"\bcan (i|he|she|they) (take|give)\b",
    r"\bmaximum (dose|amount)\b", r"\bincrease\b.*\b(dose|tablet)", r"\bdouble the\b",
    r"\bkitna (dena|lena|dose)\b", r"\bkitni (goli|dawa)\b", r"\bethra (kodukkanam|kazhikkanam)\b",
]

PEDIATRIC_TERMS = [
    r"\bchild(ren)?\b", r"\bkid\b", r"\binfant\b", r"\bbaby\b", r"\btoddler\b", r"\bnewborn\b", r"\bneonat\w*",
    r"\bpaediatric\b", r"\bpediatric\b", r"\b\d{1,2}[- ]?(year|yr|month|mo)s?[- ]?old\b", r"\bmy (son|daughter)\b",
    r"\bbachcha\b", r"\bbachche\b", r"\bkunju\b", r"\bkutti\b",
]

INJECTION_PATTERNS = [
    r"ignore (all |any |the )?(previous|prior|above|earlier) (instructions?|rules?|prompts?)",
    r"disregard (all |any |the )?(previous|prior|above|earlier|safety)?\s*(instructions?|rules?|prompts?)?",
    r"\bsystem (message|prompt)\b", r"\bdeveloper (message|mode|prompt)\b", r"\byou are now\b",
    r"\bmark (it |this |them |all |everything )?(as )?safe\b", r"\bno interactions?\b", r"\boverride\b",
    r"\bact as\b", r"\bjailbreak\b", r"\bpretend (to be|you are)\b", r"\bnew instructions?\b",
    r"\bdo not (flag|report|escalate)\b", r"\breturn (clear|safe)\b", r"</?(system|assistant|user)>",
    r"\bassistant:\s", r"\bforget (everything|your instructions)\b",
]

DECISION_PATTERNS = [
    r"\b(is it |it'?s )?(fine|ok|okay|safe) to dispense\b", r"\bjust tell me\b.*\b(fine|ok|okay|safe)\b",
    r"\bapprove\b", r"\breject (the|this) prescription\b", r"\bshould i (dispense|give|stop|switch)\b",
    r"\bcan i dispense\b", r"\bsign off\b", r"\bclose (the|this) case\b",
]

# Any mention of dosing inside a question to RxGuard counts (a note like "continue same dose" does not).
# ("dosage form(s)" is a listing question - e.g. "which dosage forms are in NLEM" - not a dosing request)
QUESTION_DOSING_PATTERNS = DOSING_PATTERNS + [r"\b(dose|dosage|dosing)\b(?!\s+forms?\b)", r"\bmg\b"]

_c = lambda pats: [re.compile(p, re.I) for p in pats]  # noqa: E731
_RED, _DOSE, _QDOSE, _PED, _INJ, _DEC = map(_c, (RED_FLAG_TERMS, DOSING_PATTERNS, QUESTION_DOSING_PATTERNS,
                                                PEDIATRIC_TERMS, INJECTION_PATTERNS, DECISION_PATTERNS))

DOSING_REFUSAL = "RxGuard does not provide dosing. Refer to the prescriber and official references."
DECISION_REFUSAL = "RxGuard can't make dispensing decisions. Here is the evidence; the decision is yours."
INJECTION_BANNER = "Suspicious instructions detected in document; ignored."
INSUFFICIENT = "Insufficient evidence retrieved. Pharmacist review required."


def _hits(regs, text: str) -> list[str]:
    return sorted({m.group(0).strip().lower() for r in regs for m in [r.search(text or "")] if m})


def injection_hits(text: str) -> list[str]:
    return _hits(_INJ, text)


@dataclass
class SafetyFlags:
    red_flags: list[str] = field(default_factory=list)
    dosing: list[str] = field(default_factory=list)
    pediatric: list[str] = field(default_factory=list)
    injection: list[str] = field(default_factory=list)
    decision: list[str] = field(default_factory=list)
    age_band_pediatric: bool = False

    @property
    def is_pediatric(self):
        return bool(self.pediatric) or self.age_band_pediatric

    def to_dict(self):
        return {**self.__dict__, "is_pediatric": self.is_pediatric}


def precheck_prescription(text: str, note: str, age_band: str) -> SafetyFlags:
    """Node 2 (safety_precheck). Red flags are read from the note and free-text lines;
    injection patterns from the whole document."""
    f = SafetyFlags()
    f.red_flags = _hits(_RED, note) + [h for h in _hits(_RED, text) if h not in _hits(_RED, note)]
    f.injection = injection_hits(text) + [h for h in injection_hits(note) if h not in injection_hits(text)]
    f.dosing = _hits(_DOSE, note)
    f.pediatric = _hits(_PED, note)
    f.age_band_pediatric = age_band == "<12"
    return f


def precheck_question(question: str) -> SafetyFlags:
    f = SafetyFlags()
    f.red_flags = _hits(_RED, question)
    f.dosing = _hits(_QDOSE, question)
    f.pediatric = _hits(_PED, question)
    f.injection = injection_hits(question)
    f.decision = _hits(_DEC, question)
    return f


# Verifier scope check (spec 12.2 step 5): claims may not carry doses or treatment advice.
_SCOPE = [re.compile(p, re.I) for p in (
    r"\b\d+(\.\d+)?\s?(mg|mcg|µg|g|ml|iu|units?)\b", r"\b(stop|switch|discontinue|withhold|replace|substitute)\w*\b",
    r"\bsafe to (dispense|give|use|take)\b", r"\b(is|are) safe\b", r"\bno (risk|interaction)s?\b",
    r"\b(increase|decrease|reduce|adjust|titrate)\w* (the )?dose\b", r"\b(recommend|should (take|use|start|receive))\b",
    r"\b(dose|dosage|dosing)\b", r"\bprescribe\w*\b", r"\bdiagnos\w*\b",
)]


def scope_violations(text: str) -> list[str]:
    return sorted({m.group(0).lower() for r in _SCOPE for m in [r.search(text)] if m})
