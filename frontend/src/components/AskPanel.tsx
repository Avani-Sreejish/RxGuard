import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { useI18n } from "../i18n";
import type { AskResult, Prescription } from "../types";
import { Spinner, Tag } from "./Badges";
import Icon from "./Icon";
import { TranslationOf, useTranslations } from "./Translate";

interface Msg {
  role: "user" | "assistant";
  content: string;
  payload?: Partial<AskResult>;
}

export default function AskPanel({ rx }: { rx: Prescription }) {
  const { t } = useI18n();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const tr = useTranslations(msgs.filter((m) => m.role === "assistant").map((m) => m.content));

  useEffect(() => {
    if (!rx.session_id) return;
    api<{ messages: (Msg & { prescription_id: number | null })[] }>(`/api/v1/sessions/${rx.session_id}`)
      .then((s) => {
        const loaded = s.messages.filter((m) => (m.role === "user" || m.role === "assistant") && m.prescription_id === rx.id);
        setMsgs((cur) => (cur.length ? cur : loaded)); // never overwrite a question asked while history was loading
      })
      .catch(() => undefined);
  }, [rx.session_id, rx.id]);

  useEffect(() => end.current?.scrollIntoView({ block: "nearest" }), [msgs.length]);

  const ask = async (question: string) => {
    if (!rx.session_id || !question.trim() || busy) return;
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
    <div className="ask">
      <p className="muted small">{t("ask.help")}</p>
      <div className="chat" aria-live="polite">
        {msgs.length === 0 && <p className="panel-empty-line">{t("ask.empty")}</p>}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <p>{m.content}</p>
            {m.role === "assistant" && <TranslationOf text={m.content} get={tr} />}
            {m.payload && (m.payload.mode === "refusal" || m.payload.mode === "insufficient") && (
              <Tag tone="warn">{m.payload.mode === "refusal" ? t("ask.refusal") : t("ask.insufficient")}</Tag>
            )}
            {!!m.payload?.evidence_cards?.length && (
              <ul className="ask-cards">
                {m.payload.evidence_cards.slice(0, 2).map((c) => (
                  <li key={c.chunk_id}>
                    <b>{c.document}</b> · {c.section}
                  </li>
                ))}
              </ul>
            )}
            {!!m.payload?.tool_trace?.length && (
              <details className="trace">
                <summary>Tools used ({m.payload.tool_trace.length})</summary>
                {m.payload.tool_trace.map((x, j) => (
                  <div key={j} className="code">
                    {x.tool} [{x.status}] {x.result ?? ""}
                  </div>
                ))}
              </details>
            )}
          </div>
        ))}
        {busy && (
          <div className="msg assistant">
            <Spinner />
          </div>
        )}
        <div ref={end} />
      </div>
      {err && <p className="err-text" role="alert">{err}</p>}
      <div className="suggest">
        {[t("ask.s1"), t("ask.s2")].map((s) => (
          <button key={s} type="button" className="chip" onClick={() => ask(s)} disabled={busy}>
            {s}
          </button>
        ))}
      </div>
      <form
        className="ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          ask(q);
        }}
      >
        <input id="ask-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("ask.ph")} aria-label={t("ask.ph")} maxLength={1000} />
        <button className="btn primary" disabled={busy || !q.trim()} aria-label={t("ask.send")}>
          <Icon name="chat" size={16} /> {t("ask.send")}
        </button>
      </form>
    </div>
  );
}
