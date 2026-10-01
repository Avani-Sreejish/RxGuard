import { useEffect, useState } from "react";
import { api } from "../api";
import { Prio } from "../components/Badges";
import type { Priority } from "../types";

interface Row {
  id: number;
  status: string;
  priority: Priority;
  created_at: string;
  interaction_count: number;
  unresolved_count: number;
  escalation_count: number;
  reviewed_count: number;
  injection_flag: boolean;
  kb_version: string;
  first_line: string;
}

export default function Queue({ open }: { open: (id: number) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api<{ results: Row[] }>("/api/v1/prescriptions")
      .then((r) => setRows(r.results))
      .catch((e) => setErr(String(e.message)));
  }, []);
  return (
    <>
      <div className="row spread" style={{ marginBottom: 14 }}>
        <div>
          <h1>Review queue</h1>
          <div className="sub">Open prescriptions first, then by priority. Priority is a queue-ordering label, not a clinical risk score.</div>
        </div>
        <button className="btn primary" onClick={() => (window.location.hash = "/new")}>
          New check
        </button>
      </div>
      {err && <div className="error">{err}</div>}
      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Priority</th>
              <th>Status</th>
              <th>Interactions</th>
              <th>Unresolved</th>
              <th>Escalations</th>
              <th>Reviewed</th>
              <th>KB</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => open(r.id)}>
                <td className="mono">#{r.id}</td>
                <td>
                  <Prio p={r.priority} />
                </td>
                <td>
                  {r.status.replace(/_/g, " ").toLowerCase()}
                  {r.injection_flag && <span className="badge esc" style={{ marginLeft: 6 }}>INJECTION</span>}
                </td>
                <td>{r.interaction_count}</td>
                <td>{r.unresolved_count ? <b style={{ color: "var(--insuff)" }}>{r.unresolved_count}</b> : 0}</td>
                <td>{r.escalation_count}</td>
                <td>
                  {r.reviewed_count}/{r.interaction_count}
                </td>
                <td className="mono">{r.kb_version}</td>
                <td className="small muted">{new Date(r.created_at).toLocaleString()}</td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr>
                <td colSpan={9} className="muted" style={{ padding: 24, textAlign: "center" }}>
                  No prescriptions yet. Start a new check or load the demo prescription.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {!rows && !err && (
          <div style={{ padding: 20 }}>
            <span className="spin" /> Loading…
          </div>
        )}
      </div>
    </>
  );
}
