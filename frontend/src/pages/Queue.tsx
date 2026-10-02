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
  const [search, setSearch] = useState("");
  const [prioFilter, setPrioFilter] = useState<string>("ALL");

  useEffect(() => {
    api<{ results: Row[] }>("/api/v1/prescriptions")
      .then((r) => setRows(r.results))
      .catch((e) => setErr(String(e.message)));
  }, []);

  const filtered = rows?.filter((r) => {
    const matchesSearch =
      search === "" ||
      `#${r.id}`.includes(search) ||
      r.first_line?.toLowerCase().includes(search.toLowerCase()) ||
      r.status.toLowerCase().includes(search.toLowerCase());
    const matchesPrio = prioFilter === "ALL" || r.priority === prioFilter;
    return matchesSearch && matchesPrio;
  });

  const p1Count = rows?.filter((r) => r.priority === "P1").length ?? 0;
  const pendingCount = rows?.filter((r) => r.status !== "COMPLETED").length ?? 0;

  return (
    <>
      <div className="row spread" style={{ marginBottom: 16 }}>
        <div>
          <h1>Prescription Review Queue</h1>
          <div className="sub">
            Triaged by deterministic safety rules R1–R9. Hospital & retail pharmacist decision support.
          </div>
        </div>
        <button className="btn primary" onClick={() => (window.location.hash = "/new")}>
          + New Check
        </button>
      </div>

      {/* Metric Stats Bar */}
      <div className="stats" style={{ marginBottom: 18 }}>
        <div className="stat card">
          <div className="v" style={{ color: p1Count > 0 ? "var(--p1)" : "var(--text)" }}>
            {p1Count}
          </div>
          <div className="l">P1 Critical Prescriptions</div>
        </div>
        <div className="stat card">
          <div className="v" style={{ color: "var(--accent)" }}>
            {pendingCount}
          </div>
          <div className="l">Pending Pharmacist Review</div>
        </div>
        <div className="stat card">
          <div className="v" style={{ color: "var(--clear)" }}>
            {rows ? rows.length : "—"}
          </div>
          <div className="l">Total Checked in Queue</div>
        </div>
      </div>

      {err && <div className="error">{err}</div>}

      {/* Search & Filters Toolbar */}
      <div className="card" style={{ marginBottom: 14, padding: "12px 16px" }}>
        <div className="row spread">
          <div className="row" style={{ flex: 1, minWidth: 260 }}>
            <input
              type="text"
              placeholder="Search by Rx ID, drug name or status..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ maxWidth: 360 }}
            />
          </div>
          <div className="row" style={{ gap: 6 }}>
            <span className="small muted" style={{ fontWeight: 600 }}>
              Filter:
            </span>
            {["ALL", "P1", "P2", "P3", "CLEAR"].map((p) => (
              <button
                key={p}
                className={`btn sm ${prioFilter === p ? "primary" : ""}`}
                onClick={() => setPrioFilter(p)}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Queue Table */}
      <div className="card elevated" style={{ padding: 0, overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Priority</th>
              <th>Status</th>
              <th>First Medication</th>
              <th>Interactions</th>
              <th>Unresolved</th>
              <th>Reviewed</th>
              <th>KB</th>
              <th>Checked At</th>
            </tr>
          </thead>
          <tbody>
            {filtered?.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => open(r.id)}>
                <td className="mono" style={{ fontWeight: 700, color: "var(--accent)" }}>
                  #{r.id}
                </td>
                <td>
                  <Prio p={r.priority} />
                </td>
                <td>
                  <span style={{ fontWeight: 600 }}>{r.status.replace(/_/g, " ").toLowerCase()}</span>
                  {r.injection_flag && (
                    <span className="badge esc" style={{ marginLeft: 6 }}>
                      INJECTION
                    </span>
                  )}
                </td>
                <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.first_line || "—"}
                </td>
                <td>
                  {r.interaction_count > 0 ? (
                    <span style={{ fontWeight: 700 }}>{r.interaction_count}</span>
                  ) : (
                    <span className="muted">0</span>
                  )}
                </td>
                <td>
                  {r.unresolved_count ? (
                    <span className="badge unres">
                      {r.unresolved_count} unresolved
                    </span>
                  ) : (
                    <span className="muted">0</span>
                  )}
                </td>
                <td>
                  <span style={{ fontWeight: 600 }}>
                    {r.reviewed_count}/{r.interaction_count}
                  </span>
                </td>
                <td className="mono small">{r.kb_version}</td>
                <td className="small muted">{new Date(r.created_at).toLocaleString()}</td>
              </tr>
            ))}
            {filtered && filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="muted" style={{ padding: 30, textAlign: "center" }}>
                  No prescriptions match the filter criteria.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {!rows && !err && (
          <div style={{ padding: 24, textAlign: "center" }}>
            <span className="spin" /> Loading prescriptions...
          </div>
        )}
      </div>
    </>
  );
}
