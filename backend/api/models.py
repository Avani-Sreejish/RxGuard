"""MySQL schema for RxGuard (spec section 18.1).

Facts (drugs, interactions, corpus) are versioned by KbVersion. Workflow records
(prescriptions, findings, reviews) snapshot the facts they were built from, so an
old review stays reproducible after the knowledge base is reloaded.
"""
from django.conf import settings
from django.db import models
from django.db.models import F, Q

SEVERITIES = [("Major", "Major"), ("Moderate", "Moderate"), ("Minor", "Minor"), ("Unknown", "Unknown")]


# ---------------------------------------------------------------- provenance / versions
class KbVersion(models.Model):
    label = models.CharField(max_length=32, unique=True)
    loaded_at = models.DateTimeField(auto_now_add=True)
    is_current = models.BooleanField(default=False, db_index=True)
    notes = models.TextField(blank=True)

    class Meta:
        db_table = "kb_versions"

    def __str__(self):
        return self.label


class DataSource(models.Model):
    kb_version = models.ForeignKey(KbVersion, on_delete=models.CASCADE, related_name="sources")
    name = models.CharField(max_length=128)
    version = models.CharField(max_length=64)
    license = models.TextField()
    url = models.URLField(max_length=500, blank=True)
    retrieved_at = models.DateTimeField()
    checksum = models.CharField(max_length=64, blank=True)
    is_synthetic = models.BooleanField(default=False)
    notes = models.TextField(blank=True)

    class Meta:
        db_table = "data_sources"


# ---------------------------------------------------------------- drug knowledge
class Drug(models.Model):
    kb_version = models.ForeignKey(KbVersion, on_delete=models.CASCADE)
    generic_name = models.CharField(max_length=200)
    normalized_name = models.CharField(max_length=200)
    ddinter_id = models.CharField(max_length=32, blank=True, db_index=True)
    nlem_listed = models.BooleanField(default=False)
    nlem_section = models.CharField(max_length=32, blank=True)
    nlem_level_of_care = models.CharField(max_length=16, blank=True)
    nlem_dosage_forms = models.JSONField(default=list, blank=True)
    source = models.CharField(max_length=32)  # DDInter | NLEM | DDInter+NLEM

    class Meta:
        db_table = "drugs"
        constraints = [models.UniqueConstraint(fields=["kb_version", "normalized_name"], name="uniq_drug_norm_per_kb")]

    def __str__(self):
        return self.generic_name


class DrugAlias(models.Model):
    ALIAS_TYPES = [("generic", "generic"), ("synonym", "synonym"), ("brand", "brand"),
                   ("abbreviation", "abbreviation"), ("misspelling", "misspelling")]
    kb_version = models.ForeignKey(KbVersion, on_delete=models.CASCADE)
    drug = models.ForeignKey(Drug, on_delete=models.CASCADE, related_name="aliases")
    alias = models.CharField(max_length=200)
    alias_normalized = models.CharField(max_length=200, db_index=True)
    alias_type = models.CharField(max_length=16, choices=ALIAS_TYPES)
    source = models.CharField(max_length=64)
    is_synthetic = models.BooleanField(default=False)

    class Meta:
        db_table = "drug_aliases"


class Product(models.Model):
    """Brand / combination product. All rows in this build are SYNTHETIC DEMO DATA."""
    kb_version = models.ForeignKey(KbVersion, on_delete=models.CASCADE)
    brand_name = models.CharField(max_length=200)
    brand_normalized = models.CharField(max_length=200, db_index=True)
    is_synthetic = models.BooleanField(default=True)

    class Meta:
        db_table = "products"


class ProductIngredient(models.Model):
    product = models.ForeignKey(Product, on_delete=models.CASCADE, related_name="ingredients")
    drug = models.ForeignKey(Drug, on_delete=models.CASCADE)

    class Meta:
        db_table = "product_ingredients"


class DrugInteraction(models.Model):
    kb_version = models.ForeignKey(KbVersion, on_delete=models.CASCADE)
    drug_a = models.ForeignKey(Drug, on_delete=models.CASCADE, related_name="+")
    drug_b = models.ForeignKey(Drug, on_delete=models.CASCADE, related_name="+")
    severity = models.CharField(max_length=16, choices=SEVERITIES)
    source = models.CharField(max_length=32, default="DDInter")
    source_record_id = models.CharField(max_length=64)

    class Meta:
        db_table = "drug_interactions"
        constraints = [
            models.CheckConstraint(condition=Q(drug_a__lt=F("drug_b")), name="interaction_canonical_order"),
            models.UniqueConstraint(fields=["drug_a", "drug_b", "source", "kb_version"], name="uniq_interaction"),
        ]
        indexes = [models.Index(fields=["kb_version", "drug_a", "drug_b"])]


# ---------------------------------------------------------------- corpus
class CorpusDocument(models.Model):
    kb_version = models.ForeignKey(KbVersion, on_delete=models.CASCADE)
    title = models.CharField(max_length=300)
    doc_type = models.CharField(max_length=32)  # NLEM | ICMR_STW | WHO
    source = models.CharField(max_length=64)
    version = models.CharField(max_length=64)
    license = models.TextField()
    url = models.URLField(max_length=500, blank=True)
    file_name = models.CharField(max_length=200)
    checksum = models.CharField(max_length=64)

    class Meta:
        db_table = "corpus_documents"


class CorpusChunk(models.Model):
    document = models.ForeignKey(CorpusDocument, on_delete=models.CASCADE, related_name="chunks")
    section_path = models.CharField(max_length=400)
    page = models.IntegerField(null=True)
    text = models.TextField()
    text_hash = models.CharField(max_length=64)
    faiss_row = models.IntegerField(null=True, db_index=True)

    class Meta:
        db_table = "corpus_chunks"


class ChunkDrugMention(models.Model):
    chunk = models.ForeignKey(CorpusChunk, on_delete=models.CASCADE, related_name="mentions")
    drug = models.ForeignKey(Drug, on_delete=models.CASCADE)
    via = models.CharField(max_length=64, default="direct")  # "direct" or "class:<term>" (curated class map)

    class Meta:
        db_table = "chunk_drug_mentions"
        constraints = [models.UniqueConstraint(fields=["chunk", "drug"], name="uniq_chunk_drug")]


# ---------------------------------------------------------------- sessions / prescriptions
class Session(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "sessions"


class Prescription(models.Model):
    STATUSES = [("CHECKED", "CHECKED"), ("EXPLAINED", "EXPLAINED"), ("AWAITING_PHARMACIST", "AWAITING_PHARMACIST"),
                ("IN_REVIEW", "IN_REVIEW"), ("REVIEWED", "REVIEWED"), ("CLEAR", "CLEAR")]
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    session = models.ForeignKey(Session, on_delete=models.SET_NULL, null=True, related_name="prescriptions")
    raw_text = models.TextField()  # synthetic prescriptions only
    raw_text_hash = models.CharField(max_length=64)
    age_band = models.CharField(max_length=16, default="unknown")
    note = models.TextField(blank=True)
    status = models.CharField(max_length=24, choices=STATUSES, default="CHECKED")
    injection_flag = models.BooleanField(default=False)
    injection_patterns = models.JSONField(default=list, blank=True)
    priority = models.CharField(max_length=8, default="CLEAR")
    kb_version = models.ForeignKey(KbVersion, on_delete=models.PROTECT)
    correlation_id = models.CharField(max_length=64, db_index=True)
    lines_ignored = models.IntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "prescriptions"


class SessionMessage(models.Model):
    session = models.ForeignKey(Session, on_delete=models.CASCADE, related_name="messages")
    role = models.CharField(max_length=16)  # user | assistant | system
    content = models.TextField()
    prescription = models.ForeignKey(Prescription, on_delete=models.SET_NULL, null=True)
    payload = models.JSONField(default=dict, blank=True)
    correlation_id = models.CharField(max_length=64)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "session_messages"
        ordering = ["id"]


class PrescriptionItem(models.Model):
    METHODS = [("exact", "exact"), ("fuzzy", "fuzzy"), ("llm_choice", "llm_choice"),
               ("pharmacist", "pharmacist"), ("unresolved", "unresolved")]
    prescription = models.ForeignKey(Prescription, on_delete=models.CASCADE, related_name="items")
    line_no = models.IntegerField()
    raw_span = models.TextField()
    matched_text = models.CharField(max_length=200, blank=True)
    drug = models.ForeignKey(Drug, on_delete=models.PROTECT, null=True)
    product = models.ForeignKey(Product, on_delete=models.PROTECT, null=True)
    method = models.CharField(max_length=16, choices=METHODS)
    confidence = models.FloatField(null=True)
    needs_confirmation = models.BooleanField(default=False)
    candidates = models.JSONField(default=list, blank=True)

    class Meta:
        db_table = "prescription_items"
        ordering = ["line_no", "id"]


class TriageRuleHit(models.Model):
    prescription = models.ForeignKey(Prescription, on_delete=models.CASCADE, related_name="rule_hits")
    rule_id = models.CharField(max_length=8)
    priority = models.CharField(max_length=8)
    description = models.CharField(max_length=200)
    input_summary = models.TextField()
    result = models.CharField(max_length=200)

    class Meta:
        db_table = "triage_rule_hits"


class InteractionFinding(models.Model):
    prescription = models.ForeignKey(Prescription, on_delete=models.CASCADE, related_name="findings")
    ordinal = models.IntegerField()
    interaction = models.ForeignKey(DrugInteraction, on_delete=models.PROTECT)
    drug_a = models.ForeignKey(Drug, on_delete=models.PROTECT, related_name="+")
    drug_b = models.ForeignKey(Drug, on_delete=models.PROTECT, related_name="+")
    # snapshot of the fact as seen at check time
    drug_a_name = models.CharField(max_length=200)
    drug_b_name = models.CharField(max_length=200)
    severity = models.CharField(max_length=16, choices=SEVERITIES)
    source = models.CharField(max_length=32)
    source_record_id = models.CharField(max_length=64)
    kb_version = models.ForeignKey(KbVersion, on_delete=models.PROTECT)
    priority = models.CharField(max_length=8)
    rule_id = models.CharField(max_length=8)
    evidence_status = models.CharField(max_length=16, default="PENDING")  # PENDING|FOUND|INSUFFICIENT
    review_status = models.CharField(max_length=24, default="pending")

    class Meta:
        db_table = "interaction_findings"
        ordering = ["ordinal"]


class DuplicationFinding(models.Model):
    prescription = models.ForeignKey(Prescription, on_delete=models.CASCADE, related_name="duplications")
    drug = models.ForeignKey(Drug, on_delete=models.PROTECT)
    items = models.JSONField()  # list of prescription_item ids
    item_labels = models.JSONField(default=list)

    class Meta:
        db_table = "duplication_findings"


class Explanation(models.Model):
    prescription = models.ForeignKey(Prescription, on_delete=models.CASCADE, related_name="explanations")
    mode = models.CharField(max_length=16)  # llm | template
    model = models.CharField(max_length=64, blank=True)
    prompt_version = models.CharField(max_length=32, blank=True)
    fallback_level = models.IntegerField(default=0)
    degraded_retrieval = models.BooleanField(default=False)
    correlation_id = models.CharField(max_length=64)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "explanations"


class ExplanationClaim(models.Model):
    explanation = models.ForeignKey(Explanation, on_delete=models.CASCADE, related_name="claims")
    claim_key = models.CharField(max_length=16)
    finding = models.ForeignKey(InteractionFinding, on_delete=models.CASCADE, null=True, related_name="claims")
    text = models.TextField()
    source_type = models.CharField(max_length=16)  # DATABASE | RAG_CHUNK | TEMPLATE
    interaction = models.ForeignKey(DrugInteraction, on_delete=models.PROTECT, null=True)
    chunk = models.ForeignKey(CorpusChunk, on_delete=models.PROTECT, null=True)
    support_score = models.FloatField(null=True)
    support_span = models.TextField(blank=True)
    kept = models.BooleanField()
    drop_reason = models.CharField(max_length=200, blank=True)

    class Meta:
        db_table = "explanation_claims"


class EvidenceLink(models.Model):
    finding = models.ForeignKey(InteractionFinding, on_delete=models.CASCADE, related_name="evidence")
    chunk = models.ForeignKey(CorpusChunk, on_delete=models.PROTECT, null=True)
    status = models.CharField(max_length=16)  # FOUND | INSUFFICIENT
    score = models.FloatField(null=True)
    retrieval_mode = models.CharField(max_length=16)  # faiss | hybrid | hybrid_rerank | fulltext | none
    kb_version = models.ForeignKey(KbVersion, on_delete=models.PROTECT)

    class Meta:
        db_table = "evidence_links"


class Escalation(models.Model):
    REASONS = [(r, r) for r in ("MAJOR_INTERACTION", "RED_FLAG", "PEDIATRIC", "DOSING_REQUEST", "UNRESOLVED_DRUG",
                                "PROMPT_INJECTION", "CONFLICT", "INSUFFICIENT_EVIDENCE", "DECISION_REQUEST")]
    prescription = models.ForeignKey(Prescription, on_delete=models.CASCADE, null=True, related_name="escalations")
    session = models.ForeignKey(Session, on_delete=models.CASCADE, null=True)
    reason_code = models.CharField(max_length=32, choices=REASONS)
    trigger_rule_id = models.CharField(max_length=16)
    detail = models.CharField(max_length=500)
    status = models.CharField(max_length=16, default="OPEN")
    created_by = models.CharField(max_length=64)  # system | agent | user:<id>
    correlation_id = models.CharField(max_length=64)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "escalations"


class PharmacistReview(models.Model):
    ACTIONS = [(a, a) for a in ("ACKNOWLEDGE", "ESCALATE", "REQUEST_MORE_EVIDENCE", "MARK_FOR_FOLLOW_UP")]
    prescription = models.ForeignKey(Prescription, on_delete=models.CASCADE, related_name="reviews")
    finding = models.ForeignKey(InteractionFinding, on_delete=models.CASCADE, null=True, related_name="reviews")
    duplication = models.ForeignKey(DuplicationFinding, on_delete=models.CASCADE, null=True, related_name="reviews")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    action = models.CharField(max_length=32, choices=ACTIONS)
    note = models.TextField(blank=True)
    kb_version_seen = models.ForeignKey(KbVersion, on_delete=models.PROTECT)
    correlation_id = models.CharField(max_length=64)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "pharmacist_reviews"


# ---------------------------------------------------------------- observability
class AgentStep(models.Model):
    correlation_id = models.CharField(max_length=64, db_index=True)
    prescription = models.ForeignKey(Prescription, on_delete=models.CASCADE, null=True)
    graph = models.CharField(max_length=16)  # check | explain | ask
    node = models.CharField(max_length=48)
    status = models.CharField(max_length=16)
    latency_ms = models.FloatField()
    summary = models.TextField(blank=True)
    state = models.JSONField(default=dict)  # serialised AgentState after the node
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "agent_steps"
        ordering = ["id"]


class LlmCall(models.Model):
    correlation_id = models.CharField(max_length=64, db_index=True)
    node = models.CharField(max_length=48)
    model = models.CharField(max_length=64)
    prompt_version = models.CharField(max_length=32, blank=True)
    input_tokens = models.IntegerField(default=0)
    output_tokens = models.IntegerField(default=0)
    est_cost_usd = models.DecimalField(max_digits=12, decimal_places=6, default=0)
    latency_ms = models.FloatField(default=0)
    fallback_level = models.IntegerField(default=0)
    status = models.CharField(max_length=24)  # ok | schema_error | api_error | timeout | refusal | cap_reached
    error = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "llm_calls"


class ToolCall(models.Model):
    correlation_id = models.CharField(max_length=64, db_index=True)
    tool = models.CharField(max_length=32)
    args_summary = models.TextField()
    result_summary = models.TextField()
    latency_ms = models.FloatField()
    status = models.CharField(max_length=16)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "tool_calls"


class RequestLog(models.Model):
    correlation_id = models.CharField(max_length=64, db_index=True)
    endpoint = models.CharField(max_length=200, db_index=True)
    method = models.CharField(max_length=8)
    status_code = models.IntegerField()
    latency_ms = models.FloatField()
    user_id = models.IntegerField(null=True)
    llm_calls = models.IntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "request_logs"


class AuditLog(models.Model):
    prescription = models.ForeignKey(Prescription, on_delete=models.CASCADE, related_name="audit")
    seq = models.IntegerField()
    correlation_id = models.CharField(max_length=64)
    actor = models.CharField(max_length=64)
    event_type = models.CharField(max_length=48)
    entity = models.CharField(max_length=64)
    payload = models.JSONField()
    kb_version = models.CharField(max_length=32)
    timestamp = models.CharField(max_length=40)  # ISO string, hashed exactly as stored
    prev_hash = models.CharField(max_length=64)
    hash = models.CharField(max_length=64)

    class Meta:
        db_table = "audit_logs"
        ordering = ["prescription_id", "seq"]
        constraints = [models.UniqueConstraint(fields=["prescription", "seq"], name="uniq_audit_seq")]


class PromptVersion(models.Model):
    name = models.CharField(max_length=64)
    version = models.CharField(max_length=32)
    template = models.TextField()
    template_hash = models.CharField(max_length=64)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "prompt_versions"
        constraints = [models.UniqueConstraint(fields=["name", "version"], name="uniq_prompt_version")]


class EvaluationRun(models.Model):
    prompt_version = models.CharField(max_length=200)
    kb_version = models.CharField(max_length=32)
    git_sha = models.CharField(max_length=64, blank=True)
    llm_mode = models.CharField(max_length=32)
    summary = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "evaluation_runs"


class EvaluationResult(models.Model):
    run = models.ForeignKey(EvaluationRun, on_delete=models.CASCADE, related_name="results")
    case_id = models.CharField(max_length=16)
    metric = models.CharField(max_length=4)
    passed = models.BooleanField()
    score = models.FloatField(null=True)
    detail = models.TextField(blank=True)

    class Meta:
        db_table = "evaluation_results"
