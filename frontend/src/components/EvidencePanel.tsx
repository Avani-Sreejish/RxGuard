// Guideline evidence for one finding: database fact, verified AI sentences with numbered citations,
// and the retrieved passages themselves (document, section, page, version, licence).
import { useState } from "react";
import { api } from "../api";
import { dbClaim, useI18n } from "../i18n";
import type { Claim, Finding, FindingDetail } from "../types";
import { SeverityPill, Spinner, Tag } from "./Badges";
import Icon from "./Icon";
import { TranslationOf, useTranslations } from "./Translate";

function highlight(text: string, span?: string) {
  if (!span) return text;
  const i = text.toLowerCase().indexOf(span.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + span.length)}</mark>
      {text.slice(i + span.length)}
    </>
  );
}

const DOC_TYPE: Record<string, string> = { NLEM: "NLEM 2022", ICMR_STW: "ICMR STW", STW: "ICMR STW", WHO_MF: "WHO formulary" };

export default function EvidencePanel({
  finding,
  claims,
  explaining,
  explainMode,
  droppedCount,
  degraded,
}: {
  finding: Finding | undefined;
  claims: Claim[];
  explaining: boolean;
  explainMode: string | null;
  droppedCount: number;
  degraded: boolean;
}) {
  const { t, lang } = useI18n();
  const passages = finding?.evidence ?? [];
  const aiClaims = claims.filter((c) => c.source_type === "RAG_CHUNK" && c.kept);
  const tr = useTranslations([...aiClaims.map((c) => c.text), ...passages.map((p) => p.text)]);

  if (!finding)
    return (
      <div className="panel-empty">
        <Icon name="book" size={28} />
        <p>{t("rev.selectFinding")}</p>
      </div>
    );

  const citeNo = (c: Claim) => {
    const i = passages.findIndex((p) => p.chunk_id === c.chunk?.chunk_id || p.text === c.chunk?.text);
    return i >= 0 ? i + 1 : null;
  };

  return (
    <div className="evidence">
      <header className="ev-head">
        <h3>
          {finding.drug_a} <span className="plus">+</span> {finding.drug_b}
        </h3>
        <SeverityPill s={finding.severity} />
      </header>

      <section className="ev-block">
        <h4>
          <Icon name="list" size={16} /> {t("rev.dbRecord")}
        </h4>
        <p className="claim db-claim">{dbClaim(t, lang, finding)}</p>
        <p className="meta">{t("rev.recordId", { id: finding.source_record_id, kb: finding.kb_version })}</p>
      </section>

      {explaining && (
        <p className="ev-loading">
          <Spinner /> {t("rev.retrieving")}
        </p>
      )}

      {!explaining && aiClaims.length > 0 && (
        <section className="ev-block">
          <h4>
            <Icon name="check" size={16} /> {t("rev.verified")}
          </h4>
          {aiClaims.map((c) => {
            const n = citeNo(c);
            return (
              <div key={c.claim_id} className="claim ai-claim">
                <p>
                  {c.text}{" "}
                  {n && (
                    <a className="cite" href={`#passage-${finding.id}-${n}`} onClick={(e) => { e.preventDefault(); document.getElementById(`passage-${finding.id}-${n}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }} aria-label={t("rev.cite", { n })}>
                      {n}
                    </a>
                  )}
                </p>
                <TranslationOf text={c.text} get={tr} />
                {c.support_score !== null && <span className="meta">{t("rev.support", { s: c.support_score.toFixed(2) })}</span>}
              </div>
            );
          })}
        </section>
      )}
      {!explaining && explainMode === "template" && <p className="note">{t("rev.template")}</p>}
      {!explaining && droppedCount > 0 && <p className="note">{t("rev.claimsRemoved", { n: droppedCount })}</p>}
      {!explaining && degraded && <p className="note">{t("rev.degraded")}</p>}

      {!explaining && (
        <section className="ev-block">
          <h4>
            <Icon name="book" size={16} /> {t("rev.passages")}
          </h4>
          {passages.length === 0 ? (
            <div className="insufficient">
              <p>{finding.evidence_status === "PENDING" ? t("rev.retrieving") : t("rev.noEvidence")}</p>
            </div>
          ) : (
            <ol className="passages">
              {passages.map((p, i) => (
                <li key={p.chunk_id} id={`passage-${finding.id}-${i + 1}`} className="passage">
                  <div className="passage-head">
                    <span className="passage-no">{i + 1}</span>
                    <div>
                      <div className="doc-title">{p.document}</div>
                      <div className="doc-meta">
                        <Tag tone="brand">{DOC_TYPE[p.doc_type] ?? p.doc_type}</Tag>
                        <span>{p.section}</span>
                        {p.page !== null && <span>{t("rev.page", { p: p.page })}</span>}
                        <span>{p.version}</span>
                      </div>
                    </div>
                  </div>
                  <blockquote>{highlight(p.text, p.support_span)}</blockquote>
                  <TranslationOf text={p.text} get={tr} />
                  <div className="passage-foot">
                    {p.sample && <Tag tone="warn">{t("rev.sample")}</Tag>}
                    {p.matched_via && Object.keys(p.matched_via).length > 0 && (
                      <span className="meta">
                        {t("rev.matched", { how: Object.entries(p.matched_via).map(([d, v]) => `${d} (${v})`).join(", ") })}
                      </span>
                    )}
                    <span className="meta">{p.license}</span>
                    {p.url && (
                      <a href={p.url} target="_blank" rel="noreferrer" className="ext">
                        {t("rev.openSource")} <Icon name="external" size={14} />
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      <Provenance key={finding.id} findingId={finding.id} />
    </div>
  );
}

/** "Prove why": the full trace for this finding from GET /api/v1/findings/{id}. */
function Provenance({ findingId }: { findingId: number }) {
  const { t } = useI18n();
  const [d, setD] = useState<FindingDetail | null>(null);
  const [err, setErr] = useState("");
  const load = (open: boolean) => {
    if (open && !d && !err) api<FindingDetail>(`/api/v1/findings/${findingId}`).then(setD).catch((e) => setErr(e.message));
  };
  return (
    <details className="provenance" onToggle={(e) => load(e.currentTarget.open)}>
      <summary>{t("rev.provenance")}</summary>
      {err && <p className="err-text">{err}</p>}
      {!d && !err && <Spinner />}
      {d && (
        <dl>
          <dt>Database row</dt>
          <dd>
            {d.database_record.table} · id {d.database_record.interaction_id} · {d.database_record.source_record_id} · KB {d.database_record.kb_version}
          </dd>
          {d.sources.map((s) => (
            <div key={s.name} className="dl-row">
              <dt>Source</dt>
              <dd>
                {s.name} {s.version} · {s.license} · retrieved {s.retrieved_at?.slice(0, 10)}
              </dd>
            </div>
          ))}
          {d.explanation && (
            <>
              <dt>Explanation</dt>
              <dd>
                {d.explanation.mode} · {d.explanation.model} · {d.explanation.prompt_version}
              </dd>
            </>
          )}
          <dt>Claims kept / dropped</dt>
          <dd>
            {d.claims_kept.length} / {d.claims_dropped.length}
            {d.claims_dropped.map((c) => ` · ${c.claim_id}: ${c.reason}`).join("")}
          </dd>
          <dt>Correlation ID</dt>
          <dd className="code">{d.check_correlation_id}</dd>
        </dl>
      )}
    </details>
  );
}
