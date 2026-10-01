import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { AiVerified, DbFact, Escalation, Template } from "./Badges";
import type { Prescription } from "../types";

interface AskResult {
  answer: string;
  mode: string;
  claims: { claim_id: string; text: string; source_type: string; source_id: number }[];
  dropped: { claim_id: string; reason: string }[];
  tool_trace: { tool: string; args: Record<string, unknown>; status: string; result?: string }[];
  escalations: { reason_code: string; rule_id: string }[];
  evidence_cards: { chunk_id: number; document: string; section: string; text: string }[];
  correlation_id: string;
}

interface Msg {
  role: "user" | "assistant";
  content: string;
  payload?: Partial<AskResult>;
}

export default function AskPanel({ rx }: { rx: Prescription }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!rx.session_id) return;
    api(`/api/v1/sessions/${rx.session_id}`).then((s) =>
      setMsgs(s.messages.filter((m: any) => m.role !== "system" && m.prescription_id === rx.id)),
    );
  }, [rx.session_id, rx.id]);

  const ask = async (question: string) => {
    if (!rx.session_id || !question.trim()) return;
    setBusy(true);
    setErr("");
    setMsgs((m) => [...m, { role: "user", content: question }]);
    setQ("");
    try {
      const r = await api<AskResult>("/api/v1/ask", { body: { session_id: rx.session_id, question } });
      setMsgs((m) => [...m, { role: "assistant", content: r.answer, payload: r }]);
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Follow-up questions</h2>
      <p className="small muted" style={{ marginTop: 0 }}>
        The agent plans up to 3 read-only tool calls and answers only from their output. It cannot approve, dose or prescribe.
      </p>
      <div className="chat">
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div>{m.content}</div>
            {m.payload && <AnswerMeta p={m.payload} />}
          </div>
        ))}
      </div>
      {err && <div className="error">{err}</div>}
      <div className="row">
        <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Why was the second one flagged?"
          onKeyDown={(e) => e.key === "Enter" && ask(q)} style={{ flex: 1 }} />
        <button className="btn primary" onClick={() => ask(q)} disabled={busy || !rx.session_id}>
          {busy ? <span className="spin" /> : "Ask"}
        </button>
      </div>
      <div className="row small" style={{ marginTop: 6 }}>
        {["Why was the second one flagged?", "Is warfarin in NLEM 2022, and at which level of care?"].map((s) => (
          <button key={s} className="btn sm" onClick={() => ask(s)} disabled={busy}>{s}</button>
        ))}
      </div>
    </div>
  );
}

function AnswerMeta({ p }: { p: Partial<AskResult> }) {
  return (
    <div className="small" style={{ marginTop: 6 }}>
      <div className="row">
        {p.mode === "llm" ? <AiVerified /> : p.mode === "template" ? <Template /> : <span className="badge tpl">{p.mode?.toUpperCase()}</span>}
        {p.escalations?.map((e, i) => <Escalation key={i} code={e.reason_code} />)}
      </div>
      {!!p.claims?.length && (
        <div style={{ marginTop: 4 }}>
          {p.claims.map((c) => (
            <div key={c.claim_id} className="row">
              {c.source_type === "DATABASE" ? <DbFact /> : <AiVerified />}
              <span className="mono">{c.claim_id} → {c.source_type === "DATABASE" ? "interaction" : "chunk"} {c.source_id}</span>
            </div>
          ))}
        </div>
      )}
      {!!p.dropped?.length && <div style={{ color: "var(--p2)" }}>{p.dropped.length} claim(s) removed by the verifier</div>}
      {!!p.evidence_cards?.length && p.mode !== "llm" && (
        <div style={{ marginTop: 4 }}>
          {p.evidence_cards.slice(0, 2).map((c) => (
            <div key={c.chunk_id} className="evidence">
              <div className="meta"><b>{c.document}</b> · {c.section} · chunk {c.chunk_id} · source text, not AI-generated</div>
              <blockquote>{c.text.slice(0, 400)}</blockquote>
            </div>
          ))}
        </div>
      )}
      {!!p.tool_trace?.length && (
        <div className="trace" style={{ marginTop: 4 }}>
          {p.tool_trace.map((t, i) => (
            <div key={i}>{t.tool}({JSON.stringify(t.args)}) [{t.status}] {t.result ?? ""}</div>
          ))}
        </div>
      )}
    </div>
  );
}
