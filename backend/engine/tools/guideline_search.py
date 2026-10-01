"""Tool 2 - guideline_search: supporting evidence from the curated corpus (spec 9, 11).

Returns documents only; generates nothing. Pipeline:
drug prefilter (chunk_drug_mentions) -> FAISS -> score threshold -> one deterministic
query-expansion retry -> INSUFFICIENT. FAISS failure -> MySQL FULLTEXT, marked degraded.
"""
from __future__ import annotations

import logging
import re

from django.conf import settings
from django.db import connection

from engine import retrieval
from engine.schemas import ChunkOut, EvidenceResult

log = logging.getLogger("rxguard.tools")


def _chunk_out(c, score: float) -> ChunkOut:
    d = c.document
    return ChunkOut(chunk_id=c.id, document=d.title, doc_type=d.doc_type, source=d.source, version=d.version,
                    section=c.section_path[:300], page=c.page, license=d.license[:300], text=c.text,
                    text_hash=c.text_hash, score=round(score, 4))


def _expansion_terms(drug_ids: list[int]) -> str:
    from api.models import Drug, DrugAlias

    names = list(Drug.objects.filter(id__in=drug_ids).values_list("generic_name", flat=True))
    names += list(DrugAlias.objects.filter(drug_id__in=drug_ids, is_synthetic=False)
                  .exclude(alias_type="misspelling").values_list("alias", flat=True)[:12])
    return " ".join(dict.fromkeys(names))


def expansion_query(query: str, drug_ids: list[int]) -> str:
    """The one deterministic query-expansion retry: add the drugs' names and non-synthetic aliases."""
    return f"{query} {_expansion_terms(drug_ids)}"


def _mentions(base, drug_ids) -> dict[int, dict]:
    from api.models import ChunkDrugMention

    per_chunk: dict[int, dict] = {}
    for cid, did, via in ChunkDrugMention.objects.filter(drug_id__in=drug_ids, chunk__in=base).values_list(
            "chunk_id", "drug_id", "via"):
        per_chunk.setdefault(cid, {})[did] = via
    return per_chunk


def covers_all(m: dict, drug_ids) -> bool:
    """Every drug mentioned, and not all of them only through one shared class term
    (a chunk saying "NSAIDs" once is not evidence about an aspirin + ibuprofen pair)."""
    vias = set(m.values())
    return set(m) >= set(drug_ids) and not (len(drug_ids) > 1 and len(vias) == 1 and
                                            next(iter(vias)).startswith("class:"))


def pairs_with_candidates(kb_id: int, pairs: list[tuple[int, int]]) -> set[tuple[int, int]]:
    """One query: which drug pairs have at least one chunk that could be evidence (used to skip embedding the rest)."""
    from api.models import CorpusChunk

    ids = sorted({d for p in pairs for d in p})
    per_chunk = _mentions(CorpusChunk.objects.filter(document__kb_version_id=kb_id), ids)
    return {p for p in pairs if any(covers_all(m, p) for m in per_chunk.values())}


def guideline_search(kb_id: int, kb_label: str, drug_ids: list[int], query: str, k: int = 3,
                     require_all: bool = False, doc_types: list[str] | None = None,
                     query_vector: list[float] | None = None,
                     expansion_vector: list[float] | None = None) -> dict:
    """require_all=True restricts to chunks that mention every drug; doc_types limits the documents
    (e.g. ["NLEM"] for listing / dosage-form / level-of-care questions)."""
    from api.models import ChunkDrugMention, CorpusChunk

    k = max(1, min(k, 5))
    threshold = settings.RXGUARD["RETRIEVAL_MIN_SCORE"]
    base = CorpusChunk.objects.filter(document__kb_version_id=kb_id)
    if doc_types:
        base = base.filter(document__doc_type__in=doc_types)
    allowed_ids = None
    all_ids = None  # chunks mentioning every requested drug
    if doc_types and not drug_ids:
        allowed_ids = list(base.values_list("id", flat=True))
    if drug_ids:
        per_chunk = _mentions(base, drug_ids)
        all_ids = [cid for cid, m in per_chunk.items() if covers_all(m, drug_ids)]
        allowed_ids = all_ids if require_all else list(per_chunk)
        if not allowed_ids:
            return EvidenceResult(status="INSUFFICIENT", retrieval_mode="none", degraded=False, chunks=[],
                                  query=query).model_dump()

    try:
        allowed_rows = None
        if allowed_ids is not None:
            allowed_rows = [r for r in base.filter(id__in=allowed_ids).values_list("faiss_row", flat=True)
                            if r is not None]
        hits = retrieval.search(kb_label, query, k * 3, allowed_rows, query_vector=query_vector)
        passing = [(r, s) for r, s in hits if s >= threshold]
        used_query = query
        if not passing and drug_ids:
            used_query = expansion_query(query, drug_ids)
            hits = retrieval.search(kb_label, used_query, k * 3, allowed_rows, query_vector=expansion_vector)
            passing = [(r, s) for r, s in hits if s >= threshold]
        passing = passing[:k]
        rows = {c.faiss_row: c for c in base.filter(faiss_row__in=[r for r, _ in passing]).select_related("document")}
        chunks = [_chunk_out(rows[r], s) for r, s in passing if r in rows]
        return EvidenceResult(status="FOUND" if chunks else "INSUFFICIENT", retrieval_mode="faiss", degraded=False,
                              chunks=chunks, query=used_query).model_dump()
    except retrieval.IndexUnavailable as e:
        log.warning("faiss_unavailable_fulltext_fallback", extra={"reason": str(e)})
        # Degraded mode has no semantic score to filter on, so it is stricter about the prefilter:
        # a chunk must mention every requested drug to count as evidence.
        return _fulltext(base, all_ids if drug_ids else allowed_ids, query, drug_ids, k)


_WORD = re.compile(r"[A-Za-z][A-Za-z\-]{2,}")
_NLEM_Q = re.compile(r"\bnlem\b|essential medicines?|level of (health)?care|dosage forms?", re.I)
_STW_Q = re.compile(r"\bstws?\b|\bicmr\b|treatment work ?flows?", re.I)


def route_doc_types(question: str) -> list[str] | None:
    """Deterministic document routing: a question that names NLEM or the ICMR STWs searches only those."""
    if _NLEM_Q.search(question or ""):
        return ["NLEM"]
    if _STW_Q.search(question or ""):
        return ["ICMR_STW"]
    return None


def _fulltext(base, allowed_ids, query: str, drug_ids: list[int], k: int) -> dict:
    terms_text = f"{query} {_expansion_terms(drug_ids)}" if drug_ids else query
    qs = base.select_related("document")
    if allowed_ids is not None:
        qs = qs.filter(id__in=allowed_ids)
    scored: list[tuple] = []
    if connection.vendor == "mysql":
        ids = list(qs.values_list("id", flat=True)) if allowed_ids is not None else None
        sql = ("SELECT id, MATCH(text) AGAINST (%s IN NATURAL LANGUAGE MODE) AS score FROM corpus_chunks "
               "WHERE MATCH(text) AGAINST (%s IN NATURAL LANGUAGE MODE)")
        params = [terms_text, terms_text]
        if ids is not None:
            if not ids:
                ids = [-1]
            sql += " AND id IN (" + ",".join(["%s"] * len(ids)) + ")"
            params += ids
        sql += " ORDER BY score DESC LIMIT %s"
        params.append(k)
        with connection.cursor() as cur:
            cur.execute(sql, params)
            found = cur.fetchall()
        by_id = {c.id: c for c in base.filter(id__in=[f[0] for f in found]).select_related("document")}
        scored = [(by_id[i], float(s)) for i, s in found if i in by_id]
    else:  # SQLite dev/test only: crude term-overlap scoring
        terms = {t.lower() for t in _WORD.findall(terms_text)} - {"interaction", "the", "and", "with"}
        for c in qs[:2000]:
            low = c.text.lower()
            hit = sum(1 for t in terms if t in low)
            if hit:
                scored.append((c, hit / max(1, len(terms))))
        scored.sort(key=lambda x: -x[1])
        scored = scored[:k]
    chunks = [_chunk_out(c, s) for c, s in scored]
    return EvidenceResult(status="FOUND" if chunks else "INSUFFICIENT", retrieval_mode="fulltext", degraded=True,
                          chunks=chunks, query=terms_text).model_dump()


def summarize(r: dict) -> str:
    return (f"status={r['status']} mode={r['retrieval_mode']} degraded={r['degraded']} "
            f"chunks={[c['chunk_id'] for c in r['chunks']]} scores={[c['score'] for c in r['chunks']]}")
