"""Which raw DDInter category CSV(s) a seeded interaction came from (Prove Why provenance).

The record ID is the ordered DDInter-ID pair ("DDInter1951|DDInter20", see structured.py); a pair can appear in
several ATC category files. The raw files (~13 MB) are read once per process. warm() runs at process start so no
request pays for the first read (on a cloud-synced folder that read can take tens of seconds).
"""
from __future__ import annotations

import csv
import logging
import threading

from django.conf import settings

log = logging.getLogger(__name__)
_files: dict[str, list[str]] | None = None
_lock = threading.Lock()


def _load() -> dict[str, list[str]]:
    found: dict[str, list[str]] = {}
    for path in sorted((settings.REPO_ROOT / "data" / "raw" / "ddinter").glob("ddinter_downloads_code_*.csv")):
        with open(path, encoding="utf-8", errors="replace", newline="") as fp:
            for row in csv.DictReader(fp):
                a, b = row.get("DDInterID_A"), row.get("DDInterID_B")
                if a and b:
                    files = found.setdefault("|".join(sorted((a, b))), [])
                    if path.name not in files:
                        files.append(path.name)
    return found


def files_for(record_id: str) -> list[str]:
    global _files
    with _lock:
        if _files is None:
            _files = _load()
    return _files.get(record_id, [])


def warm():
    try:
        files_for("")
        log.info("ddinter_files_warm", extra={"pairs": len(_files or {})})
    except Exception as e:  # noqa: BLE001 - Prove Why then says the raw file is not available
        log.warning("ddinter_files_warm_failed", extra={"reason": str(e)[:200]})
