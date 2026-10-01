"""make seed: load DDInter + NLEM + curated synonyms + synthetic brands, build the corpus and FAISS index,
record every source with licence + checksum, and mark a new kb_versions row current (spec 10.1).

Reproducible: same raw files (checksums recorded) + committed scripts -> same KB.
"""
import json
import os
from pathlib import Path

import yaml
from django.conf import settings
from django.contrib.auth.models import Group, User
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from api.models import DataSource, KbVersion
from engine import normalize
from engine.tools import interaction_lookup
from kbload import corpus, structured


class Command(BaseCommand):
    help = "Load the knowledge base and corpus into a new KB version and mark it current"

    def add_arguments(self, parser):
        parser.add_argument("--label", help="KB version label (default: next vN)")
        parser.add_argument("--data-dir", default=str(settings.REPO_ROOT / "data"))
        parser.add_argument("--no-embed", action="store_true", help="skip embeddings/FAISS (FULLTEXT only)")
        parser.add_argument("--include-restricted", action="store_true",
                            default=os.environ.get("CORPUS_INCLUDE_RESTRICTED") == "1",
                            help="also ingest documents marked restricted in the manifest (licence not cleared)")

    def handle(self, *args, **o):
        data = Path(o["data_dir"])
        raw = data / "raw"
        manifest = yaml.safe_load((data / "corpus_manifest.yaml").read_text(encoding="utf-8"))
        dd = manifest["ddinter"]
        missing = [f for f in dd["files"] if not (raw / "ddinter" / f).exists()]
        if missing:
            raise CommandError(f"Missing DDInter files {missing}. Run: python scripts/download_data.py")
        label = o["label"] or f"v{KbVersion.objects.count() + 1}"
        if KbVersion.objects.filter(label=label).exists():
            raise CommandError(f"KB version {label} already exists")
        report = {"kb_version": label}
        kb = KbVersion.objects.create(label=label, is_current=False)
        now = timezone.now()

        self.stdout.write(f"[{label}] DDInter ...")
        report["ddinter"] = structured.load_ddinter(kb, raw / "ddinter", dd["files"])
        combined = structured.sha256_many([raw / "ddinter" / f for f in dd["files"]])
        DataSource.objects.create(kb_version=kb, name=dd["name"], version=dd["version"], license=dd["license"],
                                  url=dd["url"], retrieved_at=now, checksum=combined, notes=dd["notes"])

        self.stdout.write(f"[{label}] NLEM 2022 ...")
        nlem_pdf = raw / "corpus" / "nlem2022.pdf"
        entries = structured.parse_nlem(nlem_pdf)
        syn_rows = structured.read_synonyms(data / "curated" / "synonyms.csv")
        syn_map = {normalize.normalize_text(s["alias"]): s["generic_name"] for s in syn_rows}
        report["nlem"] = structured.load_nlem(kb, entries, syn_map, data / "processed")
        nlem_doc = next(d for d in manifest["documents"] if d["doc_type"] == "NLEM")
        DataSource.objects.create(kb_version=kb, name="NLEM 2022 (structured table)", version="2022",
                                  license=nlem_doc["license"], url=nlem_doc["url"], retrieved_at=now,
                                  checksum=structured.sha256(nlem_pdf),
                                  notes="Parsed with pdfplumber table extraction into drugs.nlem_* fields")

        self.stdout.write(f"[{label}] synonyms + synthetic brands ...")
        report["aliases"] = structured.load_aliases(kb, syn_rows, data / "synthetic" / "brands.csv")
        DataSource.objects.create(kb_version=kb, name="Team-curated synonym list", version=label,
                                  license="Project data (INN/BAN/USAN name equivalences)",
                                  retrieved_at=now, checksum=structured.sha256(data / "curated" / "synonyms.csv"),
                                  notes="data/curated/synonyms.csv")
        DataSource.objects.create(kb_version=kb, name="Synthetic brand / combination products", version=label,
                                  license="Project data - SYNTHETIC DEMO DATA, not authoritative", retrieved_at=now,
                                  checksum=structured.sha256(data / "synthetic" / "brands.csv"), is_synthetic=True,
                                  notes="data/synthetic/brands.csv; fictional brand names")

        DataSource.objects.create(kb_version=kb, name="Team-curated drug-class terms", version=label,
                                  license="Project data", retrieved_at=now,
                                  checksum=structured.sha256(data / "curated" / "drug_classes.csv"),
                                  notes="data/curated/drug_classes.csv; used only to tag corpus chunks for the "
                                        "retrieval prefilter (e.g. 'anticoagulants' -> Warfarin); never a fact")
        self.stdout.write(f"[{label}] corpus + embeddings (this can take a few minutes) ...")
        report["corpus"] = corpus.ingest(kb, manifest, raw / "corpus", entries, o["include_restricted"],
                                         classes_csv=data / "curated" / "drug_classes.csv",
                                         embed=not o["no_embed"])

        with transaction.atomic():
            KbVersion.objects.exclude(pk=kb.pk).update(is_current=False)
            kb.is_current = True
            kb.notes = json.dumps(report)
            kb.save()
        interaction_lookup.clear_cache()
        self._ensure_demo_users()
        (data / "processed").mkdir(parents=True, exist_ok=True)
        (data / "processed" / f"seed_report_{label}.json").write_text(json.dumps(report, indent=2))
        self.stdout.write(self.style.SUCCESS(json.dumps(report, indent=2)))

    def _ensure_demo_users(self):
        g, _ = Group.objects.get_or_create(name="pharmacist")
        pw = os.environ.get("DEMO_PHARMACIST_PASSWORD")
        if not pw:
            self.stdout.write("DEMO_PHARMACIST_PASSWORD not set: no demo users created")
            return
        for name, staff in (("pharmacist", False), ("admin", True)):
            u, created = User.objects.get_or_create(username=name, defaults={"is_staff": staff})
            if created:
                u.set_password(pw)
                u.save()
            u.groups.add(g)
