import { useEffect, useState } from "react";
import { api } from "../api";
import { useI18n } from "../i18n";
import type { AuditEntry } from "../types";
import { fmtDateTime, Spinner } from "./Badges";
import Icon from "./Icon";

export default function AuditPanel({ rxId, version }: { rxId: number; version: number }) {
  const { t, lang } = useI18n();
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [verify, setVerify] = useState<{ status: string; entries_checked: number; first_broken_seq?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    setVerify(null);
    api<{ entries: AuditEntry[] }>(`/api/v1/audit/${rxId}?page_size=200`)
      .then((r) => setRows(r.entries))
      .catch((e) => setErr(e.message));
  }, [rxId, version]);

  const runVerify = async () => {
    setBusy(true);
    try {
      setVerify(await api(`/api/v1/audit/${rxId}/verify`));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="audit">
      <p className="muted small">{t("audit.help")}</p>
      <div className="row">
        <button type="button" className="btn ghost sm" onClick={runVerify} disabled={busy}>
          <Icon name="link" size={15} /> {t("audit.verify")}
        </button>
        {verify && (
          <span className={verify.status === "VALID" ? "ok-text" : "err-text"} role="status">
            {verify.status === "VALID" ? t("audit.valid", { n: verify.entries_checked }) : t("audit.tampered", { seq: verify.first_broken_seq ?? "?" })}
          </span>
        )}
      </div>
      {err && <p className="err-text">{err}</p>}
      {!rows && !err && <Spinner />}
      {rows && (
        <ol className="audit-list">
          {rows.map((r) => (
            <li key={r.seq}>
              <span className="seq">{r.seq}</span>
              <div>
                <div className="audit-ev">{t(`audit.${r.event_type}`) === `audit.${r.event_type}` ? r.event_type : t(`audit.${r.event_type}`)}</div>
                <div className="meta">
                  {fmtDateTime(r.timestamp, lang)} · {r.actor} · KB {r.kb_version}
                  {typeof r.payload?.action === "string" && <> · {t(`done.${r.payload.action}`)}</>}
                </div>
                <div className="hash" title={r.hash}>
                  {r.hash.slice(0, 16)}…
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
