import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { Spinner } from "./Badges";
import Icon from "./Icon";
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
    <div className="ask">
      <p className="meta">
        Ask about this prescription. Answers come only from its findings and the guideline documents, and never
        include doses or dispensing decisions.
      </p>

      <div className="prompt-chips">
        {dynamicChips.map((chip, i) => (
          <button key={i} className="chip" onClick={() => ask(chip)} disabled={busy || !rx.session_id}>
            {chip}
          </button>
        ))}
      </div>

      <div className="chat" aria-live="polite">
        {msgs.length === 0 && <p className="panel-empty-line">No questions asked yet. Pick a suggestion or type below.</p>}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="who-line">{m.role === "user" ? "You" : "RxGuard"}</div>
            <div>{m.content}</div>
            {m.payload && <AnswerMeta p={m.payload} />}
          </div>
        ))}
        {busy && <div className="ev-loading"><Spinner /> Working…</div>}
      </div>

      {err && <div className="error">{err}</div>}

      <form className="ask-form" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask about this prescription"
          aria-label="Ask about this prescription"
          disabled={busy || !rx.session_id}
        />
        <button className="btn primary" disabled={busy || !rx.session_id || !q.trim()}>
          {busy ? <Spinner /> : "Ask"}
        </button>
      </form>
    </div>
  );
}

function AnswerMeta({ p }: { p: Partial<AskResult> }) {
  const MODE: Record<string, string> = {
    llm: "AI answer, checked against the sources",
    template: "AI unavailable: database facts only",
    refusal: "Declined: outside what RxGuard may answer",
    insufficient: "Not enough evidence to answer",
  };
  return (
    <div className="answer-meta">
      {p.mode && <span className="meta">{MODE[p.mode] ?? p.mode}</span>}
      {!!p.escalations?.length && (
        <span className="warn-text small"><Icon name="flag" size={14} /> Flagged for pharmacist review: {p.escalations.map((e) => e.reason_code.replace(/_/g, " ").toLowerCase()).join(", ")}</span>
      )}
      {!!p.dropped?.length && (
        <span className="meta">{p.dropped.length} statement(s) removed because they could not be verified.</span>
      )}
      {!!p.evidence_cards?.length && (
        <details className="source">
          <summary>Sources ({p.evidence_cards.length})</summary>
          {p.evidence_cards.map((c) => (
            <blockquote key={c.chunk_id}>
              <b>{c.document}{c.page ? `, page ${c.page}` : ""}</b>
              {"\n"}“{c.text.slice(0, 360)}{c.text.length > 360 ? "…" : ""}”
            </blockquote>
          ))}
        </details>
      )}
      {(!!p.tool_trace?.length || !!p.claims?.length) && (
        <details className="source">
          <summary>Details</summary>
          <div className="trace" style={{ marginTop: 4 }}>
            {p.tool_trace?.map((t, i) => <div key={i}>{t.tool}({JSON.stringify(t.args)}) → {t.status}</div>)}
            {p.claims?.map((c) => <div key={c.claim_id}>{c.claim_id} → {c.source_type === "DATABASE" ? "interaction" : "chunk"} #{c.source_id}</div>)}
          </div>
        </details>
      )}
    </div>
  );
}
