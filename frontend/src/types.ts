export type Priority = "P1" | "P2" | "P3" | "CLEAR";

export interface Review {
  id: number;
  action: string;
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
}

export interface Finding {
  id: number;
  ordinal: number;
  drug_a: string;
  drug_b: string;
  drug_a_id: number;
  drug_b_id: number;
  severity: string;
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
  database_record?: { interaction_id: number; drug_a: string; drug_b: string; severity: string; source: string;
    source_record_id: string; kb_version: string };
  chunk?: EvidenceCard;
}

export interface Prescription {
  id: number;
  status: string;
  priority: Priority;
  age_band: string;
  note: string;
  raw_text: string;
  correlation_id: string;
  kb_version: string;
  current_kb_version: string;
  created_at: string;
  injection_flag: boolean;
  lines_ignored: number;
  items: Item[];
  findings: Finding[];
  duplications: { id: number; drug: string; item_labels: string[]; reviews: Review[]; rule_id: string }[];
  rule_hits: { rule_id: string; priority: Priority; description: string; input: string; result: string }[];
  escalations: { id: number; reason_code: string; trigger_rule_id: string; detail: string; created_by: string }[];
  pairs_checked: number;
  absent_pairs_count: number;
  absent_pairs_wording: string;
  pairwise_notice: string;
  priority_notice: string;
  banners: { kind: string; text: string; patterns?: string[]; terms?: string[] }[];
  explanation: null | {
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
  };
  reviews: Review[];
  llm_tokens_check: { input: number; output: number; calls: number };
  session_id?: number;
  llm_usage?: { calls: number; input_tokens: number; output_tokens: number; fallback_level?: number };
  tool_trace?: { tool: string; args_summary: string; result_summary: string; latency_ms: number; status: string }[];
}
