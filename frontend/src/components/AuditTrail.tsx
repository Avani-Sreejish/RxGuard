import { useEffect, useState } from "react";
import { api } from "../api";

interface Entry {
  seq: number;
  event_type: string;
  actor: string;
  entity: string;
  payload: unknown;
  kb_version: string;
  timestamp: string;
  correlation_id: string;
  prev_hash: string;
  hash: string;
}

export default function AuditTrail({ id, refreshKey }: { id: number; refreshKey: number }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [verify, setVerify] = useState<{ status: string; entries_checked: number; first_broken_seq?: number } | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    api(`/api/v1/audit/${id}?page_size=200`).then((r) => setEntries(r.entries));
    api(`/api/v1/audit/${id}/verify`).then(setVerify);
  }, [id, refreshKey]);

  return (
    <div className="card">
      <h2>
        <span className="step">7</span>Audit trail
        {verify && (
          <span className={`integrity ${verify.status}`} style={{ marginLeft: "auto" }}>
            {verify.status === "VALID"
              ? `Audit integrity ✓ (${verify.entries_checked} entries)`
              : `TAMPERED at seq ${verify.first_broken_seq}`}
          </span>
        )}
      </h2>
      <p className="small muted" style={{ marginTop: 0 }}>
        Hash chain per prescription: each entry stores SHA-256(previous hash + canonical JSON). Not a blockchain.
      </p>
      <table>
        <tbody>
          {entries.map((e) => (
            <tr key={e.seq} className="audit-row clickable" onClick={() => setOpen(open === e.seq ? null : e.seq)}>
              <td className="mono">{e.seq}</td>
              <td>
                <b>{e.event_type.replace(/_/g, " ")}</b> <span className="muted">· {e.actor} · KB {e.kb_version}</span>
                <div className="hash">{e.hash.slice(0, 20)}… ← {e.prev_hash.slice(0, 12)}…</div>
                {open === e.seq && <pre className="trace" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(e.payload, null, 1)}</pre>}
              </td>
              <td className="small muted">{new Date(e.timestamp).toLocaleTimeString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
