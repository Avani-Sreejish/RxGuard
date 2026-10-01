import { useEffect, useState } from "react";
import { api } from "../api";
import { useI18n } from "../i18n";
import { patientForRx } from "../patients";
import type { QueueRow } from "../types";
import { fmtDateTime, PriorityPill, Spinner, StatusText } from "../components/Badges";
import { usePatients } from "../components/PatientPicker";
import { navigate } from "../router";

const OPEN = new Set(["AWAITING_PHARMACIST", "IN_REVIEW", "CHECKED", "EXPLAINED"]);

export default function Queue() {
  const { t, lang } = useI18n();
  usePatients(); // re-render when patient links change
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState<"open" | "all">("open");

  useEffect(() => {
    api<{ results: QueueRow[] }>("/api/v1/prescriptions").then((r) => setRows(r.results)).catch((e) => setErr(e.message));
  }, []);

  const shown = (rows ?? []).filter((r) => filter === "all" || OPEN.has(r.status));
  const openCount = (rows ?? []).filter((r) => OPEN.has(r.status)).length;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t("queue.title")}</h1>
          <p className="muted">{t("queue.sub")}</p>
        </div>
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={filter === "open"} className={filter === "open" ? "on" : ""} onClick={() => setFilter("open")}>
            {t("queue.open")} <span className="count">{openCount}</span>
          </button>
          <button role="tab" aria-selected={filter === "all"} className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>
            {t("queue.all")} <span className="count">{rows?.length ?? 0}</span>
          </button>
        </div>
      </header>
      {err && <p className="err-text">{err}</p>}
      {!rows && !err && <Spinner />}
      {rows && shown.length === 0 && <p className="empty">{t("queue.empty")}</p>}
      {shown.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t("queue.colPriority")}</th>
                <th>{t("queue.colPatient")}</th>
                <th>{t("queue.colRx")}</th>
                <th className="num">{t("queue.colFindings")}</th>
                <th>{t("queue.colStatus")}</th>
                <th>{t("queue.colTime")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const p = patientForRx(r.id);
                const meds = p?.checks.find((c) => c.rxId === r.id)?.medicines.join(", ") || (/^rx\.?$/i.test(r.first_line.trim()) ? "" : r.first_line);
                return (
                  <tr key={r.id} className={`prio-row-${r.priority}`} tabIndex={0} onClick={() => navigate(`/rx/${r.id}`)} onKeyDown={(e) => e.key === "Enter" && navigate(`/rx/${r.id}`)}>
                    <td><PriorityPill p={r.priority} /></td>
                    <td>
                      {p ? (
                        <>
                          <b>{p.name}</b>
                          <div className="meta">{t("patient.years", { n: p.age })}, {t(`patient.${p.sex}`)}</div>
                        </>
                      ) : (
                        <span className="muted">{t("queue.unlinked")}</span>
                      )}
                    </td>
                    <td>
                      <span className="code">#{r.id}</span>
                      {meds && <div className="meta clamp">{meds}</div>}
                      {r.unresolved_count > 0 && <div className="warn-text meta">{t("queue.unresolved", { n: r.unresolved_count })}</div>}
                    </td>
                    <td className="num">
                      {r.interaction_count}
                      {r.interaction_count > 0 && <div className="meta">{r.reviewed_count} ✓</div>}
                    </td>
                    <td><StatusText s={r.status} /></td>
                    <td className="meta">{fmtDateTime(r.created_at, lang)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
