// Reference data: what every check is measured against, and the two import flows the backend offers
// (POST /api/v1/kb/interactions/upload, POST /api/v1/kb/guidelines/upload, GET /api/v1/kb/templates).
import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { useI18n } from "../i18n";
import type { KbInfo } from "../types";
import { SeverityPill, Spinner, Tag } from "../components/Badges";
import Icon from "../components/Icon";

interface InteractionImport {
  kb_version: string;
  total_rows_parsed: number;
  added_interactions: number;
  updated_interactions: number;
  new_drugs_created: number;
  total_interactions_now: number;
  sample: { drug_a: string; drug_b: string; severity: string; status: string; notes?: string }[];
}

interface GuidelineImport {
  document_id: number;
  document_title: string;
  doc_type: string;
  chunks_created: number;
  drug_mentions_tagged: number;
  sample_chunks: { section: string; text_preview: string; drugs_tagged: string[] }[];
}

const DOC_TYPES = ["CLINICAL_GUIDELINE", "HOSPITAL_PROTOCOL", "FORMULARY", "GUIDELINE"];

function useTemplates() {
  const [tpl, setTpl] = useState<{ interactions_template: string; guidelines_template: string } | null>(null);
  useEffect(() => {
    api<{ interactions_template: string; guidelines_template: string }>("/api/v1/kb/templates").then(setTpl).catch(() => setTpl(null));
  }, []);
  return tpl;
}

function FileField({ label, accept, file, onFile }: { label: string; accept: string; file: File | null; onFile: (f: File | null) => void }) {
  const { t } = useI18n();
  return (
    <div className="field">
      <span>{label}</span>
      <div className="row">
        <label className="btn ghost file-btn">
          <Icon name="upload" size={16} /> {t("rx.upload")}
          <input type="file" accept={accept} onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
        </label>
        {file && (
          <span className="filechip">
            <Icon name="file" size={15} /> {file.name}
            <button type="button" className="icon-btn" onClick={() => onFile(null)} aria-label={t("rx.clearFile")}>
              <Icon name="x" size={14} />
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

function Caution() {
  const { t } = useI18n();
  return (
    <div className="caution" role="note">
      <Icon name="info" size={17} />
      <p>{t("data.caution")}</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>{typeof value === "number" ? value.toLocaleString("en-IN") : value}</dd>
    </div>
  );
}

function InteractionsForm({ template, onDone }: { template?: string; onDone: () => void }) {
  const { t } = useI18n();
  const [source, setSource] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [res, setRes] = useState<InteractionImport | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file && !text.trim()) return setErr(t("data.needInput"));
    setBusy(true);
    setErr("");
    setRes(null);
    try {
      let r: InteractionImport;
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("source", source.trim());
        r = await api<InteractionImport>("/api/v1/kb/interactions/upload", { form: fd });
      } else {
        r = await api<InteractionImport>("/api/v1/kb/interactions/upload", { body: { csv_text: text, source: source.trim() } });
      }
      setRes(r);
      onDone();
    } catch (ex) {
      setErr((ex as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="import" onSubmit={submit}>
      <Caution />
      <div className="import-grid">
        <label className="field">
          <span>{t("data.source")}</span>
          <input id="int-source" value={source} onChange={(e) => setSource(e.target.value)} placeholder="Hospital_Formulary_2026" autoComplete="off" />
          <small className="muted">{t("data.sourceHelp")}</small>
        </label>
        <FileField label={t("data.file")} accept=".csv,.txt,text/csv" file={file} onFile={setFile} />
      </div>
      <div className="field">
        <span className="field-head">
          {t("data.orPaste")}
          {template && (
            <button type="button" className="linkish sm" onClick={() => setText(template)}>
              {t("data.template")}
            </button>
          )}
        </span>
        <textarea id="int-csv" aria-label={t("data.orPaste")} rows={7} value={text} onChange={(e) => setText(e.target.value)} disabled={!!file} spellCheck={false} placeholder="drug_a,drug_b,severity,notes" />
        <small className="muted">{t("data.intColumns")}</small>
      </div>
      <div className="import-foot">
        {err && <p className="err-text" role="alert">{err}</p>}
        <button className="btn primary" disabled={busy}>
          <Icon name="upload" size={16} /> {busy ? t("data.importing") : t("data.importInt")}
        </button>
      </div>
      {res && (
        <section className="import-result" aria-live="polite">
          <h3>
            <Icon name="check" /> {t("data.intDone", { kb: res.kb_version })}
          </h3>
          <dl className="stats">
            <Stat label={t("data.rows")} value={res.total_rows_parsed} />
            <Stat label={t("data.added")} value={res.added_interactions} />
            <Stat label={t("data.updated")} value={res.updated_interactions} />
            <Stat label={t("data.newDrugs")} value={res.new_drugs_created} />
            <Stat label={t("data.total")} value={res.total_interactions_now} />
          </dl>
          {res.sample.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("rev.findings")}</th>
                    <th>{t("rev.dbRecord")}</th>
                    <th>{t("data.status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {res.sample.map((r, i) => (
                    <tr key={i}>
                      <td>
                        <b>{r.drug_a}</b> <span className="plus">+</span> <b>{r.drug_b}</b>
                        {r.notes && <div className="meta">{r.notes}</div>}
                      </td>
                      <td><SeverityPill s={r.severity} /></td>
                      <td className="meta">{r.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </form>
  );
}

function GuidelineForm({ template, onDone }: { template?: string; onDone: () => void }) {
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [docType, setDocType] = useState(DOC_TYPES[0]);
  const [source, setSource] = useState("");
  const [version, setVersion] = useState(new Date().toISOString().slice(0, 7).replace("-", "."));
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [res, setRes] = useState<GuidelineImport | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file && !text.trim()) return setErr(t("data.needInput"));
    setBusy(true);
    setErr("");
    setRes(null);
    try {
      const fields = { title: title.trim(), doc_type: docType, source: source.trim(), version: version.trim() };
      let r: GuidelineImport;
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
        r = await api<GuidelineImport>("/api/v1/kb/guidelines/upload", { form: fd });
      } else {
        r = await api<GuidelineImport>("/api/v1/kb/guidelines/upload", { body: { ...fields, csv_text: text } });
      }
      setRes(r);
      onDone();
    } catch (ex) {
      setErr((ex as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="import" onSubmit={submit}>
      <Caution />
      <div className="import-grid g4">
        <label className="field span2">
          <span>{t("data.docTitle")}</span>
          <input id="g-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Hospital Clinical Practice Protocol 2026" autoComplete="off" />
        </label>
        <label className="field">
          <span>{t("data.docType")}</span>
          <select id="g-type" value={docType} onChange={(e) => setDocType(e.target.value)}>
            {DOC_TYPES.map((d) => <option key={d} value={d}>{d.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase())}</option>)}
          </select>
        </label>
        <label className="field">
          <span>{t("data.version")}</span>
          <input id="g-version" value={version} onChange={(e) => setVersion(e.target.value)} autoComplete="off" />
        </label>
        <label className="field span2">
          <span>{t("data.source")}</span>
          <input id="g-source" value={source} onChange={(e) => setSource(e.target.value)} placeholder="Hospital_Pharmacy_Committee" autoComplete="off" />
        </label>
        <div className="span2">
          <FileField label={t("data.fileTxt")} accept=".csv,.txt,text/csv,text/plain" file={file} onFile={setFile} />
        </div>
      </div>
      <div className="field">
        <span className="field-head">
          {t("data.orPaste")}
          {template && (
            <button type="button" className="linkish sm" onClick={() => setText(template)}>
              {t("data.template")}
            </button>
          )}
        </span>
        <textarea id="g-text" aria-label={t("data.orPaste")} rows={7} value={text} onChange={(e) => setText(e.target.value)} disabled={!!file} placeholder="section,text,drugs" />
        <small className="muted">{t("data.guideColumns")}</small>
      </div>
      <div className="import-foot">
        {err && <p className="err-text" role="alert">{err}</p>}
        <button className="btn primary" disabled={busy}>
          <Icon name="upload" size={16} /> {busy ? t("data.importing") : t("data.importGuide")}
        </button>
      </div>
      {res && (
        <section className="import-result" aria-live="polite">
          <h3>
            <Icon name="check" /> {t("data.guideDone", { title: res.document_title })}
          </h3>
          <dl className="stats">
            <Stat label={t("data.chunks")} value={res.chunks_created} />
            <Stat label={t("data.mentions")} value={res.drug_mentions_tagged} />
          </dl>
          {res.sample_chunks.length > 0 && (
            <ul className="chunk-list">
              {res.sample_chunks.map((c, i) => (
                <li key={i}>
                  <div className="doc-title">{c.section}</div>
                  <p className="meta">{c.text_preview}</p>
                  {c.drugs_tagged.length > 0 && (
                    <div className="row">
                      {c.drugs_tagged.map((d) => <Tag key={d} tone="brand">{d}</Tag>)}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </form>
  );
}

export default function ReferenceData() {
  const { t } = useI18n();
  const [kb, setKb] = useState<KbInfo | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<"interactions" | "guidelines">("interactions");
  const tpl = useTemplates();
  const load = () => api<KbInfo>("/api/v1/kb").then(setKb).catch((e) => setErr(e.message));
  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="page page-data">
      <header className="page-head">
        <div>
          <h1>{t("data.title")}</h1>
          <p className="muted">{t("data.sub")}</p>
        </div>
        {kb?.kb_version && <Tag tone="brand">{t("data.kb", { v: kb.kb_version })}</Tag>}
      </header>

      {err && <p className="err-text">{err}</p>}
      {!kb && !err && <Spinner />}
      {kb?.counts && (
        <dl className="stats stats-lg">
          <Stat label={t("data.interactions")} value={kb.counts.interactions} />
          <Stat label={t("data.drugs")} value={kb.counts.drugs} />
          <Stat label={t("data.aliases")} value={kb.counts.aliases} />
          <Stat label={t("data.documents")} value={kb.counts.documents} />
        </dl>
      )}

      {!!kb?.sources?.length && (
        <section className="data-sec">
          <h2>{t("data.sources")}</h2>
          <ul className="sources">
            {kb.sources.map((s) => (
              <li key={`${s.name}-${s.version}`}>
                <div>
                  <b>{s.name}</b> <span className="meta">{s.version}</span> {s.is_synthetic && <Tag tone="warn">{t("data.synthetic")}</Tag>}
                  {s.notes && <div className="meta">{s.notes}</div>}
                </div>
                <div className="meta">{s.license}</div>
                {s.url ? (
                  <a href={s.url} target="_blank" rel="noreferrer" className="ext" aria-label={s.name}>
                    <Icon name="external" size={14} />
                  </a>
                ) : (
                  <span />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="data-sec data-import">
        <div className="tabs tabs-inline" role="tablist">
          <button role="tab" aria-selected={tab === "interactions"} className={tab === "interactions" ? "on" : ""} onClick={() => setTab("interactions")}>
            <Icon name="list" size={16} /> {t("data.tabInteractions")}
          </button>
          <button role="tab" aria-selected={tab === "guidelines"} className={tab === "guidelines" ? "on" : ""} onClick={() => setTab("guidelines")}>
            <Icon name="book" size={16} /> {t("data.tabGuidelines")}
          </button>
        </div>
        {tab === "interactions" ? (
          <InteractionsForm template={tpl?.interactions_template} onDone={() => void load()} />
        ) : (
          <GuidelineForm template={tpl?.guidelines_template} onDone={() => void load()} />
        )}
      </section>
    </div>
  );
}
