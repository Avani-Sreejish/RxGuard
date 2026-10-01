"""Pydantic contracts (spec section 18.2).

All models forbid extra fields and strip whitespace. The four *AI output* models
(DrugExtraction, NormalizationChoice, ExplanationClaims, ToolPlan) are the only
shapes an LLM response can take; anything else is rejected before it is used.
"""
from __future__ import annotations

import re
from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator, model_validator

MAX_INPUT_CHARS = 20_000


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class AgeBand(str, Enum):
    under_12 = "<12"
    teen = "12-17"
    adult = "18-64"
    senior = "65+"
    unknown = "unknown"


class Severity(str, Enum):
    major = "Major"
    moderate = "Moderate"
    minor = "Minor"
    unknown = "Unknown"


class ReasonCode(str, Enum):
    MAJOR_INTERACTION = "MAJOR_INTERACTION"
    RED_FLAG = "RED_FLAG"
    PEDIATRIC = "PEDIATRIC"
    DOSING_REQUEST = "DOSING_REQUEST"
    UNRESOLVED_DRUG = "UNRESOLVED_DRUG"
    PROMPT_INJECTION = "PROMPT_INJECTION"
    CONFLICT = "CONFLICT"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"
    DECISION_REQUEST = "DECISION_REQUEST"


# ------------------------------------------------------------------ requests
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


class PrescriptionInput(Strict):
    text: str = Field(min_length=1, max_length=MAX_INPUT_CHARS)
    age_band: AgeBand = AgeBand.unknown
    note: str = Field(default="", max_length=2000)
    session_id: Optional[int] = Field(default=None, ge=1)

    @field_validator("text")
    @classmethod
    def reject_binary(cls, v: str) -> str:
        if "\x00" in v or len(_CONTROL_CHARS.findall(v)) > 5:
            raise ValueError("input looks binary, not text")
        if not v.strip():
            raise ValueError("No medications found in input")
        return v


class ExplainInput(Strict):
    prescription_id: int = Field(ge=1)


class TranslateInput(Strict):
    """Text already shown to the pharmacist (passages, verified claims, answers) to render in ml / hi."""
    lang: Literal["ml", "hi"]
    texts: list[str] = Field(min_length=1, max_length=8)

    @field_validator("texts")
    @classmethod
    def bounded(cls, v: list[str]) -> list[str]:
        if any(not t.strip() or len(t) > 1500 for t in v):
            raise ValueError("each text must be 1-1500 characters")
        if sum(len(t) for t in v) > 6000:
            raise ValueError("at most 6000 characters per request")
        return v


class TranslatedText(Strict):
    index: int = Field(ge=0, le=7)
    text: str = Field(min_length=1, max_length=4000)


class TranslationBatch(Strict):
    translations: list[TranslatedText] = Field(min_length=1, max_length=8)


class AskInput(Strict):
    session_id: int = Field(ge=1)
    question: str = Field(min_length=1, max_length=1000)


class ReviewActionType(str, Enum):
    ACKNOWLEDGE = "ACKNOWLEDGE"
    ESCALATE = "ESCALATE"
    REQUEST_MORE_EVIDENCE = "REQUEST_MORE_EVIDENCE"
    MARK_FOR_FOLLOW_UP = "MARK_FOR_FOLLOW_UP"


class ReviewAction(Strict):
    action: ReviewActionType
    note: str = Field(default="", max_length=1000)
    target: Literal["interaction", "duplication"] = "interaction"


class ConfirmItemInput(Strict):
    drug_id: Optional[int] = Field(default=None, ge=1)
    not_in_database: bool = False

    @model_validator(mode="after")
    def one_of(self):
        if (self.drug_id is None) == (not self.not_in_database):
            raise ValueError("give exactly one of drug_id or not_in_database=true")
        return self


class EscalationRequest(Strict):
    prescription_id: Optional[int] = Field(default=None, ge=1)
    session_id: Optional[int] = Field(default=None, ge=1)
    reason_code: ReasonCode
    trigger_rule_id: str = Field(pattern=r"^(R\d+|S\d+|MANUAL|AGENT)$")
    detail: str = Field(max_length=500)

    @model_validator(mode="after")
    def target(self):
        if not self.prescription_id and not self.session_id:
            raise ValueError("prescription_id or session_id is required")
        return self


# ------------------------------------------------------------------ tool I/O
class InteractionQuery(Strict):
    drug_ids: list[int] = Field(min_length=1, max_length=100)
    kb_version_id: int


class InteractionFact(Strict):
    interaction_id: int
    drug_a_id: int
    drug_b_id: int
    drug_a: str
    drug_b: str
    severity: Severity
    source: str
    source_record_id: str
    kb_version: str


class DuplicationFact(Strict):
    drug_id: int
    drug: str
    item_indexes: list[int]


class InteractionResult(Strict):
    kb_version: str
    pairs_checked: int
    findings: list[InteractionFact] = Field(max_length=500)
    duplications: list[DuplicationFact] = []
    absent_pairs_count: int


class ChunkOut(Strict):
    chunk_id: int
    document: str
    doc_type: str
    source: str
    version: str
    section: str
    page: Optional[int]
    license: str
    text: str
    text_hash: str
    score: float


class EvidenceResult(Strict):
    status: Literal["FOUND", "INSUFFICIENT"]
    retrieval_mode: Literal["faiss", "hybrid", "hybrid_rerank", "fulltext", "none"]
    degraded: bool
    chunks: list[ChunkOut] = Field(max_length=5)
    query: str


# ------------------------------------------------------------------ AI outputs
class DrugExtraction(Strict):
    """LLM output: medication name spans for lines the dictionary could not match.

    Spans are verified verbatim against the source line afterwards (see normalize.py)."""
    spans: list[str] = Field(max_length=25)

    @field_validator("spans")
    @classmethod
    def span_len(cls, v):
        for s in v:
            if not 2 <= len(s) <= 120:
                raise ValueError("each span must be 2-120 characters")
        return v


class NormalizationChoice(Strict):
    """LLM output: one of the offered candidate IDs, or null."""
    drug_id: Optional[int]

    @field_validator("drug_id")
    @classmethod
    def in_offered_set(cls, v, info: ValidationInfo):
        offered = (info.context or {}).get("offered_ids")
        if offered is None:
            raise ValueError("validation context with offered_ids is required")
        if v is not None and v not in offered:
            raise ValueError(f"drug_id {v} was not one of the offered candidates {sorted(offered)}")
        return v


class Claim(Strict):
    claim_id: str = Field(pattern=r"^c\d{1,3}$")
    finding_ordinal: int = Field(ge=1)
    text: str = Field(min_length=5, max_length=500)
    source_type: Literal["DATABASE", "RAG_CHUNK"]
    source_id: int = Field(ge=1)


class ExplanationClaims(Strict):
    claims: list[Claim] = Field(min_length=1, max_length=30)

    @field_validator("claims")
    @classmethod
    def unique_ids(cls, v):
        ids = [c.claim_id for c in v]
        if len(ids) != len(set(ids)):
            raise ValueError("claim_id values must be unique")
        return v


class ToolName(str, Enum):
    interaction_lookup = "interaction_lookup"
    guideline_search = "guideline_search"
    get_finding = "get_finding"
    escalate = "escalate"


class ToolCallSpec(Strict):
    tool: ToolName
    finding_ordinal: Optional[int] = Field(default=None, ge=1)
    drug_names: list[str] = Field(default=[], max_length=10)
    query: Optional[str] = Field(default=None, max_length=300)
    reason: Optional[str] = Field(default=None, max_length=300)

    @model_validator(mode="after")
    def required_args(self):
        t = self.tool
        if t == ToolName.get_finding and self.finding_ordinal is None:
            raise ValueError("get_finding requires finding_ordinal")
        if t == ToolName.interaction_lookup and len(self.drug_names) < 2 and self.finding_ordinal is None:
            raise ValueError("interaction_lookup requires >=2 drug_names or a finding_ordinal")
        if t == ToolName.guideline_search and not self.query:
            raise ValueError("guideline_search requires query")
        if t == ToolName.escalate and not self.reason:
            raise ValueError("escalate requires reason")
        return self


class ToolPlan(Strict):
    calls: list[ToolCallSpec] = Field(min_length=1, max_length=3)


def json_schema_for(model: type[BaseModel]) -> dict:
    """JSON schema accepted by the provider's structured-output mode.

    Structured outputs need additionalProperties=false on every object, and do not
    support every keyword (e.g. numeric bounds); Pydantic re-validates everything anyway."""
    schema = model.model_json_schema()
    unsupported = {"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength",
                   "minItems", "maxItems", "pattern", "title", "default"}

    def walk(node):
        if isinstance(node, dict):
            for k in list(node):
                if k in unsupported:
                    node.pop(k)
            if node.get("type") == "object":
                node["additionalProperties"] = False
                if "properties" in node:
                    node["required"] = list(node["properties"].keys())
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(schema)
    return schema
