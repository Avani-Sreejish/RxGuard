// Review screen, read top to bottom: what needs attention, the medicines, then each interaction
// (database fact, guideline evidence, the pharmacist's action). Provenance details sit behind
// "How was this found?" and the History tab.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { Lang } from "../App";
import { Highlight, Sev, Spinner, Synthetic } from "../components/Badges";
import Icon from "../components/Icon";
import InteractionMap from "../components/InteractionMap";
import ProveWhy from "../components/ProveWhy";
import AskPanel from "../components/AskPanel";
import AuditTrail from "../components/AuditTrail";
import type { Claim, Finding, Item, Prescription, Review } from "../types";

const DONE_LABEL: Record<string, string> = {
  ACKNOWLEDGE: "Acknowledged",
  ESCALATE: "Escalated to prescriber",
  REQUEST_MORE_EVIDENCE: "More evidence requested",
  MARK_FOR_FOLLOW_UP: "Marked for follow-up",
};
export const PRIORITY_LABEL: Record<string, string> = {
  P1: "Act now",
  P2: "Review",
  P3: "Low priority",
  CLEAR: "No interactions recorded",
};
const LANG_NAME: Record<string, string> = { hi: "Hindi", ml: "Malayalam" };
type Tab = "review" | "map" | "ask" | "history";

export default function Detail({ id, lang }: { id: number; lang: Lang }) {
  const [rx, setRx] = useState<Prescription | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [prove, setProve] = useState<number | null>(null);
  const [gate, setGate] = useState<string[]>([]);
  const [auditKey, setAuditKey] = useState(0);
  const [tab, setTab] = useState<Tab>("review");
  const [translations, setTranslations] = useState<Record<string, Record<number, any>>>({});
  const explained = useRef(false);

  const load = useCallback(() => {
    api<Prescription>(`/api/v1/prescriptions/${id}`).then(setRx).catch((e) => setErr(e.message));
  }, [id]);
  useEffect(load, [load]);

  // Each finding's database record in Hindi / Malayalam (fixed wording, no LLM; see the translate view).
  useEffect(() => {
    if (lang === "en" || translations[lang] || !rx?.findings.length) return;
    api<{ translated_findings: any[] }>(`/api/v1/prescriptions/${id}/translate`, { body: { language: lang } })
      .then((res) => {
        const map: Record<number, any> = {};
        res.translated_findings.forEach((tf) => (map[tf.finding_id] = tf));
        setTranslations((prev) => ({ ...prev, [lang]: map }));
      })
      .catch(() => undefined);
  }, [lang, id, rx?.findings.length, translations]);

  const run = async (label: string, fn: () => Promise<Prescription | void>) => {
    setBusy(label);
    setErr("");
    try {
      const r = await fn();
      if (r) setRx((cur) => ({ ...r, llm_usage: r.llm_usage ?? cur?.llm_usage, tool_trace: r.tool_trace ?? cur?.tool_trace }));
      setAuditKey((k) => k + 1);
      if (label !== "explain") setGate([]);
    } catch (e) {
      const ae = e as ApiError;
      if (ae.code === "review_gate_not_met") setGate(((ae.details as any)?.reasons as string[]) ?? [ae.message]);
      else setErr(ae.message);
    } finally {
      setBusy("");
    }
  };
  const explain = () => run("explain", () => api(`/api/v1/explain`, { body: { prescription_id: id } }));

  // Guideline evidence is looked up once, the first time a prescription with interactions is opened.
  useEffect(() => {
    if (!rx || rx.explanation || !rx.findings.length || explained.current) return;
    explained.current = true;
    void explain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rx]);

  if (!rx)
    return err ? <div className="error">{err}</div> : <div className="page-loading"><Spinner /> Loading prescription…</div>;

  const explanation = rx.explanation;
  const claimsFor = (f: Finding) =>
    explanation?.claims.filter((c) => c.finding_ordinal === f.ordinal && c.source_type === "RAG_CHUNK") ?? [];
  const unresolved = rx.items.filter((i) => !i.drug_id && i.method !== "pharmacist");
  const urgent = rx.findings.filter((f) => f.priority === "P1");
  const others = rx.findings.filter((f) => f.priority !== "P1");
  const needConfirm = rx.items.filter((i) => !i.drug_id || i.method === "pharmacist");
  const required = urgent.length + needConfirm.length;
  const done = urgent.filter((f) => f.reviews.length).length + needConfirm.filter((i) => i.method === "pharmacist").length;
  const completed = rx.status === "REVIEWED";
  const medCount = new Set(rx.items.filter((i) => i.drug_id).map((i) => i.drug_id)).size;
  const majors = rx.findings.filter((f) => f.severity === "Major").length;
  const act = (f: { id: number }, target?: "duplication") => (action: string, note: string) =>
    run("review", () => api(`/api/v1/reviews/${f.id}`, { body: target ? { action, note, target } : { action, note } }));
  const showFinding = (fid: number) => {
    setTab("review");
    setOpen(fid);
    setTimeout(() => document.getElementById(`finding-${fid}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  };

  const headline = rx.findings.length === 0
    ? `No interaction recorded between the ${medCount} medicine${medCount === 1 ? "" : "s"}.`
    : `${rx.findings.length} interaction${rx.findings.length === 1 ? "" : "s"} between ${medCount} medicines` +
      (majors ? `, ${majors} Major.` : ".");

  return (
    <div className="review">
      <a href="#/queue" className="back"><Icon name="arrowLeft" size={16} /> Review queue</a>

      <header className="rx-header">
        <div className="rx-title">
          <div>
            <h1>Prescription #{rx.id}</h1>
            <p className="meta">
              Patient age {rx.age_band === "unknown" ? "not given" : rx.age_band} · checked{" "}
              {new Date(rx.created_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
            </p>
          </div>
          <span className={`pill pill-lg prio-${rx.priority}`} title="Orders the queue; not a clinical risk score">
            {PRIORITY_LABEL[rx.priority]}
          </span>
        </div>

        <p className="headline">{headline}</p>
        {unresolved.length > 0 && (
          <p className="headline-sub warn-text">
            <Icon name="alert" size={16} /> {unresolved.length} medicine{unresolved.length === 1 ? " was" : "s were"} not recognised. Please confirm {unresolved.length === 1 ? "it" : "them"} below.
          </p>
        )}

        <div className="rx-progress">
          {completed ? (
            <span className="ok-text done-badge"><Icon name="check" /> Review completed</span>
          ) : (
            <>
              <div className="progress-wrap">
                <div className="progress-label">
                  {required === 0 ? "No required steps" : <><b>{done}</b> of {required} required steps done</>}
                </div>
                <div className="progress" aria-hidden>
                  <span style={{ width: `${required ? (100 * done) / required : 100}%` }} />
                </div>
              </div>
              <button className="btn primary" disabled={!!busy}
                onClick={() => run("complete", () => api(`/api/v1/prescriptions/${rx.id}/complete`, { method: "POST" }))}>
                {busy === "complete" ? <Spinner /> : <Icon name="check" size={16} />} Complete review
              </button>
            </>
          )}
        </div>
      </header>

      {rx.banners.filter((b) => b.kind !== "UNRESOLVED").map((b, i) => (
        <div key={i} className={`banner banner-${b.kind}`} role="alert">
          <Icon name={b.kind === "INJECTION" ? "shield" : "alert"} />
          <p>{b.text}</p>
        </div>
      ))}
      {gate.length > 0 && (
        <div className="banner banner-gate" role="alert">
          <Icon name="info" />
          <div>
            <p><b>Before you can complete this review:</b></p>
            <ul>{gate.map((g) => <li key={g}>{g}</li>)}</ul>
          </div>
        </div>
      )}
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="page-tabs" role="tablist">
        {([["review", "Review"], ["map", "Map"], ["ask", "Ask a question"], ["history", "History"]] as [Tab, string][]).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "review" && (
        <div className="stack">
          <section className="panel" aria-labelledby="meds-h">
            <h2 id="meds-h">Medicines</h2>
            <ul className="med-rows">
              {rx.items.map((i, n) => (
                <MedRow key={i.id} n={n + 1} i={i} onConfirm={(item, drugId) =>
                  run("confirm", () => api(`/api/v1/prescriptions/${rx.id}/items/${item.id}/confirm`,
                    { body: drugId ? { drug_id: drugId } : { not_in_database: true } }))} />
              ))}
            </ul>
          </section>

          {busy === "explain" && <p className="ev-loading"><Spinner /> Looking up guideline evidence…</p>}
          {!busy && !explanation && rx.findings.length > 0 && (
            <p className="note">
              Guideline evidence has not been loaded. <button className="linkish sm" onClick={explain}>Look it up now</button>
            </p>
          )}
          {explanation?.mode === "template" && (
            <p className="note">The AI explanation is unavailable, so only database facts and retrieved guideline text are shown.</p>
          )}
          {!!explanation?.dropped.length && (
            <p className="note">{explanation.dropped.length} AI statement(s) were removed because they could not be verified against a source.</p>
          )}
          {lang !== "en" && rx.findings.length > 0 && (
            <p className="note">Each interaction is also shown in {LANG_NAME[lang]}. Medicine names and guideline text stay in English.</p>
          )}

          {rx.findings.length === 0 && (
            <div className="clear-card">
              <Icon name="check" size={24} />
              <div>
                <h3>No interaction recorded</h3>
                <p>{rx.absent_pairs_wording} for any of the {rx.pairs_checked} pair(s) checked. That does not mean the combination is safe.</p>
              </div>
            </div>
          )}

          {urgent.length > 0 && (
            <section aria-labelledby="urgent-h">
              <h2 id="urgent-h" className="group-h">Needs your action <span className="count">{urgent.length}</span></h2>
              <div className="stack-sm">
                {urgent.map((f) => (
                  <FindingCard key={f.id} f={f} claims={claimsFor(f)} busy={!!busy} explaining={busy === "explain"}
                    hasExplanation={!!explanation} tr={lang !== "en" ? translations[lang]?.[f.id] : undefined} lang={lang}
                    onProve={() => setProve(f.id)} onAct={act(f)} />
                ))}
              </div>
            </section>
          )}

          {(others.length > 0 || rx.duplications.length > 0) && (
            <section aria-labelledby="other-h">
              <h2 id="other-h" className="group-h">
                {urgent.length ? "Other interactions" : "Interactions"} <span className="count">{others.length + rx.duplications.length}</span>
              </h2>
              {urgent.length > 0 && <p className="meta" style={{ marginBottom: 8 }}>No action required. Open one to see the details.</p>}
              <div className="stack-sm">
                {others.map((f) =>
                  open === f.id || urgent.length === 0 ? (
                    <FindingCard key={f.id} f={f} claims={claimsFor(f)} busy={!!busy} explaining={busy === "explain"}
                      hasExplanation={!!explanation} tr={lang !== "en" ? translations[lang]?.[f.id] : undefined} lang={lang}
                      onProve={() => setProve(f.id)} onAct={act(f)}
                      onCollapse={urgent.length ? () => setOpen(null) : undefined} />
                  ) : (
                    <button key={f.id} id={`finding-${f.id}`} type="button" className="frow" onClick={() => setOpen(f.id)}>
                      <span className="frow-pair">{f.drug_a} <span className="plus">+</span> {f.drug_b}</span>
                      {f.reviews.length > 0 && <span className="ok-text small"><Icon name="check" size={14} /> {DONE_LABEL[f.reviews[f.reviews.length - 1].action]}</span>}
                      <Sev s={f.severity} />
                      <Icon name="chevron" size={16} />
                    </button>
                  ),
                )}
                {rx.duplications.map((d) => (
                  <article key={`d${d.id}`} className="fcard">
                    <div className="fcard-head">
                      <h3>Same ingredient twice: {d.drug}</h3>
                    </div>
                    <p className="fact">Appears on: {d.item_labels.join("; ")}</p>
                    <ActionBar reviews={d.reviews} busy={!!busy} onAct={act(d, "duplication")} />
                  </article>
                ))}
              </div>
            </section>
          )}

          <p className="fine-print">
            {rx.findings.length > 0 && rx.absent_pairs_count > 0 &&
              `No interaction recorded for the other ${rx.absent_pairs_count} pair(s); that does not mean those combinations are safe. `}
            Medicines are checked in pairs only; nothing is claimed about three or more taken together.
          </p>
        </div>
      )}

      {tab === "map" && (
        <section className="panel">
          <InteractionMap rx={rx} selected={open} onSelect={showFinding} />
          <p className="meta" style={{ marginTop: 8 }}>Click a line to open that interaction.</p>
        </section>
      )}
      {tab === "ask" && <section className="panel"><AskPanel rx={rx} /></section>}
      {tab === "history" && (
        <div className="stack">
          <section className="panel"><AuditTrail id={rx.id} refreshKey={auditKey} /></section>
          <section className="panel"><TechnicalLog rx={rx} refreshKey={auditKey} /></section>
        </div>
      )}

      {prove && <ProveWhy findingId={prove} onClose={() => setProve(null)} />}
    </div>
  );
}

function FindingCard({ f, claims, busy, explaining, hasExplanation, tr, lang, onProve, onAct, onCollapse }: {
  f: Finding; claims: Claim[]; busy: boolean; explaining: boolean; hasExplanation: boolean; tr?: any; lang: Lang;
  onProve: () => void; onAct: (action: string, note: string) => void; onCollapse?: () => void;
}) {
  const source = f.source === "DDInter" ? "the DDInter interaction database" : "your hospital's uploaded interaction list";
  return (
    <article id={`finding-${f.id}`} className={`fcard sev-edge-${f.severity}`}>
      <div className="fcard-head">
        <h3>{f.drug_a} <span className="plus">+</span> {f.drug_b}</h3>
        <Sev s={f.severity} />
        {onCollapse && (
          <button type="button" className="icon-btn" aria-label="Collapse" onClick={onCollapse}>
            <Icon name="x" size={16} />
          </button>
        )}
      </div>

      <p className="fact">
        Recorded as a <b>{f.severity === "Unknown" ? "unknown-severity" : f.severity}</b> interaction in {source}.
      </p>
      {tr && (
        <div className="tr-block" lang={lang}>
          <div className="tr-text">{tr.db_claim_translated}</div>
          <div className="tr-note">Fixed translation of the database record. The English text is the reference.</div>
        </div>
      )}

      <div className="guideline">
        <div className="guideline-h">
          <span>What the guidelines say</span>
          {claims.length > 0 && <span className="tag tag-brand" title="Written by AI, then checked against the quoted source">AI summary · verified</span>}
        </div>
        {explaining && !hasExplanation ? (
          <p className="ev-loading"><Spinner /> Looking up guideline evidence…</p>
        ) : claims.length > 0 ? (
          <ul className="plain-list">
            {claims.map((c) => (
              <li key={c.claim_id}>
                {c.text}
                {c.chunk && (
                  <details className="source">
                    <summary>{c.chunk.document}{c.chunk.page != null ? `, page ${c.chunk.page}` : ""}</summary>
                    <blockquote><Highlight text={c.chunk.text} span={c.support_span} /></blockquote>
                  </details>
                )}
              </li>
            ))}
          </ul>
        ) : f.evidence.length > 0 ? (
          <ul className="plain-list">
            {f.evidence.slice(0, 2).map((e) => (
              <li key={e.chunk_id}>
                <details className="source">
                  <summary>Related passage: {e.document}{e.page != null ? `, page ${e.page}` : ""}</summary>
                  <blockquote><Highlight text={e.text} span={e.support_span} /></blockquote>
                </details>
              </li>
            ))}
          </ul>
        ) : hasExplanation || f.evidence_status === "INSUFFICIENT" ? (
          <p className="muted">No supporting guideline text found for this pair. Use your professional judgement.</p>
        ) : (
          <p className="muted">Not looked up yet.</p>
        )}
      </div>

      <ActionBar reviews={f.reviews} busy={busy} onAct={onAct} />
      <button type="button" className="linkish sm how" onClick={onProve}>How was this found?</button>
    </article>
  );
}

function ActionBar({ reviews, busy, onAct }: { reviews: Review[]; busy: boolean; onAct: (action: string, note: string) => void }) {
  const [note, setNote] = useState("");
  const [more, setMore] = useState(false);
  const [again, setAgain] = useState(false);
  const last = reviews[reviews.length - 1];
  const act = (a: string) => {
    onAct(a, note.trim());
    setNote("");
    setMore(false);
    setAgain(false);
  };
  return (
    <div className="actions">
      {reviews.map((r) => (
        <p key={r.id} className="done-line">
          <Icon name="check" size={15} />
          <span>
            <b>{DONE_LABEL[r.action] ?? r.action}</b> by {r.user}
            {r.note && <> · “{r.note}”</>}
            {r.stale && <span className="warn-text"> · the knowledge base has changed since</span>}
          </span>
        </p>
      ))}
      {last && !again ? (
        <button type="button" className="linkish sm" onClick={() => setAgain(true)}>Change or add an action</button>
      ) : (
        <>
          <div className="row">
            <button className="btn sm primary-soft" disabled={busy} onClick={() => act("ACKNOWLEDGE")}>
              <Icon name="check" size={15} /> Acknowledge
            </button>
            <button className="btn sm danger-soft" disabled={busy} onClick={() => act("ESCALATE")}>
              <Icon name="flag" size={15} /> Escalate to prescriber
            </button>
            <button className="btn sm ghost" onClick={() => setMore((m) => !m)} aria-expanded={more}>
              More <Icon name="chevron" size={14} />
            </button>
          </div>
          {more && (
            <div className="more-actions">
              <div className="row">
                <button className="btn sm ghost" disabled={busy} onClick={() => act("REQUEST_MORE_EVIDENCE")}>
                  <Icon name="book" size={15} /> Need more evidence
                </button>
                <button className="btn sm ghost" disabled={busy} onClick={() => act("MARK_FOR_FOLLOW_UP")}>
                  <Icon name="clock" size={15} /> Follow up later
                </button>
              </div>
              <input type="text" placeholder="Note saved with your next action (optional)" aria-label="Note"
                value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function MedRow({ n, i, onConfirm }: { n: number; i: Item; onConfirm: (i: Item, drugId: number | null) => void }) {
  if (!i.drug_id && i.method !== "pharmacist")
    return (
      <li className="med-row med-row-open">
        <span className="med-n">{n}</span>
        <ConfirmItem item={i} onConfirm={onConfirm} />
      </li>
    );
  return (
    <li className="med-row">
      <span className="med-n">{n}</span>
      <div className="med-main">
        <div className="med-name">
          {i.drug ?? i.matched_text}
          {i.nlem_listed && <span className="tag tag-brand" title="National List of Essential Medicines 2022">NLEM</span>}
          {i.is_synthetic && <Synthetic />}
        </div>
        <div className="meta">
          {i.method === "pharmacist" ? "Confirmed by you as not in the database" : <>Written as “{i.raw_span.replace(/^\s*\d+[.)]\s*/, "")}”</>}
          {i.product && ` · brand ${i.product}`}
        </div>
        {i.method === "fuzzy" && <div className="warn-text small">Read as {i.drug} from a misspelling. Please check.</div>}
      </div>
    </li>
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
    <div className="med-main confirm-box">
      <div className="med-name">“{item.raw_span.replace(/^\s*\d+[.)]\s*/, "")}”</div>
      <p className="warn-text small">Not recognised. Which medicine is it?</p>
      {res.length > 0 && (
        <div className="cands">
          {res.slice(0, 5).map((c) => (
            <button key={c.drug_id} type="button" className="chip" onClick={() => onConfirm(item, c.drug_id)}>{c.name}</button>
          ))}
        </div>
      )}
      <div className="row">
        <input type="text" placeholder="Search for the medicine" aria-label="Search for the medicine" value={q}
          onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />
        <button type="button" className="linkish sm" onClick={() => onConfirm(item, null)}>It is not in the database</button>
      </div>
    </div>
  );
}

function TechnicalLog({ rx, refreshKey }: { rx: Prescription; refreshKey: number }) {
  const [steps, setSteps] = useState<{ id: number; graph: string; node: string; status: string; latency_ms: number; summary: string }[]>([]);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (opened) api(`/api/v1/prescriptions/${rx.id}/steps`).then((r) => setSteps(r.steps));
  }, [rx.id, opened, refreshKey]);
  return (
    <details className="more" onToggle={(e) => setOpened((e.target as HTMLDetailsElement).open)}>
      <summary>Technical details</summary>
      <dl className="kv" style={{ marginTop: 10 }}>
        <dt>Priority rules</dt>
        <dd>{rx.rule_hits.map((h) => `${h.rule_id}: ${h.description}`).join(" · ") || "none fired"}</dd>
        <dt>Knowledge base</dt><dd>{rx.kb_version}{rx.current_kb_version !== rx.kb_version && ` (current ${rx.current_kb_version})`}</dd>
        <dt>Request ID</dt><dd className="code">{rx.correlation_id}</dd>
        <dt>LLM use for the check</dt><dd>{rx.llm_tokens_check.input + rx.llm_tokens_check.output} tokens</dd>
        {rx.llm_usage && <><dt>LLM use for evidence</dt><dd>{rx.llm_usage.calls} call(s), {rx.llm_usage.input_tokens} in / {rx.llm_usage.output_tokens} out</dd></>}
        <dt>Safety flags</dt><dd>{rx.escalations.map((e) => e.reason_code).join(", ") || "none"}</dd>
      </dl>
      {steps.length > 0 && (
        <div className="trace" style={{ marginTop: 10 }}>
          {steps.map((s) => <div key={s.id}>[{s.graph}] {s.node} · {s.status} · {s.latency_ms} ms — {s.summary}</div>)}
        </div>
      )}
    </details>
  );
}
