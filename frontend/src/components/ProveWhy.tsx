import { useEffect, useState } from "react";
import { api } from "../api";
import { AiVerified, DbFact, Highlight, Insufficient, Prio, Sev, Spinner, Template } from "./Badges";
import Icon from "./Icon";
import type { Claim, EvidenceCard, Finding } from "../types";

interface ProveData {
  finding: Finding;
  prescription_id: number;
  database_record: { interaction_id: number; drug_a: string; drug_a_ddinter_id: string; drug_b: string;
    drug_b_ddinter_id: string; severity: string; source: string; source_record_id: string; source_file?: string; kb_version: string;
    table: string };
  sources: { name: string; version: string; license: string; url: string; retrieved_at: string; checksum: string }[];
  explanation: null | { id: number; mode: string; model: string; prompt_version: string; correlation_id: string;
    fallback_level: number };
  claims_kept: Claim[];
  claims_dropped: { claim_id: string; reason: string }[];
  check_correlation_id: string;
  trace: {
    tool_calls: { tool: string; args_summary: string; result_summary: string; latency_ms: number; status: string;
      correlation_id: string }[];
    llm_calls: { node: string; model: string; prompt_version: string; input_tokens: number; output_tokens: number;
      status: string; fallback_level: number; latency_ms: number }[];
  };
}

export default function ProveWhy({ findingId, onClose }: { findingId: number; onClose: () => void }) {
  const [d, setD] = useState<ProveData | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api<ProveData>(`/api/v1/findings/${findingId}`).then(setD).catch((e) => setErr(e.message));
  }, [findingId]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h1>Prove this answer</h1>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        {err && <div className="error">{err}</div>}
        {!d && !err && <div className="page-loading"><Spinner /> Loading the evidence chain…</div>}
        {d && (
          <ol className="chain">
            <li>
              <h4>Finding shown to the pharmacist</h4>
              <div className="row">
                <b>
                  {d.finding.drug_a} ↔ {d.finding.drug_b}
                </b>
                <Sev s={d.finding.severity} />
                <Prio p={d.finding.priority} rule={d.finding.rule_id} />
              </div>
              <div className="small muted">
                {d.finding.rule_id}: {d.finding.rule_description} · finding #{d.finding.ordinal}
              </div>
            </li>
            <li>
              <h4>Claims and their citation IDs</h4>
              {d.explanation?.mode === "template" && <Template />}
              {d.claims_kept.length === 0 && <div className="small muted">No explanation generated yet (run Explain).</div>}
              {d.claims_kept.map((c) => (
                <ClaimRow key={c.claim_id} c={c} />
              ))}
              {d.claims_dropped.length > 0 && (
                <div className="small" style={{ marginTop: 6, color: "var(--p2)" }}>
                  {d.claims_dropped.length} claim(s) removed by the verifier (never displayed):{" "}
                  {d.claims_dropped.map((x) => `${x.claim_id} — ${x.reason}`).join("; ")}
                </div>
              )}
            </li>
            <li>
              <h4>
                Database record <DbFact />
              </h4>
              <dl className="kv">
                <dt>table</dt>
                <dd className="mono">{d.database_record.table} · id {d.database_record.interaction_id}</dd>
                <dt>pair</dt>
                <dd>
                  {d.database_record.drug_a} <span className="mono small">({d.database_record.drug_a_ddinter_id})</span> ↔{" "}
                  {d.database_record.drug_b} <span className="mono small">({d.database_record.drug_b_ddinter_id})</span>
                </dd>
                <dt>severity</dt>
                <dd>
                  <Sev s={d.database_record.severity} /> (as recorded)
                </dd>
                <dt>source record</dt>
                <dd className="mono">
                  {d.database_record.source} {d.database_record.source_record_id}
                </dd>
                <dt>source file</dt>
                <dd className="mono" style={{ color: "var(--brand-strong)", fontWeight: 600 }}>
                  {d.database_record.source_file || "ddinter_downloads_code_*.csv"}
                </dd>
                <dt>KB version</dt>
                <dd className="mono">{d.database_record.kb_version}</dd>
              </dl>
            </li>
            <li>
              <h4>Guideline chunks (retrieved, not AI-generated)</h4>
              {d.finding.evidence.length === 0 ? (
                <div>
                  <Insufficient /> <span className="small">{d.finding.evidence_message || "No guideline chunks retrieved."}</span>
                  {!d.explanation && (
                    <div className="note">
                      <b>Note:</b> Click the <b>"Explain"</b> button at the top right of the prescription view to run clinical guideline retrieval. Retrieved excerpts from guideline PDFs (e.g., <code>icmr_stw_cardiology_all.pdf</code>, <code>nlem2022.pdf</code>) with exact page numbers and highlighted cited text will appear here.
                    </div>
                  )}
                </div>
              ) : (
                d.finding.evidence.map((e) => (
                  <ChunkCard key={e.chunk_id} e={e}
                    span={d.claims_kept.find((c) => c.chunk?.chunk_id === e.chunk_id)?.support_span} />
                ))
              )}
            </li>
            <li>
              <h4>Source documents, versions and licences</h4>
              {d.sources.map((s) => (
                <div key={s.name} className="small" style={{ marginBottom: 6 }}>
                  <b>{s.name}</b> · {s.version} · sha256 <span className="mono">{s.checksum.slice(0, 12)}…</span>
                  {s.name.includes("DDInter") && (
                    <div className="mono" style={{ fontSize: 11, color: "var(--accent)", marginTop: 2 }}>
                      Included Files: ddinter_downloads_code_A.csv … ddinter_downloads_code_V.csv (160k pairs)
                    </div>
                  )}
                  <div className="muted">{s.license}</div>
                </div>
              ))}
              {[...new Map(d.finding.evidence.map((e) => [e.document, e])).values()].map((e) => (
                <div key={e.document} className="small" style={{ marginTop: 4 }}>
                  <b>{e.document}</b> {e.file_name && <span className="mono">({e.file_name})</span>} · {e.source} · {e.version}
                  <div className="muted">{e.license}</div>
                </div>
              ))}
            </li>
          </ol>
        )}
      </div>
    </div>
  );
}

function ClaimRow({ c }: { c: Claim }) {
  return (
    <div className="claim">
      <span className="mono small">{c.claim_id}</span>
      <span className="txt">{c.text}</span>
      {c.source_type === "DATABASE" ? <DbFact /> : <AiVerified />}
      <span className="mono small">
        → {c.source_type === "DATABASE" ? `interaction ${c.database_record?.interaction_id}` : `chunk ${c.chunk?.chunk_id}`}
        {c.support_score != null ? ` · support ${c.support_score}` : ""}
      </span>
    </div>
  );
}

export function ChunkCard({ e, span }: { e: EvidenceCard; span?: string }) {
  const verifiedSpan = span || e.support_span;
  return (
    <div className="evidence">
      <div className="meta">
        <span className="row" style={{ gap: 6 }}>
          <Icon name="file" size={15} />
          <b style={{ color: "var(--ink)" }}>{e.file_name || e.document}</b>
        </span>
        <span className="row" style={{ gap: 6 }}>
          {e.doc_type && <span className="tag tag-brand">{e.doc_type}</span>}
          {e.page != null && <span className="tag tag-plain">page {e.page}</span>}
          <span className="code">chunk #{e.chunk_id}</span>
        </span>
      </div>
      <div className="meta">
        <span>
          {e.section}
          {e.score != null ? ` · retrieval score ${e.score.toFixed(3)}` : ""}
          {e.retrieval_mode === "fulltext" ? " · FULLTEXT (degraded)" : ""}
          {e.matched_via && Object.keys(e.matched_via).length > 0 && (
            <> · matched: {Object.entries(e.matched_via).map(([d, v]) => `${d} via “${v}”`).join(" · ")}</>
          )}
        </span>
      </div>
      {verifiedSpan ? (
        <div className="span-box">
          <span className="lbl">Cited text used to verify</span>“{verifiedSpan}”
        </div>
      ) : null}
      <details>
        <summary>Full source passage ({e.text.length} chars)</summary>
        <blockquote style={{ marginTop: 6 }}>
          <Highlight text={e.text} span={verifiedSpan} />
        </blockquote>
      </details>
    </div>
  );
}
