import { useState } from "react";
import { useI18n } from "../i18n";
import { getPatient, lastSeen, updatePatient } from "../patients";
import { fmtDate, fmtDateTime, PriorityPill } from "../components/Badges";
import Icon from "../components/Icon";
import { PatientForm, PatientLine, usePatients } from "../components/PatientPicker";
import { Link, navigate } from "../router";

export default function Patients({ id }: { id?: string }) {
  const { t, lang } = useI18n();
  const patients = usePatients();
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState(false);
  const sel = getPatient(id) ?? undefined;
  const term = q.trim().toLowerCase();
  const shown = patients.filter((p) => !term || p.name.toLowerCase().includes(term) || p.uhid.toLowerCase().includes(term));

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t("patients.title")}</h1>
      </header>
      <div className="split">
        <aside className="plist" aria-label={t("patients.title")}>
          <div className="combo-field small">
            <Icon name="search" size={16} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("patient.search")} aria-label={t("patient.search")} />
          </div>
          <ul>
            {shown.map((p) => (
              <li key={p.id}>
                <Link to={`/patients/${p.id}`} className={sel?.id === p.id ? "on" : ""} aria-current={sel?.id === p.id ? "true" : undefined}>
                  <PatientLine p={p} />
                  <span className="meta">{p.checks.length ? t("patients.lastSeen", { date: fmtDate(lastSeen(p), lang) }) : t("patient.noChecks")}</span>
                </Link>
              </li>
            ))}
            {shown.length === 0 && <li className="opt-empty">{patients.length ? t("patient.noMatch", { q }) : t("patient.none")}</li>}
          </ul>
        </aside>

        <section className="pdetail">
          {!sel ? (
            <div className="panel-empty">
              <Icon name="users" size={28} />
              <p>{t("patients.select")}</p>
            </div>
          ) : (
            <>
              <header className="pdetail-head">
                <div>
                  <h2>{sel.name}</h2>
                  <p className="meta">
                    {t("patient.years", { n: sel.age })}, {t(`patient.${sel.sex}`)}
                    {sel.uhid && <> · {sel.uhid}</>}
                  </p>
                </div>
                <div className="row">
                  <button className="btn ghost" onClick={() => setEditing((e) => !e)}>
                    {t("patients.edit")}
                  </button>
                  <button className="btn primary" onClick={() => navigate(`/check?patient=${sel.id}`)}>
                    <Icon name="plus" size={16} /> {t("patients.newCheck", { name: sel.name.split(" ")[0] })}
                  </button>
                </div>
              </header>
              {editing && (
                <PatientForm
                  key={sel.id}
                  initial={sel}
                  submitLabel={t("patients.save")}
                  onCancel={() => setEditing(false)}
                  onSubmit={(v) => {
                    updatePatient(sel.id, v);
                    setEditing(false);
                  }}
                />
              )}
              <h3 className="sub-h">{t("patients.history")}</h3>
              {sel.checks.length === 0 ? (
                <p className="empty">{t("patient.noChecks")}</p>
              ) : (
                <ol className="timeline">
                  {[...sel.checks].reverse().map((c) => (
                    <li key={c.rxId}>
                      <Link to={`/rx/${c.rxId}`} className="tl-item">
                        <span className="tl-date">{fmtDateTime(c.createdAt, lang)}</span>
                        <span className="tl-body">
                          <span className="tl-title">
                            {t("rev.rx", { id: c.rxId })} {c.priority && <PriorityPill p={c.priority as any} />}
                          </span>
                          <span className="tl-meds">{c.medicines.length ? c.medicines.join(" · ") : "—"}</span>
                        </span>
                        <Icon name="chevronRight" size={16} />
                      </Link>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
