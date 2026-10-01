"""Download the raw data listed in data/corpus_manifest.yaml into data/raw/ (not committed to git).

    python scripts/download_data.py            # DDInter + NLEM + ICMR STWs
    python scripts/download_data.py --who      # also the restricted WHO Model Formulary (opt-in; licence not cleared)

Prints a SHA-256 for every file so the seed is reproducible and verifiable.
"""
import argparse
import hashlib
import sys
import urllib.request
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
UA = {"User-Agent": "Mozilla/5.0 (RxGuard data fetch)"}


import ssl

try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()
ALLOW_INSECURE = False  # set by --insecure


def fetch(url: str, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 0:
        print(f"exists  {dest.relative_to(ROOT)}")
        return
    req = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=180, context=SSL_CTX) as r, open(dest, "wb") as f:
            f.write(r.read())
    except urllib.error.URLError as e:
        if not (ALLOW_INSECURE and isinstance(getattr(e, "reason", None), ssl.SSLError)):
            raise
        # Only with --insecure: retry without certificate verification. Compare the printed SHA-256 values
        # with a trusted copy before seeding - the data could have been altered in transit.
        print(f"WARNING: TLS verification failed for {url}; retrying WITHOUT verification (--insecure)",
              file=sys.stderr)
        with urllib.request.urlopen(req, timeout=180, context=ssl._create_unverified_context()) as r,                 open(dest, "wb") as f:
            f.write(r.read())
    print(f"fetched {dest.relative_to(ROOT)}")


def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--who", action="store_true", help="also fetch the restricted WHO Model Formulary 2008")
    ap.add_argument("--insecure", action="store_true",
                    help="if TLS verification fails, retry without it (prints a warning; verify checksums after)")
    args = ap.parse_args()
    global ALLOW_INSECURE
    ALLOW_INSECURE = args.insecure
    m = yaml.safe_load((ROOT / "data" / "corpus_manifest.yaml").read_text(encoding="utf-8"))
    dl = m["downloads"]
    raw = ROOT / "data" / "raw"
    failures = []
    jobs = [(dl["ddinter_base"] + f, raw / "ddinter" / f) for f in m["ddinter"]["files"]]
    jobs.append((dl["nlem"], raw / "corpus" / "nlem2022.pdf"))
    jobs += [(dl["icmr_base"] + remote, raw / "corpus" / local) for local, remote in dl["icmr_files"].items()]
    if args.who:
        # The official WHO page links to IRIS, which blocks scripted downloads; this mirror served the same PDF
        # (ISBN 978 92 4 154765 9) on 2026-09-30. Verify the checksum and title page after download.
        jobs.append(("https://medbox.org/dl/5e148832db60a2044c2d1e80", raw / "corpus" / "who_model_formulary_2008.pdf"))
    for url, dest in jobs:
        try:
            fetch(url, dest)
        except Exception as e:  # noqa: BLE001
            failures.append((url, str(e)))
            print(f"FAILED  {url}: {e}", file=sys.stderr)
    print("\nSHA-256")
    for _url, dest in jobs:
        if dest.exists():
            print(f"{sha256(dest)}  {dest.relative_to(ROOT)}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
