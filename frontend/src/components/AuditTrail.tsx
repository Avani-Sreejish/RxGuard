import { useEffect, useState } from "react";
import { api } from "../api";
import Icon from "./Icon";

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
    <div className="card audit">
      <h2>
        Audit trail
        {verify && (
          <span className={`integrity ${verify.status}`} style={{ marginLeft: "auto" }} role="status">
            {verify.status === "VALID" ? (
              <><Icon name="check" size={14} /> Chain intact · {verify.entries_checked} entries</>
            ) : (
              <><Icon name="alert" size={14} /> TAMPERED at seq {verify.first_broken_seq}</>
            )}
          </span>
        )}
      </h2>
      <p className="meta">
        Hash chain per prescription: each entry stores SHA-256(previous hash + canonical JSON). Not a blockchain.
      </p>
      <ol className="audit-list">
        {entries.map((e) => (
          <li key={e.seq} className="cursor-pointer" onClick={() => setOpen(open === e.seq ? null : e.seq)}>
            <span className="seq">{e.seq}</span>
            <div>
              <div className="audit-ev">{e.event_type.replace(/_/g, " ").toLowerCase()}</div>
              <div className="meta">
                {new Date(e.timestamp).toLocaleTimeString()} · {e.actor} · KB {e.kb_version}
              </div>
              <div className="hash" title={e.hash}>{e.hash.slice(0, 20)}… ← {e.prev_hash.slice(0, 12)}…</div>
              {open === e.seq && <pre className="trace" style={{ marginTop: 6 }}>{JSON.stringify(e.payload, null, 1)}</pre>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
