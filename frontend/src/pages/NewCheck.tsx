import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { useI18n } from "../i18n";
import { ageBand, getPatient, linkCheck, type Patient } from "../patients";
import type { DrugHit, Prescription } from "../types";
import DrugSearch from "../components/DrugSearch";
import Icon, { RxMark } from "../components/Icon";
import PatientPicker from "../components/PatientPicker";
import { fmtDate } from "../components/Badges";
import { navigate } from "../router";

interface Line {
  key: number;
  name: string;
  form: string;
  strength: string;
  freq: string;
  duration: string;
  nlem: boolean | null;
}

const FORMS = ["Tab", "Cap", "Syp", "Inj", "Susp", "Drops", "Oint"];
const FREQS = ["OD", "BD", "TDS", "QID", "HS", "SOS", "STAT", "once weekly"];
let keySeq = 1;

function toText(lines: Line[]) {
  return [
    "Rx",
    ...lines.map((l, i) =>
      [`${i + 1}.`, l.form, l.name, l.strength.trim(), l.freq, l.duration.trim() ? `x ${l.duration.trim()}` : ""].filter(Boolean).join(" "),
    ),
  ].join("\n");
}

export default function NewCheck({ patientId }: { patientId?: string }) {
  const { t, lang } = useI18n();
  const [patient, setPatient] = useState<Patient | undefined>(() => getPatient(patientId));
  const [mode, setMode] = useState<"build" | "paste">("build");
  const [lines, setLines] = useState<Line[]>([]);
  const [paste, setPaste] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (patientId) setPatient(getPatient(patientId));
  }, [patientId]);

  const add = (name: string, hit: DrugHit | null) => {
    setLines((ls) => [...ls, { key: keySeq++, name, form: "Tab", strength: "", freq: "OD", duration: "", nlem: hit?.nlem_listed ?? null }]);
    setErr("");
  };
  const patch = (key: number, p: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const remove = (key: number) => setLines((ls) => ls.filter((l) => l.key !== key));

  const last = patient?.checks.length ? patient.checks[patient.checks.length - 1] : undefined;
  const prev = (last?.medicines ?? []).filter((m) => !lines.some((l) => l.name.toLowerCase() === m.toLowerCase()));

  const hasMeds = mode === "build" ? lines.length > 0 : !!file || paste.trim().length > 0;

  const submit = async () => {
    if (!patient) return setErr(t("rx.needPatient"));
    if (!hasMeds) return setErr(t("rx.needMed"));
    setBusy(true);
    setErr("");
    const band = ageBand(patient.age);
    try {
      let rx: Prescription;
      if (mode === "paste" && file) {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("age_band", band);
        fd.append("note", note);
        rx = await api<Prescription>("/api/v1/check", { form: fd });
      } else {
        rx = await api<Prescription>("/api/v1/check", { body: { text: mode === "build" ? toText(lines) : paste, age_band: band, note } });
      }
      linkCheck(patient.id, {
        rxId: rx.id,
        createdAt: rx.created_at,
        priority: rx.priority,
        medicines: [...new Set(rx.items.filter((i) => i.drug).map((i) => i.drug as string))],
      });
      navigate(`/rx/${rx.id}`);
    } catch (e) {
      const ae = e as ApiError;
      setErr(ae.message + (ae.correlationId ? ` (ref ${ae.correlationId.slice(0, 8)})` : ""));
      setBusy(false);
    }
  };

  return (
    <div className="page page-check">
      <section className="patient-bar" aria-label={t("patient.label")}>
        <span className="section-label">{t("patient.label")}</span>
        <PatientPicker value={patient} onChange={setPatient} />
      </section>

      <section className="rxpad" aria-labelledby="rx-h">
        <header className="rxpad-head">
          <RxMark size={40} />
          <div>
            <h1 id="rx-h">{t("rx.title")}</h1>
            <p className="muted">{fmtDate(new Date().toISOString(), lang)}</p>
          </div>
          <div className="seg" role="tablist" aria-label={t("rx.title")}>
            <button role="tab" aria-selected={mode === "build"} className={mode === "build" ? "on" : ""} onClick={() => setMode("build")}>
              {t("rx.modeBuild")}
            </button>
            <button role="tab" aria-selected={mode === "paste"} className={mode === "paste" ? "on" : ""} onClick={() => setMode("paste")}>
              {t("rx.modePaste")}
            </button>
          </div>
        </header>

        {mode === "build" ? (
          <>
            <DrugSearch onPick={add} autoFocus={!!patient} />
            {prev.length > 0 && last && (
              <div className="prevmeds">
                <span className="muted">{t("rx.previous", { date: fmtDate(last.createdAt, lang) })}</span>
                {prev.map((m) => (
                  <button key={m} type="button" className="chip" onClick={() => add(m, null)}>
                    <Icon name="plus" size={14} /> {m}
                  </button>
                ))}
                {prev.length > 1 && (
                  <button type="button" className="linkish" onClick={() => prev.forEach((m) => add(m, null))}>
                    {t("rx.addAll")}
                  </button>
                )}
              </div>
            )}
            {lines.length === 0 ? (
              <p className="rx-empty">{t("rx.empty")}</p>
            ) : (
              <ol className="rx-lines">
                {lines.map((l, i) => (
                  <li key={l.key} className="rx-line">
                    <span className="rx-no">{i + 1}</span>
                    <select aria-label={t("rx.form")} value={l.form} onChange={(e) => patch(l.key, { form: e.target.value })} className="rx-form">
                      {FORMS.map((f) => <option key={f}>{f}</option>)}
                    </select>
                    <span className="rx-name">
                      {l.name}
                      {l.nlem && <span className="tag tag-brand">{t("rx.nlem")}</span>}
                    </span>
                    <input aria-label={t("rx.strength")} placeholder={t("rx.strength")} value={l.strength} onChange={(e) => patch(l.key, { strength: e.target.value })} className="rx-strength" />
                    <select aria-label={t("rx.freq")} value={l.freq} onChange={(e) => patch(l.key, { freq: e.target.value })} className="rx-freq">
                      {FREQS.map((f) => <option key={f}>{f}</option>)}
                    </select>
                    <input aria-label={t("rx.duration")} placeholder={t("rx.duration")} value={l.duration} onChange={(e) => patch(l.key, { duration: e.target.value })} className="rx-dur" />
                    <button type="button" className="icon-btn" onClick={() => remove(l.key)} aria-label={t("rx.remove", { name: l.name })}>
                      <Icon name="x" size={16} />
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </>
        ) : (
          <div className="paste">
            <p className="muted">{t("rx.pasteHelp")}</p>
            <textarea
              id="rx-paste"
              rows={8}
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder={t("rx.pastePh")}
              disabled={!!file}
              aria-label={t("rx.modePaste")}
            />
            <div className="row">
              <label className="btn ghost file-btn">
                <Icon name="upload" size={16} /> {t("rx.upload")}
                <input type="file" accept=".txt,.pdf,text/plain,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </label>
              {file && (
                <span className="filechip">
                  <Icon name="file" size={15} /> {t("rx.fileChosen", { name: file.name })}
                  <button type="button" className="icon-btn" onClick={() => setFile(null)} aria-label={t("rx.clearFile")}>
                    <Icon name="x" size={14} />
                  </button>
                </span>
              )}
            </div>
          </div>
        )}

        <label className="field note-field">
          <span>
            {t("rx.note")} <em>({t("rx.optional")})</em>
          </span>
          <textarea id="rx-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("rx.notePh")} maxLength={2000} />
          <small className="muted">{t("rx.noteHelp")}</small>
        </label>

        <footer className="rxpad-foot">
          {err && <p className="err-text" role="alert">{err}</p>}
          <span className="muted">{mode === "build" && lines.length > 0 && t("rx.count", { n: lines.length })}</span>
          <button className="btn primary btn-lg" onClick={submit} disabled={busy}>
            <Icon name="shield" /> {busy ? t("rx.checking") : t("rx.check")}
          </button>
        </footer>
      </section>
    </div>
  );
}
