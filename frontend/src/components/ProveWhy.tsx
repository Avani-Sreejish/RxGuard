import { useEffect, useState } from "react";
import { api } from "../api";
import { AiVerified, DbFact, Highlight, Insufficient, Prio, Sev, Template } from "./Badges";
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
        <div className="row spread" style={{ marginBottom: 12 }}>
          <h1>Prove this answer</h1>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
        {err && <div className="error">{err}</div>}
        {!d && !err && <span className="spin" />}
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
                <dd className="mono" style={{ color: "var(--accent)", fontWeight: 700 }}>
                  📄 {d.database_record.source_file || "ddinter_downloads_code_*.csv"}
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
                    <div className="small muted" style={{ marginTop: 6, fontStyle: "italic", background: "var(--surface)", padding: "6px 10px", borderRadius: 4 }}>
                      💡 <b>Note:</b> Click the <b>"Explain"</b> button at the top right of the prescription view to run clinical guideline retrieval. Retrieved excerpts from guideline PDFs (e.g., <code>icmr_stw_cardiology_all.pdf</code>, <code>nlem2022.pdf</code>) with exact page numbers and highlighted cited text will appear here.
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
            <li>
              <h4>Verifier result</h4>
              <div className="small">
                {d.claims_kept.length} kept · {d.claims_dropped.length} dropped. Checks: exists → whitelisted → DB exactness
                → support ≥ threshold → scope (no dose / stop / switch / "safe").
              </div>
            </li>
            <li>
              <h4>Correlation IDs and trace</h4>
              <dl className="kv">
                <dt>check</dt>
                <dd className="mono">{d.check_correlation_id}</dd>
                <dt>explain</dt>
                <dd className="mono">{d.explanation?.correlation_id ?? "—"}</dd>
                <dt>explanation</dt>
                <dd>
                  {d.explanation ? `${d.explanation.mode} · ${d.explanation.model || "no model"} · ${d.explanation.prompt_version || "—"}` : "—"}
                </dd>
              </dl>
              <div className="trace" style={{ marginTop: 6 }}>
                {d.trace.tool_calls.map((t, i) => (
                  <div key={i}>
                    tool {t.tool} [{t.status}] {Math.round(t.latency_ms)} ms — {t.result_summary}
                  </div>
                ))}
                {d.trace.llm_calls.map((l, i) => (
                  <div key={`l${i}`}>
                    llm {l.node} {l.model} [{l.status}] in={l.input_tokens} out={l.output_tokens} fallback={l.fallback_level}
                  </div>
                ))}
                {d.trace.llm_calls.length === 0 && <div>0 LLM calls</div>}
              </div>
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
    <div
      className="evidence"
      style={{
        borderLeft: "3px solid var(--accent)",
        background: "var(--accent-soft)",
        borderRadius: "var(--radius)",
        padding: "10px 14px",
        marginTop: 8,
      }}
    >
      <div
        className="meta"
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 6,
          marginBottom: 6,
        }}
      >
        <div>
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 800,
              color: "var(--accent)",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              marginRight: 6,
            }}
          >
            📄 Verified Source File:
          </span>
          <b style={{ color: "var(--text)", fontSize: 13 }}>{e.file_name || e.document}</b>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {e.doc_type && <span className="badge synth" style={{ fontSize: 9.5 }}>{e.doc_type}</span>}
          {e.page != null && <span className="badge esc" style={{ fontSize: 9.5 }}>Page {e.page}</span>}
          <span className="mono small" style={{ color: "var(--muted)" }}>Chunk #{e.chunk_id}</span>
        </div>
      </div>

      <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 6 }}>
        <b>Section / Policy Context:</b> {e.section}
        {e.score != null ? ` · Retrieval score: ${e.score.toFixed(3)}` : ""}
        {e.retrieval_mode === "fulltext" ? " · FULLTEXT (degraded)" : ""}
        {e.matched_via && Object.keys(e.matched_via).length > 0 && (
          <span style={{ marginLeft: 8 }}>
            (matched: {Object.entries(e.matched_via).map(([d, v]) => `${d} via “${v}”`).join(" · ")})
          </span>
        )}
      </div>

      {verifiedSpan ? (
        <div
          style={{
            margin: "6px 0",
            padding: "8px 10px",
            background: "rgba(59, 130, 246, 0.12)",
            borderRadius: "var(--radius)",
            border: "1px solid rgba(59, 130, 246, 0.35)",
          }}
        >
          <div style={{ fontSize: 10.5, fontWeight: 800, color: "var(--accent)", marginBottom: 3 }}>
            🔍 EXACT DATA USED TO VERIFY (CITED TEXT):
          </div>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", lineHeight: 1.5 }}>
            "{verifiedSpan}"
          </div>
        </div>
      ) : null}

      <details style={{ marginTop: 6, fontSize: 12, cursor: "pointer" }}>
        <summary style={{ color: "var(--muted)", fontWeight: 600, fontSize: 11 }}>
          View full source passage ({e.text.length} chars)
        </summary>
        <blockquote
          style={{
            marginTop: 6,
            padding: "8px 10px",
            background: "var(--surface)",
            borderRadius: "var(--radius)",
            maxHeight: 180,
            overflow: "auto",
            fontSize: 12,
            lineHeight: 1.55,
          }}
        >
          <Highlight text={e.text} span={verifiedSpan} />
        </blockquote>
      </details>
    </div>
  );
}
