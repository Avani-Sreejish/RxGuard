"""Admin uploads into the current knowledge base: local interaction pairs and hospital guideline text.

Safety rules (README core principle: tools provide facts, the pharmacist decides):
- Uploads only ADD. An existing interaction row (DDInter or an earlier upload) is never changed or downgraded;
  a pair that is already recorded is reported as "kept" with what the KB already says.
- Every drug name must resolve to exactly one molecule already in the KB, through the same alias index the
  prescription normaliser uses. Unknown names are rejected, never created, so a typo cannot become a "drug".
- Severity must be one of Major / Moderate / Minor / Unknown (or a listed synonym). Anything else rejects the
  row instead of defaulting.
- Uploaded interaction rows carry source UPLOAD_SOURCE, so every claim says "Hospital upload records ..." and is
  never attributed to DDInter. source_record_id = "<sha256[:12]>#<csv row>" ties each row to its DataSource.
- Uploaded guideline chunks get drug mentions from the alias scanner and are appended to the FAISS index, so
  they pass through the same retrieval cutoff and verifier as the seeded corpus.
"""
from __future__ import annotations

import csv
import hashlib
import io

from django.db import transaction
from django.utils import timezone

from engine import normalize, retrieval
from engine.tools import interaction_lookup
from engine.tools.interaction_lookup import UPLOAD_SOURCE

MAX_BYTES = 2_000_000
MAX_INTERACTION_ROWS = 5000
MAX_GUIDELINE_CHUNKS = 400
MAX_CHUNK_CHARS = 2000

SEVERITY_SYNONYMS = {
    "major": "Major", "severe": "Major", "high": "Major", "contraindicated": "Major",
    "moderate": "Moderate", "medium": "Moderate",
    "minor": "Minor", "low": "Minor", "mild": "Minor",
    "unknown": "Unknown",
}
_DRUG_A = {"drug_a", "drug1", "druga", "medication_a", "medication1", "molecule_a", "drug_1"}
_DRUG_B = {"drug_b", "drug2", "drugb", "medication_b", "medication2", "molecule_b", "drug_2"}
_SEVERITY = {"severity", "severity_level", "level", "grade"}
_SECTION = {"section", "topic", "category", "heading", "title"}
_TEXT = {"text", "content", "guideline", "recommendation", "excerpt"}


class UploadError(ValueError):
    def __init__(self, code: str, message: str, details=None):
        super().__init__(message)
        self.code, self.details = code, details


def decode(raw: bytes) -> str:
    if len(raw) > MAX_BYTES:
        raise UploadError("upload_too_large", f"Uploads are limited to {MAX_BYTES // 1_000_000} MB.")
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("latin-1")


def _headers(row: list[str]) -> list[str]:
    return [h.strip().lower().replace(" ", "_") for h in row]


def resolve_drug(name: str, idx) -> tuple[int | None, str]:
    """Exactly one molecule whose generic name, synonym or brand covers the whole cell, else (None, reason)."""
    toks = normalize.normalize_text(name).split()
    if not toks:
        return None, "empty drug name"
    hits = idx.scan(name)
    if len(hits) != 1 or hits[0][0] != 0 or hits[0][1] != len(toks):
        return None, f"'{name}' is not a drug in this knowledge base"
    ids = sorted(set(hits[0][2].drug_ids))
    if len(ids) != 1:
        return None, f"'{name}' is a combination product; list each molecule on its own row"
    return ids[0], ""


def ingest_interactions(kb, raw: bytes, filename: str, user) -> dict:
    from api.models import DataSource, Drug, DrugInteraction

    text = decode(raw).strip()
    reader = csv.reader(io.StringIO(text))
    headers = _headers(next(reader, []))
    col = {}
    for i, h in enumerate(headers):
        for key, names in (("a", _DRUG_A), ("b", _DRUG_B), ("sev", _SEVERITY)):
            if h in names and key not in col:
                col[key] = i
    if not {"a", "b", "sev"} <= col.keys():
        raise UploadError("bad_columns", "The CSV needs columns drug_a, drug_b and severity.",
                          {"detected_headers": headers})

    checksum = hashlib.sha256(raw).hexdigest()
    idx = normalize.get_alias_index(kb)
    names = dict(Drug.objects.filter(kb_version=kb).values_list("id", "generic_name"))
    existing = {(a, b): (s, src) for a, b, s, src in DrugInteraction.objects.filter(kb_version=kb).values_list(
        "drug_a_id", "drug_b_id", "severity", "source")}
    new, kept, rejected, seen = [], [], [], set()
    for row_no, row in enumerate(reader, start=2):
        if not any(c.strip() for c in row):
            continue
        if row_no - 1 > MAX_INTERACTION_ROWS:
            raise UploadError("too_many_rows", f"At most {MAX_INTERACTION_ROWS} rows per upload.")
        cell = lambda k: row[col[k]].strip() if len(row) > col[k] else ""  # noqa: E731
        a_id, why_a = resolve_drug(cell("a"), idx)
        b_id, why_b = resolve_drug(cell("b"), idx)
        sev = SEVERITY_SYNONYMS.get(cell("sev").lower())
        reason = why_a or why_b or ("" if sev else f"severity '{cell('sev')}' is not Major/Moderate/Minor/Unknown")
        if not reason and a_id == b_id:
            reason = "both columns name the same molecule"
        if reason:
            rejected.append({"row": row_no, "drug_a": cell("a"), "drug_b": cell("b"), "reason": reason})
            continue
        pair = (min(a_id, b_id), max(a_id, b_id))
        if pair in existing or pair in seen:
            old_sev, old_src = existing.get(pair, (sev, "this file"))
            kept.append({"row": row_no, "drug_a": names[pair[0]], "drug_b": names[pair[1]], "severity": old_sev,
                         "source": interaction_lookup.source_label(old_src) if pair in existing else "this file",
                         "uploaded_severity": sev})
            continue
        seen.add(pair)
        new.append(DrugInteraction(kb_version=kb, drug_a_id=pair[0], drug_b_id=pair[1], severity=sev,
                                   source=UPLOAD_SOURCE, source_record_id=f"{checksum[:12]}#{row_no}"))

    with transaction.atomic():
        DrugInteraction.objects.bulk_create(new)
        DataSource.objects.create(
            kb_version=kb, name=f"{UPLOAD_SOURCE}: {filename}"[:128], version=timezone.now().strftime("%Y-%m-%d %H:%M"),
            license="Hospital internal data (uploaded by an administrator)", url="", retrieved_at=timezone.now(),
            checksum=checksum, is_synthetic=False,
            notes=f"Interaction upload by {user.username}: {len(new)} added, {len(kept)} already recorded "
                  f"(unchanged), {len(rejected)} rejected.")
    interaction_lookup.clear_cache()
    return {"status": "success", "kb_version": kb.label, "file_name": filename, "checksum": checksum,
            "total_rows_parsed": len(new) + len(kept) + len(rejected), "added_interactions": len(new),
            "kept_existing": len(kept), "rejected_rows": len(rejected),
            "added": [{"drug_a": names[i.drug_a_id], "drug_b": names[i.drug_b_id], "severity": i.severity,
                       "source_record_id": i.source_record_id} for i in new[:50]],
            "kept": kept[:50], "rejected": rejected[:50],
            "total_interactions_now": DrugInteraction.objects.filter(kb_version=kb).count()}


def _guideline_chunks(text: str, title: str) -> list[dict]:
    first = text.split("\n", 1)[0]
    headers = _headers(next(csv.reader([first]), []))
    text_idx = next((i for i, h in enumerate(headers) if h in _TEXT), None)
    if text_idx is not None:  # CSV with a text column
        sec_idx = next((i for i, h in enumerate(headers) if h in _SECTION), None)
        out = []
        for n, row in enumerate(csv.reader(io.StringIO(text)), start=1):
            if n == 1 or len(row) <= text_idx or not row[text_idx].strip():
                continue
            sec = row[sec_idx].strip() if sec_idx is not None and len(row) > sec_idx else ""
            out.append({"section_path": f"{title} > {sec or f'Row {n}'}", "page": n, "text": row[text_idx].strip()})
        return out
    paras = [p.strip() for p in text.replace("\r\n", "\n").split("\n\n") if p.strip()]
    return [{"section_path": f"{title} > Part {n}", "page": n, "text": p} for n, p in enumerate(paras, start=1)]


def ingest_guideline(kb, raw: bytes, filename: str, title: str, doc_type: str, source: str, version: str,
                     user, classes_csv=None) -> dict:
    from api.models import ChunkDrugMention, CorpusChunk, CorpusDocument, DataSource
    from kbload.corpus import class_index

    chunks = _guideline_chunks(decode(raw).strip(), title)
    if not chunks:
        raise UploadError("empty_guideline", "No guideline text found (CSV needs a 'text' column; plain text is "
                                             "split on blank lines).")
    if len(chunks) > MAX_GUIDELINE_CHUNKS:
        raise UploadError("too_many_chunks", f"At most {MAX_GUIDELINE_CHUNKS} sections per upload.")
    too_long = [c["page"] for c in chunks if len(c["text"]) > MAX_CHUNK_CHARS]
    if too_long:
        raise UploadError("chunk_too_long", f"Each section must be at most {MAX_CHUNK_CHARS} characters; split "
                                            "long sections with blank lines.", {"rows": too_long[:20]})

    checksum = hashlib.sha256(raw).hexdigest()
    retrieval.load_index(kb.label)  # IndexUnavailable before any work: chunks without vectors are never retrieved
    # Embed before writing anything, so a model failure leaves the KB untouched.
    vectors = retrieval.embed([c["text"] for c in chunks], "passage")
    idx = normalize.get_alias_index(kb)
    classes = class_index(kb, classes_csv)
    with transaction.atomic():
        doc = CorpusDocument.objects.create(kb_version=kb, title=title[:300], doc_type=doc_type, source=source,
                                            version=version, license="Hospital internal document (uploaded)",
                                            url="", file_name=filename[:200], checksum=checksum)
        objs = CorpusChunk.objects.bulk_create([CorpusChunk(
            document=doc, section_path=c["section_path"][:390], page=c["page"], text=c["text"],
            text_hash=hashlib.sha256(c["text"].encode()).hexdigest()) for c in chunks])
        if any(o.pk is None for o in objs):  # backends without RETURNING
            objs = list(CorpusChunk.objects.filter(document=doc).order_by("id"))
        mentions, sample = [], []
        for c in objs:
            seen = {}
            for _s, _e, entry in idx.scan(c.text):
                for d_id in entry.drug_ids:
                    seen.setdefault(d_id, "direct")
            toks = f" {normalize.normalize_text(c.text)} "
            for term, members in classes.items():
                if f" {term} " in toks:
                    for d_id in members:
                        seen.setdefault(d_id, f"class:{term}"[:64])
            mentions += [ChunkDrugMention(chunk=c, drug_id=d, via=v) for d, v in seen.items()]
            if len(sample) < 5:
                sample.append({"section": c.section_path, "text_preview": c.text[:120],
                               "drugs_tagged": [idx.drug_names.get(d, str(d)) for d in list(seen)[:6]]})
        ChunkDrugMention.objects.bulk_create(mentions)
        DataSource.objects.create(kb_version=kb, name=f"{title} (upload)"[:128], version=version,
                                  license="Hospital internal document (uploaded)", url="",
                                  retrieved_at=timezone.now(), checksum=checksum,
                                  notes=f"Guideline upload by {user.username}: {filename}, {len(objs)} sections")
        rows = retrieval.append_to_index(kb.label, vectors, [c.id for c in objs])
        for c, r in zip(objs, rows):
            c.faiss_row = r
        CorpusChunk.objects.bulk_update(objs, ["faiss_row"])
    return {"status": "success", "kb_version": kb.label, "document_id": doc.id, "document_title": doc.title,
            "doc_type": doc.doc_type, "file_name": filename, "checksum": checksum, "chunks_created": len(objs),
            "drug_mentions_tagged": len(mentions), "searchable": True, "sample_chunks": sample}
