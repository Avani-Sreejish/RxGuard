"""Test settings: SQLite, no LLM key, no FAISS index (retrieval exercises the FULLTEXT fallback)."""
import os

os.environ["DB_ENGINE"] = "sqlite"
os.environ["SQLITE_PATH"] = ":memory:"
os.environ["DJANGO_DEBUG"] = "1"
os.environ.setdefault("DJANGO_SECRET_KEY", "test-only")
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("GEMINI_API_KEY", None)
os.environ.pop("GOOGLE_API_KEY", None)
os.environ["INDEX_DIR"] = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".test-no-index")

from rxguard.settings import *  # noqa: E402,F401,F403
