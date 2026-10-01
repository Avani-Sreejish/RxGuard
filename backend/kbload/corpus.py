"""RAG corpus ingestion (spec section 11.2).

parse -> clean -> chunk (~300-500 tokens, ~50 overlap; NLEM rows kept whole with their header)
-> metadata -> drug mentions (same alias scanner) -> e5 embeddings -> FAISS (faiss_row -> chunk_id).
DDInter is NOT part of the corpus; it is structured data behind Tool 1.
"""
from __future__ import annotations

import hashlib
import logging
import re
from pathlib import Path

from engine import normalize, retrieval

log = logging.getLogger("rxguard.seed")

CHUNK_WORDS = 300   # ~400 tokens
OVERLAP_WORDS = 40  # ~50 tokens
_WS = re.compile(r"[ \t]+")
_CAPS = re.compile(r"^[A-Z][A-Z0-9 /&()\-,']{5,60}$")
_NOISE = re.compile(r"/uni[0-9A-Fa-f]{4}|/hyphen\.case|\(cid:\d+\)")


# Boilerplate repeated on every ICMR STW page (disclaimer, copyright, portal link). Left in, it outranks the
# clinical content for any generic "ICMR STW ..." query, so it is stripped like a header/footer (spec 11.2).
_BOILERPLATE = [re.compile(p, re.I | re.S) for p in (
    r"Th(is|ese) STWs? ha(s|ve) been prepared by national experts.*?(for more information\.?|indemnity[^.]*\.)",
    r"There may be variations in the management of an individual patient.*?treating physician\.",
    r"There will be no indemnity for direct or indirect consequences\.",
    r"Kindly visit our web portal \(?stw\.icmr\.org\.in\)? for more information\.?",
    r"©\s*(Indian Council of Medical Research|Department of Health Research|DHR)[^\n]*",
    r"n\s*i\s*\.\s*g\s*r\s*o\s*\.\s*r\s*m\s*c\s*i\s*\.\s*w\s*t\s*s",  # "stw.icmr.org.in" rotated in the margin
)]
SKIP_HEADINGS = ("Expert Groups", "Partners", "Acknowledgement", "Contributors")


def clean(text: str) -> str:
    text = _NOISE.sub(" ", text).replace("ﬁ", "fi").replace("ﬂ", "fl")
    for rx in _BOILERPLATE:
        text = rx.sub(" ", text)
    lines = [_WS.sub(" ", ln).strip() for ln in text.splitlines()]
    return "\n".join(ln for ln in lines if ln)


def nlem_chunks(entries: list[dict]) -> list[dict]:
    out = []
    for e in entries:
        forms = "; ".join(e["forms"]) or "(not stated)"
        text = (f"National List of Essential Medicines (NLEM) 2022. Section {e['section'] or '(see document)'}.\n"
                f"Medicine | Level of healthcare | Dosage form(s) and strength(s)\n"
                f"{e['code']} {e['name']} | {e['level']} | {forms}\n"
                f"Level of healthcare key: P = Primary, S = Secondary, T = Tertiary.")
        out.append({"section_path": f"NLEM 2022 > {e['section']} > {e['code']} {e['name']}"[:400],
                    "page": e["page"], "text": text})
    return out


def pdf_pages(path: Path) -> list[str]:
    import pdfplumber

    with pdfplumber.open(path) as pdf:
        return [clean(p.extract_text() or "") for p in pdf.pages]


def window_chunks(title: str, pages: list[str]) -> list[dict]:
    """Heading-aware word windows. Section path = title > last ALL-CAPS heading seen."""
    out = []
    for pno, text in enumerate(pages, start=1):
        heading = ""
        units: list[tuple[str, str]] = []  # (heading, line)
        for ln in text.splitlines():
            if _CAPS.match(ln) and len(ln.split()) <= 8:
                heading = ln.title()
            units.append((heading, ln))
        words: list[tuple[str, str]] = []
        for h, ln in units:
            words += [(h, w) for w in ln.split()] + [(h, "\n")]
        i = 0
        while i < len(words):
            win = words[i:i + CHUNK_WORDS]
            body = " ".join(w for _h, w in win).replace(" \n ", "\n").replace(" \n", "\n").strip()
            heads = [h for h, _w in win if h]
            if len(body.split()) >= 25 and not (heads and heads[0].startswith(SKIP_HEADINGS)):
                section = f"{title} > {heads[0]}" if heads else title
                out.append({"section_path": section[:400], "page": pno, "text": body})
            if i + CHUNK_WORDS >= len(words):
                break
            i += CHUNK_WORDS - OVERLAP_WORDS
    return out


def ingest(kb, manifest: dict, raw_dir: Path, nlem_entries: list[dict], include_restricted: bool, classes_csv: Path | None = None,
           embed: bool = True) -> dict:
    from api.models import ChunkDrugMention, CorpusChunk, CorpusDocument, DataSource
    from django.utils import timezone

    icmr = manifest["icmr_defaults"]
    stats = {"documents": 0, "chunks": 0, "skipped_restricted": [], "missing_files": []}
    for doc in manifest["documents"]:
        path = raw_dir / doc["file"]
        if doc.get("restricted") and not include_restricted:
            stats["skipped_restricted"].append(doc["file"])
            continue
        if not path.exists():
            stats["missing_files"].append(doc["file"])
            continue
        is_icmr = doc["doc_type"] == "ICMR_STW"
        meta = {"source": doc.get("source") or (icmr["source"] if is_icmr else ""),
                "version": doc.get("version") or (icmr["version"] if is_icmr else ""),
                "license": doc.get("license_override") or doc.get("license") or (icmr["license"] if is_icmr else ""),
                "url": doc.get("url") or (icmr["url"] if is_icmr else "")}
        checksum = sha256_file(path)
        d = CorpusDocument.objects.create(kb_version=kb, title=doc["title"], doc_type=doc["doc_type"],
                                          file_name=doc["file"], checksum=checksum, **meta)
        DataSource.objects.create(kb_version=kb, name=doc["title"], version=meta["version"], license=meta["license"],
                                  url=meta["url"], retrieved_at=timezone.now(), checksum=checksum,
                                  notes="RAG corpus document" + (" (restricted, opt-in)" if doc.get("restricted")
                                                                 else ""))
        chunks = nlem_chunks(nlem_entries) if doc["doc_type"] == "NLEM" else window_chunks(doc["title"],
                                                                                           pdf_pages(path))
        CorpusChunk.objects.bulk_create([CorpusChunk(document=d, section_path=c["section_path"], page=c["page"],
                                                     text=c["text"], text_hash=hashlib.sha256(
                                                         c["text"].encode()).hexdigest()) for c in chunks])
        stats["documents"] += 1
        stats["chunks"] += len(chunks)

    # drug mentions (retrieval prefilter): direct names/aliases, plus curated class terms ("anticoagulants")
    idx = normalize.build_alias_index(kb)
    classes = class_index(kb, classes_csv)
    mentions = []
    all_chunks = list(CorpusChunk.objects.filter(document__kb_version=kb).order_by("id"))
    for c in all_chunks:
        seen = set()
        for _s, _e, entry in idx.scan(c.text):
            for d_id in entry.drug_ids:
                if d_id not in seen:
                    seen.add(d_id)
                    mentions.append(ChunkDrugMention(chunk=c, drug_id=d_id, via="direct"))
        toks = f" {normalize.normalize_text(c.text)} "
        for term, members in classes.items():
            if f" {term} " in toks:
                for d_id in members:
                    if d_id not in seen:
                        seen.add(d_id)
                        mentions.append(ChunkDrugMention(chunk=c, drug_id=d_id, via=f"class:{term}"[:64]))
    ChunkDrugMention.objects.bulk_create(mentions, batch_size=5000)
    stats["class_mentions"] = sum(1 for m in mentions if m.via != "direct")
    stats["drug_mentions"] = len(mentions)

    if embed and all_chunks:
        vecs = retrieval.embed([c.text for c in all_chunks], "passage")
        for row, c in enumerate(all_chunks):
            c.faiss_row = row
        CorpusChunk.objects.bulk_update(all_chunks, ["faiss_row"], batch_size=2000)
        retrieval.save_index(kb.label, vecs, [c.id for c in all_chunks])
        stats["faiss_rows"] = len(all_chunks)
    return stats


def class_index(kb, classes_csv: Path | None) -> dict[str, list[int]]:
    """Curated class term -> member drug IDs (only members present in this KB)."""
    import csv

    from api.models import Drug

    if not classes_csv or not classes_csv.exists():
        return {}
    by_name = {n.lower(): i for i, n in Drug.objects.filter(kb_version=kb).values_list("id", "generic_name")}
    out = {}
    with open(classes_csv, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            ids = [by_name[m.strip().lower()] for m in r["members"].split("|") if m.strip().lower() in by_name]
            if ids:
                out[normalize.normalize_text(r["class_term"])] = ids
    return out


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()
