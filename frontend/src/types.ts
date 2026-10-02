// Shapes returned by the RxGuard Django API (backend/api/serializers.py and views.py).
export type Priority = "P1" | "P2" | "P3" | "CLEAR";
export type Severity = "Major" | "Moderate" | "Minor" | "Unknown";
export type ReviewActionType = "ACKNOWLEDGE" | "ESCALATE" | "REQUEST_MORE_EVIDENCE" | "MARK_FOR_FOLLOW_UP";

export interface Review {
  id: number;
  action: ReviewActionType;
  note: string;
  user: string;
  kb_version_seen: string;
  stale: boolean;
  created_at: string;
}

export interface EvidenceCard {
  chunk_id: number;
  document: string;
  doc_type: string;
  source: string;
  version: string;
  license: string;
  url: string;
  section: string;
  page: number | null;
  file_name?: string;
  text: string;
  score: number | null;
  support_span?: string;
  retrieval_mode?: string;
  matched_via?: Record<string, string>;
  label: string;
  /** Set only by the offline demo: the passage is sample text, not quoted from the document. */
  sample?: boolean;
}

export interface Finding {
  id: number;
  ordinal: number;
  drug_a: string;
  drug_b: string;
  drug_a_id: number;
  drug_b_id: number;
  severity: Severity;
  severity_label: string;
  source: string;
  source_record_id: string;
  interaction_id: number;
  kb_version: string;
  priority: Priority;
  rule_id: string;
  rule_description: string;
  evidence_status: "PENDING" | "FOUND" | "INSUFFICIENT";
  evidence_message?: string;
  review_status: string;
  degraded_retrieval?: boolean;
  evidence: EvidenceCard[];
  reviews: Review[];
}

export interface Item {
  id: number;
  line_no: number;
  raw_span: string;
  matched_text: string;
  drug_id: number | null;
  drug: string | null;
  product: string | null;
  is_synthetic: boolean;
  method: string;
  confidence: number | null;
  needs_confirmation: boolean;
  candidates: { drug_id: number; name: string; score: number }[];
  nlem_listed: boolean | null;
}

export interface Claim {
  claim_id: string;
  text: string;
  source_type: "DATABASE" | "RAG_CHUNK";
  kept: boolean;
  drop_reason: string;
  support_score: number | null;
  support_span: string;
  finding_ordinal: number | null;
  badge: string;
  generated_by?: string;
  database_record?: {
    interaction_id: number;
    drug_a: string;
    drug_b: string;
    severity: string;
    source: string;
    source_record_id: string;
    kb_version: string;
  };
  chunk?: EvidenceCard;
}

export interface Duplication {
  id: number;
  drug: string;
  item_labels: string[];
  reviews: Review[];
  rule_id: string;
}

export interface Escalation {
  id: number;
  reason_code: string;
  trigger_rule_id: string;
  detail: string;
  created_by: string;
}

export interface Banner {
  kind: string;
  text: string;
  patterns?: string[];
  terms?: string[];
}

export interface Explanation {
  id: number;
  mode: string;
  mode_badge: string;
  model: string;
  prompt_version: string;
  fallback_level: number;
  degraded_retrieval: boolean;
  correlation_id: string;
  claims: Claim[];
  dropped: { claim_id: string; reason: string; finding_ordinal: number | null }[];
}

export interface Prescription {
  id: number;
  session_id?: number;
  status: string;
  priority: Priority;
  age_band: string;
  note: string;
  raw_text: string | null;
  correlation_id: string;
  kb_version: string;
  current_kb_version: string;
  created_at: string;
  injection_flag: boolean;
  lines_ignored: number;
  items: Item[];
  findings: Finding[];
  duplications: Duplication[];
  rule_hits: { rule_id: string; priority: Priority; description: string; input: string; result: string }[];
  escalations: Escalation[];
  pairs_checked: number;
  absent_pairs_count: number;
  absent_pairs_wording: string;
  pairwise_notice: string;
  priority_notice: string;
  banners: Banner[];
  explanation: Explanation | null;
  reviews: Review[];
  llm_tokens_check: { input: number; output: number; calls: number };
  llm_usage?: { calls: number; input_tokens: number; output_tokens: number; fallback_level?: number };
  errors?: string[];
}

export interface QueueRow {
  id: number;
  status: string;
  priority: Priority;
  created_at: string;
  interaction_count: number;
  unresolved_count: number;
  escalation_count: number;
  reviewed_count: number;
  injection_flag: boolean;
  kb_version: string;
  first_line: string;
}

export interface AskResult {
  answer: string;
  mode: string;
  claims?: { claim_id: string; text: string; source_type: string; source_id: number }[];
  dropped?: { claim_id: string; reason: string }[];
  tool_trace?: { tool: string; args: Record<string, unknown>; status: string; result?: string }[];
  escalations?: { reason_code: string; rule_id: string }[];
  evidence_cards?: { chunk_id: number; document: string; section: string; text: string }[];
  correlation_id?: string;
}

export interface FindingDetail {
  finding: Finding;
  prescription_id: number;
  database_record: {
    interaction_id: number;
    drug_a: string;
    drug_a_ddinter_id: string;
    drug_b: string;
    drug_b_ddinter_id: string;
    severity: string;
    source: string;
    source_record_id: string;
    /** Dataset file holding this record, e.g. "ddinter_downloads_code_B.csv (DDInter 1.0 Dataset)". */
    source_file?: string;
    kb_version: string;
    table: string;
  };
  sources: { name: string; version: string; license: string; url: string; retrieved_at: string; checksum: string }[];
  explanation: null | { id: number; mode: string; model: string; prompt_version: string; correlation_id: string; fallback_level: number };
  claims_kept: Claim[];
  claims_dropped: { claim_id: string; reason: string }[];
  check_correlation_id: string;
}

export interface AuditEntry {
  seq: number;
  event_type: string;
  actor: string;
  entity: string;
  payload: Record<string, unknown>;
  kb_version: string;
  timestamp: string;
  correlation_id: string;
  prev_hash: string;
  hash: string;
}

export interface KbInfo {
  kb_version: string | null;
  loaded_at?: string;
  counts?: { drugs: number; aliases: number; interactions: number; documents: number };
  sources?: { name: string; version: string; license: string; url: string; retrieved_at: string; is_synthetic: boolean; notes: string }[];
}

export interface LatencyMetrics {
  endpoints: Record<string, { count: number; p50_ms: number | null; p95_ms: number | null; p99_ms: number | null; error_rate_5xx: number; rps: number | null }>;
  targets: Record<string, { p95_ms: number }>;
}

export type Lang = "en" | "ml" | "hi";

export interface TranslateResult {
  lang: Lang;
  translations: { text: string | null; status: "ok" | "rejected" | "unavailable"; reason?: string }[];
  model?: string;
}

export interface DrugHit {
  drug_id: number;
  name: string;
  score: number;
  nlem_listed: boolean | null;
}
