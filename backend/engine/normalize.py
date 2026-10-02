"""Drug identity resolution (spec section 10.2).

exact  : longest-match dictionary scan over normalised aliases, word boundaries only
fuzzy  : rapidfuzz ratio on the line's leading content tokens (>=92 with margin -> auto,
         80-92 -> candidates)
llm    : the LLM may only pick one of the offered candidate IDs, or none
else   : unresolved -> needs pharmacist confirmation; a CLEAR verdict becomes impossible
"""
from __future__ import annotations

import re
import threading
import unicodedata
from dataclasses import dataclass, field

from django.conf import settings
from rapidfuzz import fuzz, process

from engine import safety

_NON_ALNUM = re.compile(r"[^a-z0-9]+")
FORM_TOKENS = {
    "tab", "tabs", "tablet", "tablets", "cap", "caps", "capsule", "capsules", "syp", "syrup", "susp", "suspension",
    "inj", "injection", "oint", "ointment", "cream", "gel", "drops", "drop", "inh", "inhaler", "sachet", "lotion",
    "mg", "ml", "mcg", "g", "gm", "iu", "units", "od", "bd", "tds", "qid", "hs", "sos", "prn", "stat",
}
STOPWORDS = FORM_TOKENS | {
    "rx", "take", "give", "for", "days", "day", "weeks", "week", "after", "before", "food", "meals", "morning",
    "night", "daily", "once", "twice", "thrice", "times", "with", "and", "the", "of", "x", "orally", "oral",
    "po", "iv", "im", "sc", "sr", "er", "xr", "cr", "dt", "forte", "plus", "continue", "cont", "same", "tablet",
}
_STRENGTH = re.compile(r"\b\d+(\.\d+)?\s?(mg|ml|mcg|g|gm|iu|%)\b", re.I)
_RX_MARKER = re.compile(r"^\s*(rx\b|℞|\d{1,2}\s*[.)\]:-]|[-*•·]\s)", re.I)
_NOTE = re.compile(r"^\s*(note|notes|remarks?|complaints?|c/o|history|hx)\s*[:\-]", re.I)


def normalize_text(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return _NON_ALNUM.sub(" ", s.lower()).strip()


@dataclass
class Line:
    line_no: int
    text: str
    kind: str  # medication | note | suspicious | other


def classify_lines(text: str) -> list[Line]:
    out = []
    for i, raw in enumerate(text.splitlines(), start=1):
        t = raw.strip()
        if not t:
            continue
        if safety.injection_hits(t):
            kind = "suspicious"  # injected sentences never become drugs
        elif _NOTE.match(t):
            kind = "note"
        elif not content_tokens(t):
            kind = "other"  # e.g. a bare "Rx" header or "1." with nothing after it
        elif _RX_MARKER.match(t) or _STRENGTH.search(t) or (set(normalize_text(t).split()) & FORM_TOKENS):
            kind = "medication"
        else:
            kind = "other"
        out.append(Line(i, t, kind))
    return out


# ---------------------------------------------------------------- alias dictionary
@dataclass
class AliasEntry:
    alias: str
    tokens: tuple
    drug_ids: tuple  # one id for a molecule, several for a combination product
    drug_names: tuple
    product_id: int | None
    alias_type: str
    is_synthetic: bool


@dataclass
class AliasIndex:
    kb_label: str
    trie: dict = field(default_factory=dict)
    by_tokens: dict = field(default_factory=dict)  # token count -> (strings, entries)
    drug_names: dict = field(default_factory=dict)  # drug id -> generic name

    def add(self, e: AliasEntry):
        node = self.trie
        for tok in e.tokens:
            node = node.setdefault(tok, {})
        # longest/first-loaded wins on exact duplicates: generic names are loaded first
        node.setdefault("$", e)

    def finalize(self, entries: list[AliasEntry]):
        groups: dict[int, list[AliasEntry]] = {}
        for e in entries:
            groups.setdefault(min(len(e.tokens), 4), []).append(e)
        self.by_tokens = {k: ([" ".join(e.tokens) for e in v], v) for k, v in groups.items()}

    def scan(self, text: str) -> list[tuple[int, int, AliasEntry]]:
        """Longest non-overlapping alias matches as (start_tok, end_tok, entry)."""
        toks = normalize_text(text).split()
        i, hits = 0, []
        while i < len(toks):
            node, best, j = self.trie, None, i
            while j < len(toks) and toks[j] in node:
                node = node[toks[j]]
                j += 1
                if "$" in node:
                    best = (i, j, node["$"])
            if best:
                hits.append(best)
                i = best[1]
            else:
                i += 1
        return hits


_index_lock = threading.Lock()
_index_cache: dict[str, AliasIndex] = {}


def get_alias_index(kb) -> AliasIndex:
    with _index_lock:
        idx = _index_cache.get(kb.label)
        if idx is None:
            idx = build_alias_index(kb)
            _index_cache.clear()
            _index_cache[kb.label] = idx
        return idx


def build_alias_index(kb) -> AliasIndex:
    from api.models import Drug, DrugAlias, Product

    idx = AliasIndex(kb_label=kb.label)
    entries: list[AliasEntry] = []
    names = dict(Drug.objects.filter(kb_version=kb).values_list("id", "generic_name"))
    idx.drug_names = names
    for d_id, norm in Drug.objects.filter(kb_version=kb).values_list("id", "normalized_name"):
        entries.append(AliasEntry(names[d_id], tuple(norm.split()), (d_id,), (names[d_id],), None, "generic", False))
    for a in DrugAlias.objects.filter(kb_version=kb).values("alias", "alias_normalized", "drug_id", "alias_type",
                                                             "is_synthetic"):
        entries.append(AliasEntry(a["alias"], tuple(a["alias_normalized"].split()), (a["drug_id"],),
                                  (names[a["drug_id"]],), None, a["alias_type"], a["is_synthetic"]))
    for p in Product.objects.filter(kb_version=kb).prefetch_related("ingredients"):
        ids = tuple(pi.drug_id for pi in p.ingredients.all())
        entries.append(AliasEntry(p.brand_name, tuple(p.brand_normalized.split()), ids,
                                  tuple(names[i] for i in ids), p.id, "brand", p.is_synthetic))
    entries = [e for e in entries if e.tokens]
    for e in entries:
        idx.add(e)
    idx.finalize(entries)
    return idx


# ---------------------------------------------------------------- resolution
@dataclass
class Resolution:
    line_no: int
    raw_span: str
    matched_text: str = ""
    drug_id: int | None = None
    drug_name: str = ""
    product_id: int | None = None
    product_name: str = ""
    is_synthetic: bool = False
    method: str = "unresolved"
    confidence: float | None = None
    needs_confirmation: bool = False
    candidates: list = field(default_factory=list)  # [{"drug_id", "name", "score"}]

    def to_dict(self):
        return dict(self.__dict__)


def content_tokens(text: str) -> list[str]:
    return [t for t in normalize_text(text).split() if t not in STOPWORDS and not t.isdigit() and len(t) > 1
            and not re.fullmatch(r"\d+(mg|ml|mcg|g)?", t)]


def fuzzy_candidates(idx: AliasIndex, span: str, limit: int = 3) -> list[dict]:
    toks = content_tokens(span)
    if not toks or len(toks[0]) < 4 or not toks[0].isalpha():
        return []
    best: dict[int, dict] = {}
    for k, (strings, entries) in idx.by_tokens.items():
        if len(toks) < k:
            continue
        phrase = " ".join(toks[:k])
        for _s, score, pos in process.extract(phrase, strings, scorer=fuzz.ratio, limit=8):
            e = entries[pos]
            if len(e.drug_ids) != 1:
                continue  # fuzzy never resolves to a combination product
            d = e.drug_ids[0]
            if score > best.get(d, {}).get("score", -1):
                best[d] = {"drug_id": d, "name": idx.drug_names[d], "score": round(float(score), 1),
                           "matched_alias": e.alias}
    return sorted(best.values(), key=lambda c: -c["score"])[:limit]


def resolve_line(idx: AliasIndex, line: Line) -> list[Resolution]:
    """Deterministic stages only (exact, fuzzy). Ambiguous results carry candidates."""
    hits = idx.scan(line.text)
    out: list[Resolution] = []
    for _s, _e, entry in hits:
        for d_id, d_name in zip(entry.drug_ids, entry.drug_names):
            out.append(Resolution(
                line.line_no, line.text, matched_text=entry.alias, drug_id=d_id, drug_name=d_name,
                product_id=entry.product_id, product_name=entry.alias if entry.product_id else "",
                is_synthetic=entry.is_synthetic, method="exact", confidence=100.0))
    if out:
        return out
    return [fuzzy_resolve(idx, line.line_no, line.text, line.text)]


def fuzzy_resolve(idx: AliasIndex, line_no: int, raw_span: str, span: str) -> Resolution:
    auto = settings.RXGUARD["FUZZY_AUTO"]
    cand_min = settings.RXGUARD["FUZZY_CANDIDATE"]
    cands = fuzzy_candidates(idx, span)
    r = Resolution(line_no, raw_span, matched_text=span)
    if not cands or cands[0]["score"] < cand_min:
        r.needs_confirmation = True
        r.candidates = cands
        return r
    top = cands[0]
    margin = top["score"] - (cands[1]["score"] if len(cands) > 1 else 0)
    if top["score"] >= auto and margin >= 3:
        r.drug_id, r.drug_name = top["drug_id"], top["name"]
        r.method, r.confidence = "fuzzy", top["score"]
        r.matched_text = top["matched_alias"]
        return r
    r.candidates = [c for c in cands if c["score"] >= cand_min]
    r.needs_confirmation = True  # until the constrained LLM choice (or pharmacist) resolves it
    return r


def verbatim_spans(spans: list[str], line_text: str) -> list[str]:
    """Keep only spans that literally occur in the source line (case-insensitive)."""
    low = line_text.lower()
    return [s for s in spans if s.lower() in low]
