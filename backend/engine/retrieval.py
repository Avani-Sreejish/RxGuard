"""Embeddings + FAISS index (spec section 11.2).

Vectors: intfloat/multilingual-e5-base with "passage: " / "query: " prefixes, L2-normalised,
stored in a FAISS IndexFlatIP (exact search - fast enough at this corpus size).
Row i of the index is corpus_chunks.faiss_row == i. The index is versioned with the KB.
"""
from __future__ import annotations

import json
import logging
import threading
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
        import anthropic  # noqa: F401 - the first import costs seconds; pay it at start, not in a request

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
