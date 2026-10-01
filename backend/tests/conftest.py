"""Test fixtures. The fixture KB below is TEST DATA ONLY - its severities are fixture values chosen to
exercise the logic, not DDInter records. Real-data correctness is measured by eval/run.py."""
import os

os.environ.setdefault("DB_ENGINE", "sqlite")
os.environ.setdefault("DJANGO_DEBUG", "1")
os.environ.setdefault("DJANGO_SECRET_KEY", "test-only")
os.environ.pop("ANTHROPIC_API_KEY", None)  # tests never call a real LLM
os.environ.pop("GEMINI_API_KEY", None)
os.environ.pop("GOOGLE_API_KEY", None)

import pytest  # noqa: E402

from engine import context, normalize  # noqa: E402

DRUGS = ["Warfarin", "Acetylsalicylic acid", "Fluconazole", "Acetaminophen", "Ibuprofen", "Amlodipine",
         "Atorvastatin", "Clopidogrel", "Omeprazole"]
PAIRS = [("Warfarin", "Acetylsalicylic acid", "Major"), ("Warfarin", "Fluconazole", "Major"),
         ("Warfarin", "Acetaminophen", "Moderate"), ("Warfarin", "Ibuprofen", "Major"),
         ("Acetylsalicylic acid", "Ibuprofen", "Major"), ("Acetylsalicylic acid", "Fluconazole", "Unknown"),
         ("Clopidogrel", "Omeprazole", "Major")]


@pytest.fixture
def kb(db):
    from django.contrib.auth.models import Group, User

    from api.models import (ChunkDrugMention, CorpusChunk, CorpusDocument, Drug, DrugAlias, DrugInteraction,
                            KbVersion, Product, ProductIngredient)
    k = KbVersion.objects.create(label="vtest", is_current=True)
    d = {}
    for n in DRUGS:
        d[n] = Drug.objects.create(kb_version=k, generic_name=n, normalized_name=normalize.normalize_text(n),
                                   ddinter_id=f"T{len(d)}", source="TEST")
    for a, b, sev in PAIRS:
        x, y = sorted((d[a].id, d[b].id))
        DrugInteraction.objects.create(kb_version=k, drug_a_id=x, drug_b_id=y, severity=sev, source="DDInter",
                                       source_record_id=f"T{x}|T{y}")
    for alias, target in (("aspirin", "Acetylsalicylic acid"), ("paracetamol", "Acetaminophen")):
        DrugAlias.objects.create(kb_version=k, drug=d[target], alias=alias, alias_normalized=alias,
                                 alias_type="synonym", source="test")
    for brand, ings in (("Synwarf", ["Warfarin"]), ("Synpara", ["Acetaminophen"]),
                        ("Synflam", ["Ibuprofen", "Acetaminophen"])):
        p = Product.objects.create(kb_version=k, brand_name=brand, brand_normalized=brand.lower(), is_synthetic=True)
        for i in ings:
            ProductIngredient.objects.create(product=p, drug=d[i])
    doc = CorpusDocument.objects.create(kb_version=k, title="Test STW", doc_type="ICMR_STW", source="test",
                                        version="t", license="test", file_name="t.pdf", checksum="x")
    c = CorpusChunk.objects.create(document=doc, section_path="Test STW > Precipitants", page=1, text_hash="h",
                                   text="Stop all precipitants: aspirin, NSAIDs, antiplatelets and anticoagulants "
                                        "such as warfarin increase the risk of gastrointestinal bleeding.")
    ChunkDrugMention.objects.create(chunk=c, drug=d["Acetylsalicylic acid"])
    ChunkDrugMention.objects.create(chunk=c, drug=d["Warfarin"])
    g, _ = Group.objects.get_or_create(name="pharmacist")
    u = User.objects.create_user("pharm", password="pw")
    u.groups.add(g)
    normalize._index_cache.clear()
    from engine.tools import interaction_lookup
    interaction_lookup.clear_cache()
    return {"kb": k, "drugs": d, "user": u, "chunk": c}


@pytest.fixture
def ctx():
    c = context.RequestContext()
    token = context.set_context(c)
    yield c
    context.reset_context(token)


@pytest.fixture
def client(kb):
    from rest_framework.authtoken.models import Token
    from rest_framework.test import APIClient

    cl = APIClient()
    cl.credentials(HTTP_AUTHORIZATION="Token " + Token.objects.create(user=kb["user"]).key)
    return cl
