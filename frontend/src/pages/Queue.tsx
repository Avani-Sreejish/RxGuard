import { useEffect, useState } from "react";
import { api } from "../api";
import { Spinner } from "../components/Badges";
import { PRIORITY_LABEL } from "./Detail";
import Icon from "../components/Icon";
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
  medicines: string[];
}

export default function Queue({ open }: { open: (id: number) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState("");
  const [search, setSearch] = useState("");
  const [prioFilter, setPrioFilter] = useState<string>("ALL");
  const [limit, setLimit] = useState(30);

  useEffect(() => {
    api<{ results: Row[] }>("/api/v1/prescriptions")
      .then((r) => setRows(r.results))
      .catch((e) => setErr(String(e.message)));
  }, []);

  const filtered = rows?.filter((r) => {
    const matchesSearch =
      search === "" ||
      `#${r.id}`.includes(search) ||
      r.medicines.some((m) => m.toLowerCase().includes(search.toLowerCase())) ||
      r.status.toLowerCase().includes(search.toLowerCase());
    const matchesPrio = prioFilter === "ALL" || r.priority === prioFilter;
    return matchesSearch && matchesPrio;
  });

  const p1Count = rows?.filter((r) => r.priority === "P1").length ?? 0;
  const pendingCount = rows?.filter((r) => r.status !== "COMPLETED" && r.status !== "REVIEWED").length ?? 0;
  const countFor = (p: string) => (p === "ALL" ? rows?.length ?? 0 : rows?.filter((r) => r.priority === p).length ?? 0);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Review queue</h1>
          <p className="muted">Prescriptions waiting for review, most urgent first.</p>
        </div>
        <a className="btn primary" href="#/new">
          <Icon name="plus" size={17} /> New check
        </a>
      </header>

      <div className="stats" style={{ marginBottom: 18 }}>
        <div className="stat">
          <div className="v" style={{ color: p1Count > 0 ? "var(--major)" : undefined }}>{p1Count}</div>
          <div className="l">Need action now</div>
        </div>
        <div className="stat">
          <div className="v">{pendingCount}</div>
          <div className="l">Waiting for review</div>
        </div>
        <div className="stat">
          <div className="v">{rows ? rows.length : "—"}</div>
          <div className="l">All prescriptions</div>
        </div>
      </div>

      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="row spread" style={{ marginBottom: 12 }}>
        <label className="combo-search">
          <Icon name="search" size={17} />
          <input
            type="text"
            placeholder="Search by prescription number or medicine"
            aria-label="Search the queue"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="seg" role="tablist" aria-label="Filter by priority">
          {["ALL", "P1", "P2", "P3", "CLEAR"].map((p) => (
            <button key={p} role="tab" aria-selected={prioFilter === p} className={prioFilter === p ? "on" : ""}
              onClick={() => { setPrioFilter(p); setLimit(30); }}>
              {p === "ALL" ? "All" : PRIORITY_LABEL[p].replace("No interactions recorded", "Clear")} <span className="count">{countFor(p)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Priority</th>
              <th>Prescription</th>
              <th className="num">Interactions</th>
              <th>Your review</th>
              <th>Checked</th>
            </tr>
          </thead>
          <tbody>
            {filtered?.slice(0, limit).map((r) => {
              const done = r.status === "COMPLETED" || r.status === "REVIEWED";
              return (
                <tr key={r.id} tabIndex={0} className={`prio-row-${r.priority}`} onClick={() => open(r.id)}
                  onKeyDown={(e) => e.key === "Enter" && open(r.id)}>
                  <td><span className={`pill prio-${r.priority}`}>{PRIORITY_LABEL[r.priority]}</span></td>
                  <td style={{ maxWidth: 320 }}>
                    <b>#{r.id}</b>
                    <div className="queue-meds clamp">{r.medicines.join(", ") || "No recognised medicines"}</div>
                    {r.injection_flag && <span className="badge esc">Suspicious text in prescription</span>}
                  </td>
                  <td className="num">{r.interaction_count || <span className="muted">0</span>}</td>
                  <td>
                    {done ? (
                      <span className="status done"><span className="dot" aria-hidden />Completed</span>
                    ) : r.unresolved_count ? (
                      <span className="warn-text small">{r.unresolved_count} medicine(s) to confirm</span>
                    ) : (
                      <span className="status open"><span className="dot" aria-hidden />
                        {r.interaction_count ? `${r.reviewed_count} of ${r.interaction_count} reviewed` : "Not started"}
                      </span>
                    )}
                  </td>
                  <td className="meta" style={{ whiteSpace: "nowrap" }}>
                    {new Date(r.created_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  </td>
                </tr>
              );
            })}
            {filtered && filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="muted" style={{ padding: 30, textAlign: "center" }}>
                  No prescriptions match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {filtered && filtered.length > limit && (
          <div style={{ padding: 12, textAlign: "center", borderTop: "1px solid var(--line-2)" }}>
            <button className="btn sm" onClick={() => setLimit((l) => l + 30)}>
              Show more ({filtered.length - limit} left)
            </button>
          </div>
        )}
        {!rows && !err && (
          <div className="page-loading" style={{ justifyContent: "center" }}>
            <Spinner /> Loading prescriptions…
          </div>
        )}
      </div>
    </>
  );
}
