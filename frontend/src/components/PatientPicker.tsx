import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { addPatient, ageBand, listPatients, subscribe, type Patient, type Sex } from "../patients";
import Icon from "./Icon";

export function usePatients(): Patient[] {
  const [list, setList] = useState(listPatients);
  useEffect(() => {
    const off = subscribe(() => setList(listPatients()));
    return () => {
      off();
    };
  }, []);
  return list;
}

export function PatientLine({ p }: { p: Patient }) {
  const { t } = useI18n();
  return (
    <span className="pline">
      <span className="pline-name">{p.name}</span>
      <span className="pline-meta">
        {t("patient.years", { n: p.age })}, {t(`patient.${p.sex}`)}
        {p.uhid && <> · {p.uhid}</>}
      </span>
    </span>
  );
}

export function PatientForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: Partial<Patient>;
  submitLabel: string;
  onSubmit: (v: { name: string; age: number; sex: Sex; uhid: string }) => void;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [name, setName] = useState(initial?.name ?? "");
  const [age, setAge] = useState(initial?.age !== undefined ? String(initial.age) : "");
  const [sex, setSex] = useState<Sex>(initial?.sex ?? "Female");
  const [uhid, setUhid] = useState(initial?.uhid ?? "");
  const [err, setErr] = useState("");
  const n = Number(age);
  return (
    <form
      className="pform"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || age === "" || !Number.isFinite(n) || n < 0 || n > 120) return setErr(t("patient.invalid"));
        onSubmit({ name: name.trim(), age: Math.floor(n), sex, uhid: uhid.trim() });
      }}
    >
      <label className="field f-name">
        <span>{t("patient.name")}</span>
        <input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="off" />
      </label>
      <label className="field f-age">
        <span>{t("patient.age")}</span>
        <input id={`${id}-age`} type="number" inputMode="numeric" min={0} max={120} value={age} onChange={(e) => setAge(e.target.value)} />
      </label>
      <label className="field f-sex">
        <span>{t("patient.sex")}</span>
        <select id={`${id}-sex`} value={sex} onChange={(e) => setSex(e.target.value as Sex)}>
          {(["Female", "Male", "Other"] as Sex[]).map((s) => (
            <option key={s} value={s}>{t(`patient.${s}`)}</option>
          ))}
        </select>
      </label>
      <label className="field f-uhid">
        <span>{t("patient.uhid")}</span>
        <input id={`${id}-uhid`} value={uhid} onChange={(e) => setUhid(e.target.value)} autoComplete="off" />
      </label>
      <div className="pform-foot">
        {err ? (
          <span className="err-text" role="alert">{err}</span>
        ) : (
          <span className="hint">{age !== "" && Number.isFinite(n) ? t("patient.ageBand", { band: ageBand(n) }) : ""}</span>
        )}
        <div className="row">
          {onCancel && <button type="button" className="btn ghost" onClick={onCancel}>{t("common.cancel")}</button>}
          <button type="submit" className="btn primary">{submitLabel}</button>
        </div>
      </div>
    </form>
  );
}

/** Patient dropdown with search, plus inline "new patient" form. */
export default function PatientPicker({ value, onChange }: { value: Patient | undefined; onChange: (p: Patient | undefined) => void }) {
  const { t } = useI18n();
  const patients = usePatients();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const term = q.trim().toLowerCase();
  const shown = patients.filter((p) => !term || p.name.toLowerCase().includes(term) || p.uhid.toLowerCase().includes(term));

  if (adding)
    return (
      <div className="ppicker adding">
        <PatientForm
          submitLabel={t("patient.add")}
          onCancel={() => setAdding(false)}
          onSubmit={(v) => {
            const p = addPatient(v);
            onChange(p);
            setAdding(false);
          }}
        />
      </div>
    );

  return (
    <div className="ppicker" ref={box}>
      <button
        type="button"
        className={`ppicker-trigger ${value ? "has" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="user" />
        {value ? <PatientLine p={value} /> : <span className="placeholder">{t("patient.select")}</span>}
        {value && (
          <span className="pchecks">{value.checks.length ? t("patient.checks", { n: value.checks.length }) : t("patient.noChecks")}</span>
        )}
        <Icon name="chevron" className="chev" />
      </button>
      <button type="button" className="btn ghost" onClick={() => setAdding(true)}>
        <Icon name="plus" size={16} /> {t("patient.new")}
      </button>
      {open && (
        <div className="ppicker-pop">
          <div className="combo-field small">
            <Icon name="search" size={16} />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("patient.search")} aria-label={t("patient.search")} />
          </div>
          <ul role="listbox" id={listId}>
            {shown.map((p) => (
              <li key={p.id} role="option" aria-selected={value?.id === p.id}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(p);
                    setOpen(false);
                    setQ("");
                  }}
                >
                  <PatientLine p={p} />
                  {value?.id === p.id && <Icon name="check" size={16} />}
                </button>
              </li>
            ))}
            {shown.length === 0 && (
              <li className="opt-empty">{patients.length ? t("patient.noMatch", { q }) : t("patient.none")}</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
