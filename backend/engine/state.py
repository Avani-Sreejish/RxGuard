"""AgentState: the LangGraph state, snapshotted to agent_steps after every node."""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field


class AgentState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    correlation_id: str
    graph: str = "check"
    user_id: int
    prescription_id: Optional[int] = None
    session_id: Optional[int] = None
    kb_id: int
    kb_label: str
    # raw input is kept in memory only; snapshots store its hash (see snapshot())
    text: str = ""
    note: str = ""
    age_band: str = "unknown"
    lines: list[dict] = Field(default_factory=list)
    lines_ignored: int = 0
    flags: dict = Field(default_factory=dict)
    safety_messages: list[dict] = Field(default_factory=list)
    resolutions: list[dict] = Field(default_factory=list)
    llm_spans: dict = Field(default_factory=dict)  # line_no -> [verbatim spans]
    findings: list[dict] = Field(default_factory=list)
    duplications: list[dict] = Field(default_factory=list)
    pairs_checked: int = 0
    absent_pairs_count: int = 0
    triage: dict = Field(default_factory=dict)
    priority: str = "CLEAR"
    status: str = "CHECKED"
    evidence: dict = Field(default_factory=dict)  # ordinal(str) -> EvidenceResult
    explanation_id: Optional[int] = None
    explanation: dict = Field(default_factory=dict)
    escalations: list[dict] = Field(default_factory=list)
    budget: dict = Field(default_factory=dict)
    fallback_level: int = 0
    errors: list[str] = Field(default_factory=list)
    extra: dict[str, Any] = Field(default_factory=dict)

    def snapshot(self) -> dict:
        d = self.model_dump(exclude={"text", "note"})
        d["has_text"] = bool(self.text)
        return d
