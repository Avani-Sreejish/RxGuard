import { useEffect, useState } from "react";
import { api } from "../api";
import { Spinner, Synthetic } from "../components/Badges";

export default function Sources() {
  const [kb, setKb] = useState<any>(null);
  useEffect(() => {
    api("/api/v1/kb").then(setKb);
  }, []);
  if (!kb) return <div className="page-loading"><Spinner /> Loading sources…</div>;
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Sources and licences</h1>
          <p className="muted">
        Current knowledge-base version <b>{kb.kb_version}</b> · {kb.counts?.drugs} drugs · {kb.counts?.interactions}{" "}
        interaction rows · {kb.counts?.aliases} aliases · {kb.counts?.documents} corpus documents
          </p>
        </div>
      </header>
      <div className="card" style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr><th>Source</th><th>Version</th><th>Licence (as recorded)</th><th>Checksum</th></tr>
          </thead>
          <tbody>
            {kb.sources.map((s: any) => (
              <tr key={s.name}>
                <td>
                  <b>{s.name}</b> {s.is_synthetic && <Synthetic />}
                  {s.url && <div className="small"><a href={s.url} target="_blank" rel="noreferrer">{s.url}</a></div>}
                  {s.notes && <div className="small muted">{s.notes}</div>}
                </td>
                <td className="small">{s.version}</td>
                <td className="small">{s.license}</td>
                <td className="mono small">{s.checksum?.slice(0, 16)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h2>Knowledge-base versions</h2>
        {kb.all_versions.map((v: any) => (
          <div key={v.label} className="small">
            <b>{v.label}</b> · loaded {new Date(v.loaded_at).toLocaleString()} {v.is_current && "· current"}
          </div>
        ))}
        <p className="small muted">
          Findings and reviews record the version they used; reviews made against an older version are marked when the
          current version differs.
        </p>
      </div>
    </>
  );
}
