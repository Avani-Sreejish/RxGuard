import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { dbClaim, useI18n } from "../i18n";
import { patientForRx, updateCheck } from "../patients";
import type { Finding, Item, Prescription, ReviewActionType } from "../types";
import { fmtDateTime, PriorityPill, SeverityPill, Spinner, StatusText, Tag } from "../components/Badges";
import DrugSearch from "../components/DrugSearch";
import EvidencePanel from "../components/EvidencePanel";
import AskPanel from "../components/AskPanel";
import AuditPanel from "../components/AuditPanel";
import Icon from "../components/Icon";
import { PatientLine } from "../components/PatientPicker";
import ReviewActions from "../components/ReviewActions";
import { Link } from "../router";

type Tab = "evidence" | "ask" | "audit";

export default function Review({ id }: { id: number }) {
  const { t, lang } = useI18n();
  const [rx, setRx] = useState<Prescription | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [explaining, setExplaining] = useState(false);
  const [explainErr, setExplainErr] = useState("");
  const [sel, setSel] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("evidence");
  const [gate, setGate] = useState<string[]>([]);
  const [auditVersion, setAuditVersion] = useState(0);
  const explained = useRef<number | null>(null);
  const patient = patientForRx(id);

  const apply = useCallback((r: Prescription) => {
    setRx(r);
    setAuditVersion((v) => v + 1);
    updateCheck(r.id, { priority: r.priority, medicines: [...new Set(r.items.filter((i) => i.drug).map((i) => i.drug as string))] });
  }, []);

  useEffect(() => {
    setRx(null);
    setLoadErr("");
    setSel(null);
    setGate([]);
    api<Prescription>(`/api/v1/prescriptions/${id}`).then(apply).catch((e) => setLoadErr(e.message));
  }, [id, apply]);

  const explain = useCallback(async (rxId: number) => {
    setExplaining(true);
    setExplainErr("");
    try {
      apply(await api<Prescription>("/api/v1/explain", { body: { prescription_id: rxId } }));
    } catch (e) {
      setExplainErr((e as ApiError).message);
    } finally {
      setExplaining(false);
    }
  }, [apply]);

  // Attach guideline evidence automatically the first time a prescription with findings is opened.
  useEffect(() => {
    if (!rx || rx.explanation || !rx.findings.length || explained.current === rx.id) return;
    explained.current = rx.id;
    void explain(rx.id);
  }, [rx, explain]);

  useEffect(() => {
    if (rx && sel === null && rx.findings.length) setSel(rx.findings[0].id);
  }, [rx, sel]);

  const run = async (label: string, fn: () => Promise<Prescription>) => {
    setBusy(label);
    setErr("");
    try {
      apply(await fn());
      setGate([]);
    } catch (e) {
      const ae = e as ApiError;
      if (ae.code === "review_gate_not_met") setGate(((ae.details as any)?.reasons as string[]) ?? [ae.message]);
      else setErr(ae.message);
    } finally {
      setBusy("");
    }
  };

  if (loadErr)
    return (
      <div className="page">
        <p className="err-text">{loadErr}</p>
        <Link to="/queue" className="btn ghost">{t("nav.queue")}</Link>
      </div>
    );
  if (!rx)
    return (
      <div className="page page-loading">
        <Spinner /> {t("common.loading")}
      </div>
    );

  const locked = rx.status === "REVIEWED";
  const selected = rx.findings.find((f) => f.id === sel);
  const claimsFor = (f: Finding | undefined) => (f ? rx.explanation?.claims.filter((c) => c.finding_ordinal === f.ordinal) ?? [] : []);
  const droppedFor = (f: Finding | undefined) => (f ? rx.explanation?.dropped.filter((d) => d.finding_ordinal === f.ordinal).length ?? 0 : 0);
  const unresolved = rx.items.filter((i) => !i.drug_id && i.method !== "pharmacist");
  const p1 = rx.findings.filter((f) => f.priority === "P1");
  const needsConfirm = rx.items.filter((i) => !i.drug_id || i.method === "pharmacist");
  const required = p1.length + needsConfirm.length;
  const done = p1.filter((f) => f.reviews.length).length + needsConfirm.filter((i) => i.method === "pharmacist").length;

  const record = (fid: number, target: "finding" | "duplication") => async (action: ReviewActionType, note: string) =>
    run("review", () => api(`/api/v1/reviews/${fid}`, { body: target === "duplication" ? { action, note, target } : { action, note } }));

  const lines = new Map<number, Item[]>();
  rx.items.forEach((i) => lines.set(i.line_no, [...(lines.get(i.line_no) ?? []), i]));

  return (
    <div className="page page-review">
      <header className="rev-head">
        <div className="rev-id">
          <Link to="/queue" className="back">
            <Icon name="arrowLeft" size={16} /> {t("nav.queue")}
          </Link>
          <div className="rev-patient">{patient ? <PatientLine p={patient} /> : <span className="muted">{t("queue.unlinked")}</span>}</div>
          <h1>{t("rev.rx", { id: rx.id })}</h1>
          <p className="meta">
            {t("rev.checked", { time: fmtDateTime(rx.created_at, lang) })} · {t("rev.kb", { v: rx.kb_version })} · <StatusText s={rx.status} />
          </p>
        </div>
        <div className="rev-actions">
          <PriorityPill p={rx.priority} />
          {!locked && required > 0 && <span className="gate-count">{t("rev.gate", { done, total: required })}</span>}
          {locked ? (
            <span className="ok-text done-badge">
              <Icon name="check" /> {t("rev.completed")}
            </span>
          ) : (
            <button className="btn primary" disabled={!!busy} onClick={() => run("complete", () => api(`/api/v1/prescriptions/${rx.id}/complete`, { method: "POST" }))}>
              {busy === "complete" ? t("common.loading") : t("rev.complete")}
            </button>
          )}
        </div>
      </header>

      {rx.banners.map((b, i) => (
        <div key={i} className={`banner banner-${b.kind}`} role="alert">
          <Icon name={b.kind === "INJECTION" ? "shield" : "alert"} />
          <div>
            <p>{t(`banner.${b.kind}`, { n: unresolved.length }) === `banner.${b.kind}` ? b.text : t(`banner.${b.kind}`, { n: unresolved.length })}</p>
            {(b.terms ?? b.patterns)?.length ? <p className="meta">{t("banner.matched", { list: (b.terms ?? b.patterns)!.join(", ") })}</p> : null}
          </div>
        </div>
      ))}
      {gate.length > 0 && (
        <div className="banner banner-gate" role="alert">
          <Icon name="info" />
          <div>
            <p><b>{t("rev.gateTitle")}</b></p>
            <ul>{gate.map((g) => <li key={g}>{g}</li>)}</ul>
          </div>
        </div>
      )}
      {err && <p className="err-text" role="alert">{err}</p>}

      <div className="rev-grid">
        <section className="col col-meds" aria-labelledby="meds-h">
          <h2 id="meds-h">{t("rev.medicines")}</h2>
          <ol className="med-list">
            {[...lines.entries()].map(([lineNo, its]) => (
              <li key={lineNo} className={`med ${its.some((i) => !i.drug_id && i.method !== "pharmacist") ? "med-open" : ""}`}>
                <span className="rx-no">{lineNo}</span>
                <div className="med-body">
                  <div className="med-raw">{its[0].raw_span}</div>
                  {its.map((it) => (
                    <MedItem key={it.id} it={it} locked={locked} busy={!!busy}
                      onConfirm={(drugId) => run("confirm", () => api(`/api/v1/prescriptions/${rx.id}/items/${it.id}/confirm`, { body: drugId ? { drug_id: drugId } : { not_in_database: true } }))} />
                  ))}
                </div>
              </li>
            ))}
          </ol>
          {rx.lines_ignored > 0 && <p className="note">{t("rev.ignored", { n: rx.lines_ignored })}</p>}
        </section>

        <section className="col col-findings" aria-labelledby="find-h">
          <div className="col-title">
            <h2 id="find-h">{t("rev.findings")}</h2>
            {rx.findings.length > 0 && <span className="muted">{t("rev.summary", { n: rx.findings.length, pairs: rx.pairs_checked })}</span>}
          </div>

          {rx.findings.length === 0 && (
            <div className="clear-card">
              <Icon name="check" size={26} />
              <div>
                <h3>{t("rev.clearTitle")}</h3>
                <p>{rx.pairs_checked > 0 ? t("rev.clearBody", { kb: rx.kb_version, pairs: rx.pairs_checked }) : t("rev.nothingToPair")}</p>
              </div>
            </div>
          )}

          <ul className="findings">
            {rx.findings.map((f) => (
              <li key={f.id}>
                <div
                  role="button"
                  tabIndex={0}
                  aria-pressed={sel === f.id}
                  className={`finding prio-edge-${f.priority} ${sel === f.id ? "selected" : ""}`}
                  onClick={() => { setSel(f.id); setTab("evidence"); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSel(f.id); setTab("evidence"); } }}
                >
                  <div className="finding-top">
                    <span className="ordinal">{f.ordinal}</span>
                    <h3>
                      {f.drug_a} <span className="plus">+</span> {f.drug_b}
                    </h3>
                    <SeverityPill s={f.severity} />
                  </div>
                  <p className="why">
                    <span className="muted">{t("rev.why")}:</span> {t(`rule.${f.rule_id}`)} <span className="code">{f.rule_id}</span> · <PriorityPill p={f.priority} />
                  </p>
                  <p className="db-line">{dbClaim(t, lang, f)}</p>
                  <p className="ev-line">
                    {explaining && f.evidence_status !== "FOUND" ? (
                      <><Spinner /> {t("rev.retrieving")}</>
                    ) : f.evidence_status === "FOUND" ? (
                      <><Icon name="book" size={15} /> {t("rev.passageCount", { n: f.evidence.length })}</>
                    ) : f.evidence_status === "INSUFFICIENT" ? (
                      <span className="muted">{t("insufficient")}</span>
                    ) : null}
                  </p>
                  <ReviewActions key={`${f.id}-${sel === f.id}`} reviews={f.reviews} required={f.priority === "P1"} locked={locked} busy={!!busy} compact={sel !== f.id} onRecord={record(f.id, "finding")} />
                </div>
              </li>
            ))}
            {rx.duplications.map((d) => (
              <li key={`d${d.id}`}>
                <div className="finding prio-edge-P2 dup">
                  <div className="finding-top">
                    <span className="ordinal">=</span>
                    <h3>{t("rev.duplicate")}</h3>
                    <Tag tone="warn">R8</Tag>
                  </div>
                  <p className="db-line">{t("rev.dupBody", { drug: d.drug, lines: d.item_labels.join("; ") })}</p>
                  <ReviewActions reviews={d.reviews} required={false} locked={locked} busy={!!busy} compact onRecord={record(d.id, "duplication")} />
                </div>
              </li>
            ))}
          </ul>
          {explainErr && (
            <p className="err-text">
              {t("rev.explainFailed", { msg: explainErr })}{" "}
              <button className="linkish" onClick={() => explain(rx.id)}>{t("common.retry")}</button>
            </p>
          )}
          {rx.findings.length > 0 && rx.absent_pairs_count > 0 && <p className="note">{t("rev.absent", { n: rx.absent_pairs_count, kb: rx.kb_version })}</p>}
          {rx.findings.length > 0 && (
            <p className="note">
              {t("rev.pairwise")} {t("rev.priorityNote")}
            </p>
          )}
        </section>

        <aside className="col col-side">
          <div className="tabs" role="tablist">
            {(["evidence", "ask", "audit"] as Tab[]).map((k) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
                <Icon name={k === "evidence" ? "book" : k === "ask" ? "chat" : "link"} size={16} />
                {t(k === "evidence" ? "rev.evidence" : k === "ask" ? "rev.ask" : "rev.audit")}
              </button>
            ))}
          </div>
          <div className="tab-body" role="tabpanel">
            {tab === "evidence" && (
              <EvidencePanel
                finding={selected}
                claims={claimsFor(selected)}
                explaining={explaining}
                explainMode={rx.explanation?.mode ?? null}
                droppedCount={droppedFor(selected)}
                degraded={!!selected?.degraded_retrieval}
              />
            )}
            {tab === "ask" && <AskPanel rx={rx} />}
            {tab === "audit" && <AuditPanel rxId={rx.id} version={auditVersion} />}
          </div>
        </aside>
      </div>
    </div>
  );
}

function MedItem({ it, locked, busy, onConfirm }: { it: Item; locked: boolean; busy: boolean; onConfirm: (drugId: number | null) => void }) {
  const { t } = useI18n();
  if (it.drug_id)
    return (
      <div className="med-drug">
        <Icon name="pill" size={15} />
        <b>{it.drug}</b>
        {it.nlem_listed && <Tag tone="brand">{t("item.nlem")}</Tag>}
        {it.product && <span className="meta">{it.is_synthetic ? t("item.brand", { brand: it.product }) : it.product}</span>}
        {it.method === "fuzzy" && it.confidence !== null && (
          <span className="meta warn-text">{t("item.fuzzy", { t: it.matched_text, drug: it.drug ?? "", c: Math.round(it.confidence) })}</span>
        )}
        {it.method === "pharmacist" && <span className="meta">{t("item.byPharmacist")}</span>}
      </div>
    );
  if (it.method === "pharmacist") return <div className="med-drug muted">{t("item.notListed")}</div>;
  return (
    <div className="med-unresolved">
      <p className="warn-text">
        <Icon name="alert" size={15} /> {t("item.unresolved")}
      </p>
      {!locked && (
        <>
          {it.candidates.length > 0 && (
            <div className="cands">
              <span className="meta">{t("item.confirmAs")}</span>
              {it.candidates.map((c) => (
                <button key={c.drug_id} type="button" className="chip" disabled={busy} onClick={() => onConfirm(c.drug_id)}>
                  {c.name} <span className="meta">{Math.round(c.score)}%</span>
                </button>
              ))}
            </div>
          )}
          <DrugSearch compact allowFree={false} placeholder={t("item.search")} onPick={(_, hit) => hit && onConfirm(hit.drug_id)} />
          <button type="button" className="linkish sm" disabled={busy} onClick={() => onConfirm(null)}>
            {t("item.notInDb")}
          </button>
        </>
      )}
    </div>
  );
}
