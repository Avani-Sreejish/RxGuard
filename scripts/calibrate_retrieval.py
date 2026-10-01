"""Print FAISS scores for in-corpus vs out-of-corpus queries to choose RETRIEVAL_MIN_SCORE.

    python scripts/calibrate_retrieval.py
"""
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
for label, qs in (("IN-CORPUS", POS), ("OUT-OF-CORPUS", NEG)):
    print(f"== {label}")
    for q in qs:
        hits = retrieval.search(kb.label, q, 3)
        rows = {c.faiss_row: c for c in CorpusChunk.objects.filter(document__kb_version=kb,
                                                                    faiss_row__in=[r for r, _ in hits])}
        print(f"{hits[0][1]:.3f}  {q[:70]}")
        for r, s in hits[:2]:
            print(f"        {s:.3f} {rows[r].section_path[:90]}")
