"""Print retrieval scores for in-corpus vs out-of-corpus queries to choose the cutoffs.

    python scripts/calibrate_retrieval.py            # FAISS scores -> RETRIEVAL_MIN_SCORE
    python scripts/calibrate_retrieval.py --rerank   # also cross-encoder scores -> RERANK_MIN_SCORE

Pick a cutoff between the lowest in-corpus top score and the highest out-of-corpus top score; the wider that
gap, the safer the cutoff. Then set RETRIEVAL_RERANK=1 and RERANK_MIN_SCORE in .env and re-run eval/run.py.
"""
import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "rxguard.settings")
import django  # noqa: E402

django.setup()
from api.models import CorpusChunk, KbVersion  # noqa: E402
from engine import retrieval  # noqa: E402

args = argparse.ArgumentParser()
args.add_argument("--rerank", action="store_true", help="also print cross-encoder scores of the hybrid candidates")
args = args.parse_args()
if args.rerank:
    from django.conf import settings
    settings.RXGUARD["RETRIEVAL_RERANK"] = True  # this script only; the server reads .env
kb = KbVersion.objects.get(is_current=True)
POS = ["Is clarithromycin in NLEM 2022, and at which level of care?",
       "Which dosage forms of amlodipine are listed in NLEM 2022?",
       "Which drugs does the ICMR STW for hypertension in adults list?",
       "Warfarin and Acetylsalicylic acid taken together: interaction, precautions, adverse effects",
       "Clopidogrel and Omeprazole taken together: interaction, precautions, adverse effects",
       "Enalapril and Potassium chloride taken together: interaction, precautions, adverse effects",
       "Which antibiotics are recommended for urinary tract infection?"]
NEG = ["What is the vaccination schedule for yellow fever in travellers?",
       "What is the best diet for chronic migraine sufferers?",
       "How do I renew my pharmacy licence?",
       "Explain the plot of a cricket match",
       "What is the capital of France?"]
tops = {}
for label, qs in (("IN-CORPUS", POS), ("OUT-OF-CORPUS", NEG)):
    print(f"== {label}")
    for q in qs:
        hits = retrieval.search(kb.label, q, 3)
        rows = {c.faiss_row: c for c in CorpusChunk.objects.filter(document__kb_version=kb,
                                                                    faiss_row__in=[r for r, _ in hits])}
        line = f"{hits[0][1]:.3f}"
        tops.setdefault((label, "faiss"), []).append(hits[0][1])
        if args.rerank:
            texts = dict(CorpusChunk.objects.filter(document__kb_version=kb).values_list("faiss_row", "text"))
            cands = retrieval.hybrid_search(kb.label, q, 3, fetch_texts=lambda rs: {r: texts[r] for r in rs})
            best = max((c["rerank"] for c in cands if c["rerank"] is not None), default=None)
            if best is None:
                print("reranker unavailable: is sentence-transformers installed and RERANK_MODEL downloadable?")
                sys.exit(1)
            tops.setdefault((label, "rerank"), []).append(best)
            line += f"  rerank {best:.3f}"
        print(f"{line}  {q[:70]}")
        for r, s in hits[:2]:
            print(f"        {s:.3f} {rows[r].section_path[:90]}")
print("== SUMMARY (top score per query)")
for kind in ("faiss", "rerank"):
    if (("IN-CORPUS", kind)) in tops:
        lo, hi = min(tops[("IN-CORPUS", kind)]), max(tops[("OUT-OF-CORPUS", kind)])
        print(f"{kind:6s}: in-corpus min {lo:.3f} · out-of-corpus max {hi:.3f} · gap {lo - hi:+.3f}")
