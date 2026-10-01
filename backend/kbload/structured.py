"""Structured knowledge loaders: DDInter -> drugs + drug_interactions, NLEM 2022 -> drugs, curated
synonyms and synthetic brands -> drug_aliases / products. All rows belong to one kb_versions row."""
from __future__ import annotations

import csv
import hashlib
import logging
import re
from pathlib import Path

from django.db import transaction

from engine.normalize import normalize_text

log = logging.getLogger("rxguard.seed")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def sha256_many(paths: list[Path]) -> str:
    """Checksum of several files: SHA-256 over their individual checksums, in the given order."""
    return hashlib.sha256("".join(sha256(p) for p in paths).encode()).hexdigest()


# ------------------------------------------------------------------------ DDInter
def load_ddinter(kb, raw_dir: Path, files: list[str]) -> dict:
    from api.models import Drug, DrugInteraction

    names: dict[str, str] = {}  # generic name -> DDInter ID
    pairs: dict[tuple[str, str], tuple[str, str, str]] = {}
    conflicts = 0
    for fn in files:
        with open(raw_dir / fn, encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                a, b = r["Drug_A"].strip(), r["Drug_B"].strip()
                names.setdefault(a, r["DDInterID_A"].strip())
                names.setdefault(b, r["DDInterID_B"].strip())
                key = tuple(sorted((a, b)))
                prev = pairs.get(key)
                if prev and prev[0] != r["Level"]:
                    conflicts += 1
                pairs.setdefault(key, (r["Level"].strip(), r["DDInterID_A"].strip(), r["DDInterID_B"].strip()))
    by_norm: dict[str, int] = {}
    with transaction.atomic():
        objs = []
        for n, did in sorted(names.items()):
            norm = normalize_text(n)
            if norm in by_norm or not norm:
                continue
            by_norm[norm] = -1
            objs.append(Drug(kb_version=kb, generic_name=n, normalized_name=norm, ddinter_id=did, source="DDInter"))
        Drug.objects.bulk_create(objs, batch_size=2000)
        ids = dict(Drug.objects.filter(kb_version=kb).values_list("generic_name", "id"))
        rows = []
        for (a, b), (level, id_a, id_b) in pairs.items():
            da, db = ids.get(a), ids.get(b)
            if not da or not db or da == db:
                continue
            if da > db:
                da, db = db, da
            rec = "|".join(sorted((id_a, id_b)))
            rows.append(DrugInteraction(kb_version=kb, drug_a_id=da, drug_b_id=db, severity=level, source="DDInter",
                                        source_record_id=rec))
        DrugInteraction.objects.bulk_create(rows, batch_size=5000)
    return {"drugs": len(objs), "interactions": len(rows), "level_conflicts": conflicts}


# ------------------------------------------------------------------------ NLEM 2022
_CODE = re.compile(r"^\d{1,2}(\.\d{1,2}){1,3}$")
_SUBSEC = re.compile(r"^(\d{1,2}(?:\.\d{1,2}){0,3})\s*-\s*(.+)$", re.S)
_LEVEL = re.compile(r"^[PST](\s*,\s*[PST])*$")


def parse_nlem(pdf_path: Path) -> list[dict]:
    """One dict per NLEM table row: code, name, level, forms, section, page."""
    import pdfplumber

    entries, section = [], ""
    with pdfplumber.open(pdf_path) as pdf:
        for pno, page in enumerate(pdf.pages, start=1):
            for table in page.extract_tables():
                for row in table:
                    cells = [(c or "").strip() for c in row] + ["", "", "", ""]
                    c0, name, level, forms = cells[0], cells[1], cells[2], cells[3]
                    m = _SUBSEC.match(c0)
                    if m and not name and not _CODE.match(c0):
                        section = f"{m.group(1)} - {' '.join(m.group(2).split())}"
                        continue
                    if _CODE.match(c0) and _LEVEL.match(level.replace("\n", "")):
                        entries.append({"code": c0, "raw_name": " ".join(name.split()),
                                        "level": level.replace("\n", "").replace(" ", ""),
                                        "forms": [" ".join(x.split()) for x in forms.split("\n") if x.strip()],
                                        "section": section, "page": pno})
                    elif not c0 and not name and forms and entries and len(cells) >= 4:
                        entries[-1]["forms"] += [" ".join(x.split()) for x in forms.split("\n") if x.strip()]
                    elif len([c for c in row if c]) == 1 and entries and row[0] and \
                            re.match(r"^(Tablet|Capsule|Injection|Oral|Powder|Syrup|Cream|Ointment|Drops|Inhal)",
                                     row[0]):
                        entries[-1]["forms"].append(" ".join(row[0].split()))  # page-break continuation
    for e in entries:
        e["name"] = re.sub(r"\*+", "", e["raw_name"]).strip()
        e["is_combination"] = "+" in e["name"] or "(A)" in e["name"]
        # rejoin wrapped dosage lines such as "Oral liquid 200 mg (A) + 40 mg" / "(B)/5 mL (p)"
        merged = []
        for f in e["forms"]:
            if merged and (f.startswith("(") or f[:1].islower() or f.startswith("glucose")):
                merged[-1] += " " + f
            else:
                merged.append(f)
        e["forms"] = merged
    return entries


FORM_WORDS = ("Tablet", "Capsule", "Injection", "Oral liquid", "Powder for injection", "Powder for oral liquid",
              "Syrup", "Cream", "Ointment", "Drops", "Eye drops", "Ear drops", "Inhalation", "Spray", "Gel",
              "Lotion", "Suppository", "Patch", "Topical forms", "Solution", "Suspension", "Dry powder inhaler",
              "Metered dose inhaler", "Respirator solution", "Pessary", "Vaginal")


def dosage_form(line: str) -> str:
    low = line.lower()
    for w in sorted(FORM_WORDS, key=len, reverse=True):
        if low.startswith(w.lower()):
            return w
    return line.split(" ")[0]


SALT_WORDS = {"hydrochloride", "hcl", "sodium", "potassium", "calcium", "chloride", "bromide", "acetate", "valerate",
              "trihydrate", "dihydrate", "monohydrate", "succinate", "tartrate", "maleate", "sulphate", "sulfate",
              "phosphate", "mesylate", "besylate", "citrate", "fumarate", "dipropionate", "propionate", "gluconate",
              "lactate", "hydrobromide", "disodium", "dimeglumine", "meglumine", "nitrate", "carbonate", "oxide"}


def load_nlem(kb, entries: list[dict], synonyms: dict[str, str], out_dir: Path) -> dict:
    from api.models import Drug

    by_norm = {d.normalized_name: d for d in Drug.objects.filter(kb_version=kb)}
    matched, created, combos = 0, 0, 0
    unmatched, heuristic = [], []
    agg: dict[int, dict] = {}
    for e in entries:
        if e["is_combination"]:
            combos += 1
            continue
        norm = normalize_text(e["name"])
        bare = normalize_text(re.sub(r"\([^)]*\)", " ", e["name"]))  # "Ascorbic acid (Vitamin C)" -> "ascorbic acid"
        target = None
        for key in (norm, bare):
            target = by_norm.get(key) or by_norm.get(normalize_text(synonyms.get(key, "")))
            if target:
                break
        if target is None:
            # drop trailing salt words only ("Bendamustine hydrochloride" -> "bendamustine"); logged for review
            toks = bare.split()
            if len(toks) > 1 and len(toks[0]) > 4 and all(t in SALT_WORDS for t in toks[1:]):
                target = by_norm.get(toks[0])
            if target is not None:
                heuristic.append(f"{e['name']} -> {target.generic_name}")
        if target is None:
            target = Drug.objects.create(kb_version=kb, generic_name=e["name"], normalized_name=norm, source="NLEM")
            by_norm[norm] = target
            created += 1
            unmatched.append(e["name"])
        else:
            matched += 1
        a = agg.setdefault(target.id, {"drug": target, "levels": set(), "forms": [], "sections": []})
        a["levels"].update(e["level"].split(","))
        for f in e["forms"]:
            df = dosage_form(f)
            if df not in a["forms"]:
                a["forms"].append(df)
        a["sections"].append(e["code"])
    for a in agg.values():
        d = a["drug"]
        d.nlem_listed = True
        d.nlem_level_of_care = ",".join(x for x in "PST" if x in a["levels"])
        d.nlem_dosage_forms = a["forms"]
        d.nlem_section = ",".join(a["sections"])[:32]
        if d.source == "DDInter":
            d.source = "DDInter+NLEM"
        d.save()
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "nlem_unmatched.txt").write_text(
        "# NLEM medicines with no DDInter molecule (added as NLEM-only drugs; no interaction data)\n" +
        "\n".join(sorted(set(unmatched))), encoding="utf-8")
    (out_dir / "nlem_heuristic_matches.txt").write_text(
        "# NLEM names matched to DDInter by first word (salt dropped) - review manually\n" +
        "\n".join(sorted(set(heuristic))), encoding="utf-8")
    return {"nlem_rows": len(entries), "matched_to_ddinter": matched, "nlem_only_drugs": created,
            "heuristic_matches": len(set(heuristic)), "combination_rows_skipped": combos}


# ------------------------------------------------------------------------ curated + synthetic
def read_synonyms(path: Path) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        return [r for r in csv.DictReader(f) if r["alias"].strip()]


def load_aliases(kb, synonyms: list[dict], brands_csv: Path) -> dict:
    from api.models import Drug, DrugAlias, Product, ProductIngredient

    by_name = {d.generic_name.lower(): d for d in Drug.objects.filter(kb_version=kb)}
    n_syn, missing = 0, []
    for s in synonyms:
        d = by_name.get(s["generic_name"].strip().lower())
        if d is None:
            missing.append(s["generic_name"])
            continue
        DrugAlias.objects.create(kb_version=kb, drug=d, alias=s["alias"].strip(),
                                 alias_normalized=normalize_text(s["alias"]), alias_type=s["alias_type"].strip(),
                                 source="team-curated synonym list", is_synthetic=False)
        n_syn += 1
    n_brand = 0
    with open(brands_csv, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            ings = [by_name.get(x.strip().lower()) for x in r["ingredients"].split("|")]
            if not all(ings):
                missing.append(f"brand {r['brand_name']}: {r['ingredients']}")
                continue
            p = Product.objects.create(kb_version=kb, brand_name=r["brand_name"].strip(),
                                       brand_normalized=normalize_text(r["brand_name"]), is_synthetic=True)
            for d in ings:
                ProductIngredient.objects.create(product=p, drug=d)
            n_brand += 1
    return {"synonyms": n_syn, "synthetic_brands": n_brand, "missing_targets": missing}
