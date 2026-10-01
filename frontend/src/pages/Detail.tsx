import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { AiVerified, DbFact, Degraded, Escalation, Insufficient, Prio, Sev, Synthetic, Template, Unresolved } from "../components/Badges";
import InteractionMap from "../components/InteractionMap";
import ProveWhy, { ChunkCard } from "../components/ProveWhy";
import AskPanel from "../components/AskPanel";
import AuditTrail from "../components/AuditTrail";
import type { Finding, Item, Prescription } from "../types";

const ACTIONS = ["ACKNOWLEDGE", "ESCALATE", "REQUEST_MORE_EVIDENCE", "MARK_FOR_FOLLOW_UP"] as const;

export default function Detail({ id }: { id: number }) {
  const [rx, setRx] = useState<Prescription | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [sel, setSel] = useState<number | null>(null);
  const [prove, setProve] = useState<number | null>(null);
  const [auditKey, setAuditKey] = useState(0);
  const [gate, setGate] = useState<string[]>([]);

  const load = useCallback(() => {
    api<Prescription>(`/api/v1/prescriptions/${id}`).then(setRx).catch((e) => setErr(e.message));
  }, [id]);
  useEffect(load, [load]);

  const run = async (label: string, fn: () => Promise<Prescription | void>) => {
    setBusy(label);
    setErr("");
    try {
      const r = await fn();
      if (r) setRx({ ...r, llm_usage: r.llm_usage ?? rx?.llm_usage, tool_trace: r.tool_trace ?? rx?.tool_trace });
      setAuditKey((k) => k + 1);
    } catch (e) {
      const ae = e as ApiError;
      setErr(`${ae.status ?? ""} ${ae.message}`);
      if (ae.code === "review_gate_not_met") setGate(((ae.details as any)?.reasons as string[]) ?? []);
    } finally {
      setBusy("");
    }
  };

  if (!rx) return err ? <div className="error">{err}</div> : <span className="spin" />;
  const explanation = rx.explanation;
  const claimsFor = (f: Finding) => explanation?.claims.filter((c) => c.finding_ordinal === f.ordinal) ?? [];
  const droppedCount = explanation?.dropped.length ?? 0;

  return (
    <>
      <div className="row spread" style={{ marginBottom: 12 }}>
        <div>
          <h1>
            Prescription #{rx.id} <Prio p={rx.priority} />
          </h1>
          <div className="sub">
            {rx.status.replace(/_/g, " ").toLowerCase()} · checked against KB <b>{rx.kb_version}</b>
            {rx.current_kb_version !== rx.kb_version && <> · current KB <b>{rx.current_kb_version}</b></>} · age band{" "}
            {rx.age_band} · <span className="mono">{rx.correlation_id}</span>
          </div>
        </div>
        <div className="row">
          <span className="zero-token" title="LLM tokens used by the deterministic check">
            /check: {rx.llm_tokens_check.input + rx.llm_tokens_check.output} LLM tokens
          </span>
          <button className="btn primary" disabled={!!busy || rx.findings.length === 0}
            onClick={() => run("explain", () => api(`/api/v1/explain`, { body: { prescription_id: rx.id } }))}>
            {busy === "explain" ? <span className="spin" /> : explanation ? "Re-explain" : "Explain"}
          </button>
          <button className="btn" disabled={!!busy}
            onClick={() => run("complete", async () => { setGate([]); return api(`/api/v1/prescriptions/${rx.id}/complete`, { method: "POST" }); })}>
            Complete review
          </button>
        </div>
      </div>

      {rx.banners.map((b, i) => (
        <div key={i} className={`banner ${b.kind}`}>
          <Escalation code={b.kind} />
          <span>
            {b.text}
            {b.patterns && <span className="mono small"> matched: {b.patterns.join(", ")}</span>}
            {b.terms && <span className="mono small"> terms: {b.terms.join(", ")}</span>}
          </span>
        </div>
      ))}
      {err && <div className="error" style={{ marginBottom: 8 }}>{err}</div>}
      {gate.length > 0 && (
        <div className="banner UNRESOLVED">
          <span>
            <b>Review cannot be completed yet:</b>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{gate.map((g) => <li key={g}>{g}</li>)}</ul>
          </span>
        </div>
      )}

      <div className="grid2">
        <div>
          <Resolution rx={rx} onConfirm={(item, drugId) =>
            run("confirm", () => api(`/api/v1/prescriptions/${rx.id}/items/${item.id}/confirm`,
              { body: drugId ? { drug_id: drugId } : { not_in_database: true } }))} />

          <div className="card">
            <h2><span className="step">3</span>Findings</h2>
            {rx.findings.length === 0 && (
              <p className="muted">
                {rx.absent_pairs_wording} for any of the {rx.pairs_checked} pair(s) checked. This is not a statement that
                the combination is safe.
              </p>
            )}
            {rx.findings.length > 0 && rx.absent_pairs_count > 0 && (
              <p className="small muted">
                {rx.absent_pairs_count} of {rx.pairs_checked} pairs: {rx.absent_pairs_wording}.
              </p>
            )}
            {explanation && (
              <div className="row small" style={{ marginBottom: 8 }}>
                {explanation.mode === "template" ? <Template /> : <AiVerified />}
                {explanation.degraded_retrieval && <Degraded />}
                {droppedCount > 0 && (
                  <span style={{ color: "var(--p2)" }}>
                    {droppedCount} claim(s) removed by the verifier: {explanation.dropped.map((d) => `${d.claim_id} (${d.reason})`).join("; ")}
                  </span>
                )}
                {rx.llm_usage && <span className="muted">explain LLM calls {rx.llm_usage.calls} · tokens in {rx.llm_usage.input_tokens} / out {rx.llm_usage.output_tokens}</span>}
              </div>
            )}
            {rx.findings.map((f) => (
              <div key={f.id} className={`finding ${sel === f.id ? "sel" : ""}`} onClick={() => setSel(f.id)}>
                <div className="row spread">
                  <span className="pair">
                    #{f.ordinal} {f.drug_a} ↔ {f.drug_b}
                  </span>
                  <span className="row">
                    <Prio p={f.priority} rule={f.rule_id} title={`${f.rule_id}: ${f.rule_description}`} />
                    <button className="btn sm" onClick={(e) => { e.stopPropagation(); setProve(f.id); }}>
                      Prove why
                    </button>
                  </span>
                </div>
                <div className="claim">
                  <DbFact />
                  <span className="txt">
                    Interaction recorded in the structured database: <Sev s={f.severity} /> (as recorded) ·{" "}
                    <span className="mono small">
                      {f.source} {f.kb_version} · record {f.source_record_id}
                    </span>
                  </span>
                </div>
                {claimsFor(f).filter((c) => c.source_type === "RAG_CHUNK").map((c) => (
                  <div className="claim" key={c.claim_id}>
                    <AiVerified />
                    <span className="txt">{c.text}</span>
                    <span className="mono small">{c.claim_id} → chunk {c.chunk?.chunk_id}</span>
                  </div>
                ))}
                {f.evidence_status === "INSUFFICIENT" && (
                  <div className="claim">
                    <Insufficient />
                    <span className="txt">{f.evidence_message}</span>
                  </div>
                )}
                {f.evidence.slice(0, sel === f.id ? 3 : 1).map((e) => (
                  <ChunkCard key={e.chunk_id} e={e}
                    span={claimsFor(f).find((c) => c.chunk?.chunk_id === e.chunk_id)?.support_span} />
                ))}
                <ReviewBar f={f} busy={!!busy} onAct={(action, note) =>
                  run("review", () => api(`/api/v1/reviews/${f.id}`, { body: { action, note } }))} />
              </div>
            ))}
            {rx.duplications.map((d) => (
              <div key={d.id} className="finding">
                <div className="row spread">
                  <span className="pair">Duplicate ingredient: {d.drug}</span>
                  <Prio p="P2" rule="R8" />
                </div>
                <div className="small">{d.item_labels.join(" · ")}</div>
                <ReviewBar f={{ reviews: d.reviews } as any} busy={!!busy} onAct={(action, note) =>
                  run("review", () => api(`/api/v1/reviews/${d.id}`, { body: { action, note, target: "duplication" } }))} />
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="card">
            <h2><span className="step">2</span>Interaction map</h2>
            <InteractionMap rx={rx} selected={sel} onSelect={setSel} />
          </div>
          <div className="card">
            <h2>Why this priority</h2>
            <p className="small muted" style={{ marginTop: 0 }}>{rx.priority_notice}</p>
            <table>
              <tbody>
                {rx.rule_hits.map((h, i) => (
                  <tr key={i}>
                    <td><Prio p={h.priority} rule={h.rule_id} /></td>
                    <td className="small">
                      <b>{h.description}</b>
                      <div className="muted">input: {h.input}</div>
                      <div>result: {h.result}</div>
                    </td>
                  </tr>
                ))}
                {rx.rule_hits.length === 0 && <tr><td className="muted small">No rule fired: CLEAR.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="card">
            <h2>Escalations</h2>
            {rx.escalations.length === 0 && <span className="muted small">None</span>}
            {rx.escalations.map((e) => (
              <div key={e.id} className="row small" style={{ padding: "4px 0" }}>
                <Escalation code={e.reason_code} />
                <span className="mono">{e.trigger_rule_id}</span>
                <span>{e.detail}</span>
              </div>
            ))}
          </div>
          <AskPanel rx={rx} />
          <AuditTrail id={rx.id} refreshKey={auditKey} />
          <StepsCard id={rx.id} refreshKey={auditKey} />
        </div>
      </div>
      {prove && <ProveWhy findingId={prove} onClose={() => setProve(null)} />}
    </>
  );
}

function Resolution({ rx, onConfirm }: { rx: Prescription; onConfirm: (i: Item, drugId: number | null) => void }) {
  return (
    <div className="card">
      <h2><span className="step">1</span>Resolution</h2>
      <table>
        <thead>
          <tr><th>Line</th><th>As written</th><th>Resolved molecule</th><th>Method</th></tr>
        </thead>
        <tbody>
          {rx.items.map((i) => (
            <tr key={i.id}>
              <td className="mono">{i.line_no}</td>
              <td className="small">{i.raw_span}</td>
              <td>
                {i.drug ? (
                  <>
                    <b>{i.drug}</b>
                    {i.product && <div className="small">via {i.product} {i.is_synthetic && <Synthetic />}</div>}
                    {i.nlem_listed && <div className="small muted">NLEM 2022 listed</div>}
                  </>
                ) : i.method === "pharmacist" ? (
                  <span className="muted small">{i.matched_text}</span>
                ) : (
                  <ConfirmItem item={i} onConfirm={onConfirm} />
                )}
              </td>
              <td className="small">
                {i.method}
                {i.confidence != null && i.method !== "exact" ? ` · ${i.confidence}` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted" style={{ marginBottom: 0 }}>{rx.lines_ignored} non-medication line(s) ignored.</p>
    </div>
  );
}

function ConfirmItem({ item, onConfirm }: { item: Item; onConfirm: (i: Item, drugId: number | null) => void }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<{ drug_id: number; name: string; score: number }[]>(item.candidates ?? []);
  useEffect(() => {
    if (q.length < 2) return;
    const t = setTimeout(() => api(`/api/v1/drugs/search?q=${encodeURIComponent(q)}`).then((r) => setRes(r.results)), 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div>
      <Unresolved /> <span className="small">Pharmacist confirmation required</span>
      <div className="row" style={{ marginTop: 4 }}>
        <input type="text" placeholder="Search molecule…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 170 }} />
        <button className="btn sm" onClick={() => onConfirm(item, null)}>Not in database</button>
      </div>
      {res.slice(0, 5).map((c) => (
        <div key={c.drug_id} className="row small" style={{ marginTop: 3 }}>
          <button className="btn sm" onClick={() => onConfirm(item, c.drug_id)}>Confirm</button>
          {c.name} <span className="muted">({c.score})</span>
        </div>
      ))}
    </div>
  );
}

function ReviewBar({ f, busy, onAct }: { f: Pick<Finding, "reviews">; busy: boolean; onAct: (a: string, note: string) => void }) {
  const [note, setNote] = useState("");
  return (
    <div style={{ marginTop: 8, borderTop: "1px dashed var(--border)", paddingTop: 8 }} onClick={(e) => e.stopPropagation()}>
      {f.reviews.map((r) => (
        <div key={r.id} className="small">
          <b>{r.action.replace(/_/g, " ").toLowerCase()}</b> by {r.user} · reviewed against KB {r.kb_version_seen}
          {r.stale && <span style={{ color: "var(--p2)" }}> (current KB differs)</span>}
          {r.note && <> · “{r.note}”</>}
        </div>
      ))}
      <div className="row" style={{ marginTop: 4 }}>
        <input type="text" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
        {ACTIONS.map((a) => (
          <button key={a} className={`btn sm ${a === "ESCALATE" ? "danger" : ""}`} disabled={busy}
            onClick={() => { onAct(a, note); setNote(""); }}>
            {a.replace(/_/g, " ").toLowerCase()}
          </button>
        ))}
      </div>
    </div>
  );
}

function StepsCard({ id, refreshKey }: { id: number; refreshKey: number }) {
  const [steps, setSteps] = useState<{ id: number; graph: string; node: string; status: string; latency_ms: number; summary: string }[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open) api(`/api/v1/prescriptions/${id}/steps`).then((r) => setSteps(r.steps));
  }, [id, open, refreshKey]);
  return (
    <div className="card">
      <h2>
        Agent steps (LangGraph state per node){" "}
        <button className="btn sm" onClick={() => setOpen(!open)}>{open ? "hide" : "show"}</button>
      </h2>
      {open && (
        <div className="trace">
          {steps.map((s) => (
            <div key={s.id}>
              [{s.graph}] {s.node} · {s.status} · {s.latency_ms} ms — {s.summary}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
