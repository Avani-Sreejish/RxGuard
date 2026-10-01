"""Hybrid retrieval (BM25 + RRF + reranker) and the Gemini provider. No model downloads, no network:
the dense search, reranker and Gemini client are replaced by fakes; BM25 runs for real on fixture chunks."""
from types import SimpleNamespace

import pytest

from engine import llm_gateway, prompts, retrieval
from engine.schemas import NormalizationChoice


# ---- BM25 / RRF -------------------------------------------------------------------------------------------

def test_tokenize_drops_stopwords_and_case():
    assert retrieval.tokenize("Which drugs does the ICMR STW list?") == ["drugs", "icmr", "stw", "list"]


def test_rrf_rewards_agreement_between_rankers():
    fused = retrieval.rrf_fuse([(1, 0.9), (2, 0.8), (3, 0.7)], [(3, 12.0), (2, 5.0)])
    assert [r for r, _ in fused] == [3, 2, 1]  # rank 1 + rank 3 edges out rank 2 + rank 2


@pytest.fixture
def corpus(kb):
    """Three chunks with FAISS rows: the fixture chunk (row 0) plus two more."""
    from api.models import ChunkDrugMention, CorpusChunk

    d = kb["drugs"]
    doc = kb["chunk"].document
    kb["chunk"].faiss_row = 0
    kb["chunk"].save(update_fields=["faiss_row"])
    htn = CorpusChunk.objects.create(document=doc, section_path="Hypertension in Adults > Drugs", page=2,
                                     text_hash="h1", faiss_row=1,
                                     text="First-line antihypertensives: amlodipine, telmisartan, chlorthalidone.")
    other = CorpusChunk.objects.create(document=doc, section_path="Fever > Assessment", page=3, text_hash="h2",
                                       faiss_row=2, text="Assess the child for danger signs and dehydration.")
    ChunkDrugMention.objects.create(chunk=htn, drug=d["Amlodipine"])
    retrieval._bm25.clear()
    yield {**kb, "htn": htn, "other": other}
    retrieval._bm25.clear()


def test_bm25_ranks_keyword_match_first(corpus):
    hits = retrieval.bm25_search("vtest", "hypertension drugs amlodipine", 5)
    assert hits[0][0] == 1
    assert 2 not in [r for r, _ in hits]  # no shared term -> not returned
    assert retrieval.bm25_search("vtest", "hypertension", 5, allowed_rows=[0, 2]) == []


# ---- guideline_search threshold logic ---------------------------------------------------------------------

def _fake_dense(monkeypatch, scores: dict[int, float]):
    """Dense search returns `scores` best-first; dense_scores() serves rows the dense ranking did not return."""
    ranked = sorted(scores.items(), key=lambda x: -x[1])
    monkeypatch.setattr(retrieval, "embed", lambda texts, kind: [[0.0]] * len(texts))
    monkeypatch.setattr(retrieval, "search", lambda kb_label, q, k, allowed=None, query_vector=None: [
        (r, s) for r, s in ranked if allowed is None or r in allowed][:k])
    monkeypatch.setattr(retrieval, "dense_scores", lambda kb_label, rows, qv: {r: scores[r] for r in rows})


def test_hybrid_keeps_dense_cutoff_when_reranker_off(corpus, ctx, settings, monkeypatch):
    from engine.tools.guideline_search import guideline_search

    settings.RXGUARD = {**settings.RXGUARD, "RETRIEVAL_HYBRID": True, "RETRIEVAL_RERANK": False,
                        "RETRIEVAL_MIN_SCORE": 0.81}
    _fake_dense(monkeypatch, {0: 0.83, 1: 0.79, 2: 0.70})
    r = guideline_search(corpus["kb"].id, "vtest", [], "hypertension drugs amlodipine", 3)
    # chunk 1 is BM25's top hit but its dense score is below the cutoff: keyword overlap alone never passes
    assert r["retrieval_mode"] == "hybrid"
    assert [c["chunk_id"] for c in r["chunks"]] == [corpus["chunk"].id]


def test_reranker_score_decides_when_enabled(corpus, ctx, settings, monkeypatch):
    from engine.tools.guideline_search import guideline_search

    settings.RXGUARD = {**settings.RXGUARD, "RETRIEVAL_HYBRID": True, "RETRIEVAL_RERANK": True,
                        "RERANK_MIN_SCORE": 0.5}
    _fake_dense(monkeypatch, {0: 0.83, 1: 0.79, 2: 0.70})
    seen = {}

    def fake_rerank(query, texts):
        seen["texts"] = texts
        return [0.9 if "antihypertensives" in t else 0.1 for t in texts]

    monkeypatch.setattr(retrieval, "rerank", fake_rerank)
    r = guideline_search(corpus["kb"].id, "vtest", [], "hypertension drugs amlodipine", 3)
    assert r["retrieval_mode"] == "hybrid_rerank"
    assert [c["chunk_id"] for c in r["chunks"]] == [corpus["htn"].id]
    assert r["chunks"][0]["score"] == 0.9
    assert any("antihypertensives" in t for t in seen["texts"])


def test_reranker_unavailable_falls_back_to_dense_cutoff(corpus, ctx, settings, monkeypatch):
    from engine.tools.guideline_search import guideline_search

    settings.RXGUARD = {**settings.RXGUARD, "RETRIEVAL_HYBRID": True, "RETRIEVAL_RERANK": True,
                        "RETRIEVAL_MIN_SCORE": 0.81}
    _fake_dense(monkeypatch, {0: 0.83, 1: 0.79, 2: 0.70})

    def broken(query, texts):
        raise retrieval.RerankerUnavailable("model not downloaded")

    monkeypatch.setattr(retrieval, "rerank", broken)
    r = guideline_search(corpus["kb"].id, "vtest", [], "hypertension drugs amlodipine", 3)
    assert r["retrieval_mode"] == "hybrid"
    assert [c["chunk_id"] for c in r["chunks"]] == [corpus["chunk"].id]


def test_hybrid_respects_drug_prefilter(corpus, ctx, settings, monkeypatch):
    """Pair evidence must still mention both drugs, whatever BM25 or the reranker think."""
    from engine.tools.guideline_search import guideline_search

    settings.RXGUARD = {**settings.RXGUARD, "RETRIEVAL_HYBRID": True, "RETRIEVAL_RERANK": True,
                        "RERANK_MIN_SCORE": 0.5}
    _fake_dense(monkeypatch, {0: 0.83, 1: 0.95, 2: 0.70})
    monkeypatch.setattr(retrieval, "rerank", lambda q, texts: [0.99] * len(texts))
    d = corpus["drugs"]
    r = guideline_search(corpus["kb"].id, "vtest", [d["Warfarin"].id, d["Acetylsalicylic acid"].id],
                         "warfarin aspirin amlodipine hypertension", 3, require_all=True)
    assert [c["chunk_id"] for c in r["chunks"]] == [corpus["chunk"].id]


# ---- Gemini provider ----------------------------------------------------------------------------------------

PROMPT = prompts.Prompt(name="test_prompt", version="v1", system="Return JSON.")


class FakeGemini:
    """Stands in for google.genai.Client: `responses` are returned (or raised) in order."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        self.models = self

    def generate_content(self, model, contents, config):
        self.calls.append((model, contents, config))
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def resp(text, finish="STOP", prompt_tokens=100, out=20, thoughts=30):
    return SimpleNamespace(
        text=text, prompt_feedback=None,
        candidates=[SimpleNamespace(finish_reason=SimpleNamespace(name=finish))],
        usage_metadata=SimpleNamespace(prompt_token_count=prompt_tokens, candidates_token_count=out,
                                       thoughts_token_count=thoughts))


@pytest.fixture
def gemini(settings, monkeypatch, db):
    settings.RXGUARD = {**settings.RXGUARD, "LLM_PRIMARY_MODEL": "gemini-3.5-flash",
                        "LLM_FALLBACK_MODEL": "gemini-3.5-flash-lite", "LLM_GEMINI_THINKING_LEVEL": "low",
                        "LLM_PRICES": "gemini-3.5-flash=1.00:2.00"}
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")

    def install(responses):
        fake = FakeGemini(responses)
        monkeypatch.setattr(llm_gateway, "_gemini", lambda: fake)
        return fake
    return install


def test_provider_routing_and_configured(settings, monkeypatch):
    assert llm_gateway.provider("gemini-3.5-flash") == "gemini"
    assert llm_gateway.provider("claude-haiku-4-5") == "anthropic"
    settings.RXGUARD = {**settings.RXGUARD, "LLM_PRIMARY_MODEL": "gemini-3.5-flash",
                        "LLM_FALLBACK_MODEL": "claude-haiku-4-5"}
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert not llm_gateway.configured()
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    assert llm_gateway.configured()


def test_gemini_ok_validates_and_logs_tokens(gemini, ctx):
    from api.models import LlmCall

    fake = gemini([resp('{"drug_id": null}')])
    budget = llm_gateway.Budget()
    obj, meta = llm_gateway.call_structured("normalize", PROMPT, "choose", NormalizationChoice, budget,
                                            validation_context={"offered_ids": []})
    assert obj.drug_id is None and meta["model"] == "gemini-3.5-flash" and meta["fallback_level"] == 0
    model, contents, config = fake.calls[0]
    assert config.response_mime_type == "application/json" and config.response_json_schema["type"] == "object"
    assert config.thinking_config.thinking_level.lower() == "low"
    call = LlmCall.objects.get()
    assert (call.input_tokens, call.output_tokens) == (100, 50)  # thinking tokens are billed as output
    assert float(call.est_cost_usd) == pytest.approx((100 * 1.0 + 50 * 2.0) / 1e6)
    assert budget.input_tokens == 100 and budget.output_tokens == 50


def test_gemini_rate_limit_falls_back_to_lite_model(gemini, ctx):
    from google.genai import errors

    from api.models import LlmCall

    quota = errors.ClientError(429, {"error": {"code": 429, "message": "quota", "status": "RESOURCE_EXHAUSTED"}})
    fake = gemini([quota, resp('{"drug_id": null}')])
    obj, meta = llm_gateway.call_structured("normalize", PROMPT, "choose", NormalizationChoice,
                                            llm_gateway.Budget(), validation_context={"offered_ids": []})
    assert meta["model"] == "gemini-3.5-flash-lite" and meta["fallback_level"] == 1
    assert "thinking_config" not in fake.calls[1][2].model_fields_set or fake.calls[1][2].thinking_config is None
    assert list(LlmCall.objects.order_by("id").values_list("status", flat=True)) == ["rate_limited", "ok"]


def test_gemini_truncation_retries_then_safety_blocks_go_to_template(gemini, ctx):
    fake = gemini([resp("{", finish="MAX_TOKENS"), resp("", finish="SAFETY"), resp("", finish="SAFETY")])
    budget = llm_gateway.Budget()
    with pytest.raises(llm_gateway.LlmUnavailable):
        llm_gateway.call_structured("normalize", PROMPT, "choose", NormalizationChoice, budget,
                                    validation_context={"offered_ids": []})
    # truncated output is retried on the same model; a safety block skips straight to the next model
    assert [c[0] for c in fake.calls] == ["gemini-3.5-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"]
    assert budget.fallback_level == 2  # caller switches to template mode


def test_gemini_missing_key_is_template_mode_not_crash(settings, monkeypatch, ctx, db):
    settings.RXGUARD = {**settings.RXGUARD, "LLM_PRIMARY_MODEL": "gemini-3.5-flash",
                        "LLM_FALLBACK_MODEL": "gemini-3.5-flash-lite"}
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    with pytest.raises(llm_gateway.LlmUnavailable, match="GEMINI_API_KEY"):
        llm_gateway.call_structured("normalize", PROMPT, "choose", NormalizationChoice, llm_gateway.Budget(),
                                    validation_context={"offered_ids": []})
