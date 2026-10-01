"""Embeddings + FAISS index (spec section 11.2), BM25 keyword index and cross-encoder reranker.

Vectors: intfloat/multilingual-e5-base with "passage: " / "query: " prefixes, L2-normalised,
stored in a FAISS IndexFlatIP (exact search - fast enough at this corpus size).
Row i of the index is corpus_chunks.faiss_row == i. The index is versioned with the KB.

Hybrid search: dense (FAISS) and keyword (BM25, built in memory from corpus_chunks) rankings are fused with
Reciprocal Rank Fusion; the top candidates can then be re-scored by a cross-encoder (RETRIEVAL_RERANK=1).
"""
from __future__ import annotations

import json
import logging
import math
import re
import threading
from collections import Counter
from pathlib import Path

import numpy as np
from django.conf import settings

from engine import context

log = logging.getLogger("rxguard.retrieval")


class IndexUnavailable(Exception):
    pass


_lock = threading.Lock()
_embedder = None
_indexes: dict[str, tuple] = {}


def get_embedder():
    global _embedder
    with _lock:
        if _embedder is None:
            try:
                from sentence_transformers import SentenceTransformer
            except ImportError as e:  # pragma: no cover
                raise IndexUnavailable(f"sentence-transformers not installed: {e}") from e
            _embedder = SentenceTransformer(settings.RXGUARD["EMBEDDING_MODEL"], device="cpu")
        return _embedder


_encode_lock = threading.Lock()  # the HF tokenizer is not safe for concurrent use ("Already borrowed")


_query_cache: "OrderedDict[str, np.ndarray]" = None
_QUERY_CACHE_MAX = 20_000


def embed(texts: list[str], kind: str) -> np.ndarray:
    """Encode texts. Query vectors are cached by exact text (finding queries repeat for common drug pairs);
    only cache misses take the encoder lock."""
    global _query_cache
    from collections import OrderedDict

    prefix = "query: " if kind == "query" else "passage: "
    if kind != "query":
        model = get_embedder()
        with _encode_lock:
            vecs = model.encode([prefix + t for t in texts], batch_size=16, normalize_embeddings=True,
                                show_progress_bar=False)
        return np.asarray(vecs, dtype="float32")
    with _lock:
        if _query_cache is None:
            _query_cache = OrderedDict()
        missing = list(dict.fromkeys(t for t in texts if t not in _query_cache))
    if missing:
        model = get_embedder()
        with _encode_lock:
            vecs = model.encode([prefix + t for t in missing], batch_size=16, normalize_embeddings=True,
                                show_progress_bar=False)
        with _lock:
            for t, v in zip(missing, np.asarray(vecs, dtype="float32")):
                _query_cache[t] = v
            while len(_query_cache) > _QUERY_CACHE_MAX:
                _query_cache.popitem(last=False)
    with _lock:
        return np.stack([_query_cache[t] for t in texts]).astype("float32")


def warm_up():
    """Load the embedding model and current index at process start so the first request is not slow."""
    from api.models import KbVersion
    from engine import normalize

    try:
        # the first SDK import costs seconds; pay it at start, not in a request
        import anthropic  # noqa: F401
        from google import genai  # noqa: F401

        embed(["warm up"], "query")  # model load does not depend on a KB existing yet
        from engine.tools.base import _pool
        # first inference on a new thread / input shape is slow; run realistic queries through the tool pool too
        q = "Warfarin and Acetylsalicylic acid taken together: interaction, precautions, adverse effects"
        for f in [_pool.submit(embed, [q], "query") for _ in range(4)]:
            f.result()
        kb = KbVersion.objects.filter(is_current=True).first()
        if kb:
            normalize.get_alias_index(kb)
            load_index(kb.label)
            bm25_index(kb.label)
            if settings.RXGUARD["RETRIEVAL_RERANK"]:
                rerank("warm up", ["warm up"])
        log.info("retrieval_warm", extra={"kb_version": kb.label if kb else None})
    except Exception as e:  # noqa: BLE001 - readiness reports it; FULLTEXT fallback still works
        log.warning("retrieval_warm_failed", extra={"reason": str(e)[:200]})


def index_dir(kb_label: str) -> Path:
    return Path(settings.RXGUARD["INDEX_DIR"]) / kb_label


def save_index(kb_label: str, vectors: np.ndarray, chunk_ids: list[int]):
    import faiss

    d = index_dir(kb_label)
    d.mkdir(parents=True, exist_ok=True)
    idx = faiss.IndexFlatIP(vectors.shape[1])
    idx.add(vectors)
    faiss.write_index(idx, str(d / "index.faiss"))
    (d / "meta.json").write_text(json.dumps({
        "kb_version": kb_label, "embedding_model": settings.RXGUARD["EMBEDDING_MODEL"], "dim": int(vectors.shape[1]),
        "rows": len(chunk_ids), "chunk_ids": chunk_ids}))
    with _lock:
        _indexes.pop(kb_label, None)
        _bm25.pop(kb_label, None)


def load_index(kb_label: str):
    if context.simulating("faiss_down"):
        raise IndexUnavailable("simulated: vector index unavailable")
    with _lock:
        if kb_label in _indexes:
            return _indexes[kb_label]
    d = index_dir(kb_label)
    if not (d / "index.faiss").exists():
        raise IndexUnavailable(f"no FAISS index for {kb_label} at {d}")
    try:
        import faiss
        idx = faiss.read_index(str(d / "index.faiss"))
        meta = json.loads((d / "meta.json").read_text())
    except Exception as e:  # noqa: BLE001
        raise IndexUnavailable(str(e)) from e
    with _lock:
        _indexes[kb_label] = (idx, meta)
    return idx, meta


def index_ready(kb_label: str) -> tuple[bool, str]:
    try:
        _idx, meta = load_index(kb_label)
        return True, f"{meta['rows']} rows, {meta['embedding_model']}"
    except IndexUnavailable as e:
        return False, str(e)


def search(kb_label: str, query: str, k: int, allowed_rows: list[int] | None = None,
           query_vector=None) -> list[tuple[int, float]]:
    """Return [(faiss_row, score)] best-first. allowed_rows restricts the search (drug prefilter)."""
    import faiss

    idx, _meta = load_index(kb_label)
    q = np.asarray([query_vector], dtype="float32") if query_vector is not None else embed([query], "query")
    if allowed_rows is not None:
        if not allowed_rows:
            return []
        sel = faiss.IDSelectorBatch(np.asarray(allowed_rows, dtype="int64"))
        scores, rows = idx.search(q, min(k, len(allowed_rows)), params=faiss.SearchParameters(sel=sel))
    else:
        scores, rows = idx.search(q, k)
    return [(int(r), float(s)) for r, s in zip(rows[0], scores[0]) if r >= 0]


def dense_scores(kb_label: str, rows: list[int], query_vector) -> dict[int, float]:
    """Exact inner-product scores of the query against specific FAISS rows (for candidates found only by BM25)."""
    idx, _meta = load_index(kb_label)
    q = np.asarray(query_vector, dtype="float32")
    return {r: float(np.dot(idx.reconstruct(int(r)), q)) for r in rows}


# ---- BM25 keyword index -----------------------------------------------------------------------------------
# Built lazily per KB version from corpus_chunks (faiss_row -> text). ~530 chunks: milliseconds to build.

_TOKEN = re.compile(r"[a-z0-9][a-z0-9\-]+")
_STOP = frozenset("""a an and are as at be by for from has have in is it its of on or that the this to was were
which with what when who how does do should can may their there these those than then into also other""".split())
_BM25_K1, _BM25_B = 1.5, 0.75
_bm25: dict[str, dict] = {}


def tokenize(text: str) -> list[str]:
    return [t for t in _TOKEN.findall((text or "").lower()) if t not in _STOP]


def _build_bm25(kb_label: str) -> dict:
    from api.models import CorpusChunk

    rows = list(CorpusChunk.objects.filter(document__kb_version__label=kb_label, faiss_row__isnull=False)
                .values_list("faiss_row", "document__title", "section_path", "text"))
    tfs, lens, df = {}, {}, Counter()
    for row, title, section, text in rows:
        toks = tokenize(f"{title} {section} {text}")
        tfs[row] = Counter(toks)
        lens[row] = len(toks)
        df.update(set(toks))
    n = max(1, len(rows))
    idf = {t: math.log(1 + (n - f + 0.5) / (f + 0.5)) for t, f in df.items()}
    return {"tf": tfs, "len": lens, "idf": idf, "avgdl": (sum(lens.values()) / n) or 1.0}


def bm25_index(kb_label: str) -> dict:
    with _lock:
        if kb_label in _bm25:
            return _bm25[kb_label]
    built = _build_bm25(kb_label)
    with _lock:
        _bm25[kb_label] = built
    return built


def bm25_search(kb_label: str, query: str, k: int, allowed_rows: list[int] | None = None) -> list[tuple[int, float]]:
    """[(faiss_row, bm25 score)] best-first; rows with no query term are not returned."""
    ix = bm25_index(kb_label)
    terms = [t for t in dict.fromkeys(tokenize(query)) if t in ix["idf"]]
    if not terms:
        return []
    candidates = ix["tf"].keys() if allowed_rows is None else [r for r in allowed_rows if r in ix["tf"]]
    scored = []
    for r in candidates:
        tf, dl = ix["tf"][r], ix["len"][r]
        s = 0.0
        for t in terms:
            f = tf.get(t)
            if f:
                s += ix["idf"][t] * f * (_BM25_K1 + 1) / (f + _BM25_K1 * (1 - _BM25_B + _BM25_B * dl / ix["avgdl"]))
        if s > 0:
            scored.append((r, s))
    scored.sort(key=lambda x: -x[1])
    return scored[:k]


def rrf_fuse(*rankings: list[tuple[int, float]], k: int = 60) -> list[tuple[int, float]]:
    """Reciprocal Rank Fusion: score(row) = sum over rankings of 1 / (k + rank). Best-first."""
    fused: dict[int, float] = {}
    for ranking in rankings:
        for rank, (row, _score) in enumerate(ranking, start=1):
            fused[row] = fused.get(row, 0.0) + 1.0 / (k + rank)
    return sorted(fused.items(), key=lambda x: -x[1])


# ---- Cross-encoder reranker ---------------------------------------------------------------------------------

class RerankerUnavailable(Exception):
    pass


_reranker = None
_rerank_lock = threading.Lock()  # same tokenizer thread-safety issue as the embedder


def get_reranker():
    global _reranker
    with _lock:
        if _reranker is None:
            try:
                from sentence_transformers import CrossEncoder
                _reranker = CrossEncoder(settings.RXGUARD["RERANK_MODEL"], device="cpu", max_length=512)
            except Exception as e:  # noqa: BLE001 - missing package or model: callers fall back to RRF order
                raise RerankerUnavailable(str(e)) from e
        return _reranker


def rerank(query: str, texts: list[str]) -> list[float]:
    """Cross-encoder relevance of each text to the query, squashed to 0..1 with a sigmoid."""
    if not texts:
        return []
    model = get_reranker()
    with _rerank_lock:
        logits = model.predict([(query, t) for t in texts], batch_size=16, show_progress_bar=False)
    return [float(1.0 / (1.0 + math.exp(-float(x)))) for x in np.asarray(logits).reshape(-1)]


def hybrid_search(kb_label: str, query: str, k: int, allowed_rows: list[int] | None = None,
                  query_vector=None, fetch_texts=None) -> list[dict]:
    """Dense + BM25 candidates fused with RRF, optionally re-scored by the cross-encoder.

    Returns best-first [{"row", "dense", "rrf", "rerank"}]; "rerank" is None when reranking is off or the
    model is unavailable. `fetch_texts(rows) -> {faiss_row: text}` supplies passages for reranking.
    Raises IndexUnavailable like search() - the caller then uses the FULLTEXT fallback."""
    n = settings.RXGUARD["RETRIEVAL_CANDIDATES"]
    if query_vector is None:
        query_vector = embed([query], "query")[0]
    dense = search(kb_label, query, n, allowed_rows, query_vector=query_vector)
    try:
        sparse = bm25_search(kb_label, query, n, allowed_rows)
    except Exception as e:  # noqa: BLE001 - keyword ranking is an improvement, never a dependency
        log.warning("bm25_failed", extra={"reason": str(e)[:200]})
        sparse = []
    fused = rrf_fuse(dense, sparse)[: settings.RXGUARD["RERANK_CANDIDATES"]]
    dense_map = dict(dense)
    missing = [r for r, _ in fused if r not in dense_map]
    if missing:
        dense_map.update(dense_scores(kb_label, missing, query_vector))
    out = [{"row": r, "dense": dense_map[r], "rrf": s, "rerank": None} for r, s in fused]
    if out and settings.RXGUARD["RETRIEVAL_RERANK"] and fetch_texts is not None:
        try:
            texts = fetch_texts([c["row"] for c in out])
            scores = rerank(query, [texts.get(c["row"], "") for c in out])
            for c, s in zip(out, scores):
                c["rerank"] = s
            out.sort(key=lambda c: -c["rerank"])
        except RerankerUnavailable as e:
            log.warning("reranker_unavailable", extra={"reason": str(e)[:200]})
    return out
