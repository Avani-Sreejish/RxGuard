"""Profile one /check request in-process (dev DB) and print the top cumulative hotspots.

    python scripts/profile_check.py
"""
import cProfile
import os
import pstats
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "rxguard.settings")
os.environ["DJANGO_ALLOWED_HOSTS"] = "testserver"
import django  # noqa: E402

django.setup()
from django.contrib.auth.models import User  # noqa: E402
from rest_framework.test import APIClient  # noqa: E402

from api.demo import MAIN  # noqa: E402

c = APIClient()
c.force_authenticate(User.objects.get(username="eval-runner"))
for _ in range(3):  # warm caches
    c.post("/api/v1/check", {"text": MAIN}, format="json")
pr = cProfile.Profile()
pr.enable()
for _ in range(5):
    c.post("/api/v1/check", {"text": MAIN}, format="json")
pr.disable()
st = pstats.Stats(pr).sort_stats(os.environ.get("SORT", "cumulative"))
st.print_stats(int(os.environ.get("TOP", "35"))) if os.environ.get("SORT") else st.print_stats(r"rxguard|engine|api|langgraph|pydantic|MySQLdb|django/db", 35)
