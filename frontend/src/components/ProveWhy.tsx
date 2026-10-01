import { useEffect, useState } from "react";
import { api } from "../api";
import { AiVerified, DbFact, Highlight, Insufficient, Prio, Sev, Template } from "./Badges";
import type { Claim, EvidenceCard, Finding } from "../types";

interface ProveData {
  finding: Finding;
  prescription_id: number;
  database_record: { interaction_id: number; drug_a: string; drug_a_ddinter_id: string; drug_b: string;
    drug_b_ddinter_id: string; severity: string; source: string; source_record_id: string; kb_version: string;
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
                <dt>KB version</dt>
                <dd className="mono">{d.database_record.kb_version}</dd>
              </dl>
            </li>
            <li>
              <h4>Guideline chunks (retrieved, not AI-generated)</h4>
              {d.finding.evidence.length === 0 ? (
                <div>
                  <Insufficient /> <span className="small">{d.finding.evidence_message}</span>
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
                <div key={s.name} className="small">
                  <b>{s.name}</b> · {s.version} · sha256 <span className="mono">{s.checksum.slice(0, 12)}…</span>
                  <div className="muted">{s.license}</div>
                </div>
              ))}
              {[...new Map(d.finding.evidence.map((e) => [e.document, e])).values()].map((e) => (
                <div key={e.document} className="small" style={{ marginTop: 4 }}>
                  <b>{e.document}</b> · {e.source} · {e.version}
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
  return (
    <div className="evidence">
      <div className="meta">
        <b>{e.document}</b> · {e.section} {e.page ? `· p.${e.page}` : ""} · chunk {e.chunk_id}
        {e.score != null ? ` · retrieval score ${e.score.toFixed(3)}` : ""}
        {e.retrieval_mode === "fulltext" ? " · FULLTEXT (degraded)" : ""}
        {e.matched_via && Object.keys(e.matched_via).length > 0 && (
          <div>
            matched: {Object.entries(e.matched_via).map(([d, v]) => `${d} (${v.replace("class:", "via class term “") + (v.startsWith("class:") ? "”" : "")})`).join(" · ")}
          </div>
        )}
      </div>
      <blockquote>
        <Highlight text={e.text} span={span || e.support_span} />
      </blockquote>
    </div>
  );
}
