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
  evidence_cards: { chunk_id: number; document: string; section: string; text: string; page?: number | null; file_name?: string }[];
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
    api<{ messages: any[] }>(`/api/v1/sessions/${rx.session_id}`).then((s) =>
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

  const firstFinding = rx.findings[0];
  const drugA = firstFinding?.drug_a || rx.items[0]?.drug || "Warfarin";
  const drugB = firstFinding?.drug_b || rx.items[1]?.drug || "Aspirin";

  const dynamicChips = [
    firstFinding
      ? `Why was finding #${firstFinding.ordinal} (${firstFinding.drug_a} + ${firstFinding.drug_b}) flagged?`
      : "Why was the first finding flagged?",
    `Is ${drugA} in NLEM 2022, and at which level of care?`,
    `What clinical monitoring is advised for ${drugA} in ICMR STW guidelines?`,
    `Look up interaction between ${drugA} and ${drugB}`,
  ];

  return (
    <div className="card elevated">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <h2 style={{ margin: 0, fontSize: 14 }}>
          <span>🤖</span> Clinical AI Copilot (/api/v1/ask)
        </h2>
        <span className="badge ai" style={{ fontSize: 10 }}>
          Pydantic ToolPlan (max 3 read-only tools)
        </span>
      </div>
      <p className="small muted" style={{ marginTop: 0, marginBottom: 10 }}>
        The agent reasons strictly through read-only tools (<code>guideline_search</code>, <code>get_finding</code>, <code>interaction_lookup</code>). It answers only from verified chunks.
      </p>

      {/* Suggested Prompt Chips */}
      <div className="prompt-chips">
        {dynamicChips.map((chip, i) => (
          <button
            key={i}
            className="chip"
            onClick={() => ask(chip)}
            disabled={busy || !rx.session_id}
          >
            ✦ {chip}
          </button>
        ))}
      </div>

      <div className="chat">
        {msgs.length === 0 && (
          <div style={{ textAlign: "center", padding: "20px 0", color: "var(--muted)", fontSize: 12.5 }}>
            No questions asked yet in this session. Click a suggested prompt above or type below.
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div style={{ fontWeight: 600, fontSize: 11, marginBottom: 2, opacity: 0.8 }}>
              {m.role === "user" ? "Pharmacist" : "RxGuard Agent"}
            </div>
            <div>{m.content}</div>
            {m.payload && <AnswerMeta p={m.payload} />}
          </div>
        ))}
      </div>

      {err && <div className="error" style={{ marginBottom: 8 }}>{err}</div>}

      <div className="row">
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask a clinical guideline or interaction question..."
          onKeyDown={(e) => e.key === "Enter" && ask(q)}
          style={{ flex: 1 }}
          disabled={busy || !rx.session_id}
        />
        <button className="btn primary" onClick={() => ask(q)} disabled={busy || !rx.session_id || !q.trim()}>
          {busy ? <span className="spin" /> : "Ask Copilot"}
        </button>
      </div>
    </div>
  );
}

function AnswerMeta({ p }: { p: Partial<AskResult> }) {
  return (
    <div className="small" style={{ marginTop: 8, paddingTop: 6, borderTop: "1px solid var(--border)" }}>
      <div className="row" style={{ gap: 6, marginBottom: 4 }}>
        {p.mode === "llm" ? (
          <AiVerified />
        ) : p.mode === "template" ? (
          <Template />
        ) : (
          <span className="badge tpl">{p.mode?.toUpperCase()}</span>
        )}
        {p.escalations?.map((e, i) => (
          <Escalation key={i} code={e.reason_code} />
        ))}
      </div>

      {!!p.tool_trace?.length && (
        <div className="trace" style={{ marginTop: 6, padding: "6px 8px" }}>
          <div style={{ fontWeight: 700, fontSize: 10.5, color: "var(--accent)", marginBottom: 2 }}>
            ⚡ AGENT TOOL TRACE:
          </div>
          {p.tool_trace.map((t, i) => (
            <div key={i} style={{ fontSize: 11 }}>
              <code>{t.tool}</code>({JSON.stringify(t.args)}) → <span style={{ color: "var(--clear)" }}>{t.status}</span>
            </div>
          ))}
        </div>
      )}

      {!!p.claims?.length && (
        <div style={{ marginTop: 6 }}>
          {p.claims.map((c) => (
            <div key={c.claim_id} className="row" style={{ fontSize: 11, margin: "2px 0" }}>
              {c.source_type === "DATABASE" ? <DbFact /> : <AiVerified />}
              <span className="mono">
                {c.claim_id} → {c.source_type === "DATABASE" ? "interaction" : "guideline chunk"} #{c.source_id}
              </span>
            </div>
          ))}
        </div>
      )}

      {!!p.dropped?.length && (
        <div style={{ color: "var(--p1)", marginTop: 4, fontWeight: 600 }}>
          ⚠️ {p.dropped.length} unverified claim(s) dropped by claim verifier
        </div>
      )}

      {!!p.evidence_cards?.length && (
        <div style={{ marginTop: 10 }}>
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 800,
              color: "var(--accent)",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              marginBottom: 6,
            }}
          >
            📚 Verified Source Citations & Supporting Data ({p.evidence_cards.length}):
          </div>
          {p.evidence_cards.map((c) => (
            <div
              key={c.chunk_id}
              className="evidence"
              style={{
                marginBottom: 8,
                padding: "8px 12px",
                background: "var(--accent-soft)",
                borderLeft: "3px solid var(--accent)",
                borderRadius: "var(--radius)",
              }}
            >
              <div
                className="meta"
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 4,
                }}
              >
                <span>
                  📄 <b>Verified File / Source:</b> {c.document} {c.page ? `· Page ${c.page}` : ""}
                </span>
                <span className="badge synth" style={{ fontSize: 9 }}>Chunk #{c.chunk_id}</span>
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>
                <b>Section / Context:</b> {c.section}
              </div>
              <blockquote
                style={{
                  margin: 0,
                  padding: "6px 10px",
                  background: "var(--surface)",
                  borderRadius: "var(--radius)",
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: "var(--text)",
                }}
              >
                🔍 <b>Verified Quote:</b> "{c.text.slice(0, 360)}{c.text.length > 360 ? "…" : ""}"
              </blockquote>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
