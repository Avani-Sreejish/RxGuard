import { useEffect, useState } from "react";
import { api, isDemo } from "../api";
import { useI18n } from "../i18n";
import { EVAL_META, EVAL_METRICS, LOAD_META, LOAD_RUNS, type Verdict } from "../evalData";
import type { KbInfo, LatencyMetrics } from "../types";
import Icon from "../components/Icon";

function VerdictTag({ v }: { v: Verdict }) {
  return <span className={`verdict v-${v.replace(" ", "-")}`}>{v === "NOT MEASURED" ? "Not measured" : v === "REPORTED" ? "Reported" : v === "PASS" ? "Pass" : "Fail"}</span>;
}

const ms = (n: number | null) => (n === null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`);

/** P95 against its target, one shared scale so the two runs compare honestly. */
function P95Chart() {
  const runs = LOAD_RUNS.filter((r) => r.p95 !== null);
  const max = 9000;
  const W = 560, rowH = 46, left = 150, right = 20, top = 8;
  const x = (v: number) => left + (v / max) * (W - left - right);
  const ticks = [0, 2000, 4000, 6000, 8000];
  // value label sits after the bar, and jumps past the target line if the two would collide
  const labelX = (barEnd: number, targetX: number) => (targetX > barEnd && targetX - barEnd < 56 ? targetX + 6 : barEnd + 6);
  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${top + runs.length * rowH + 30}`} role="img" aria-label="P95 latency by run against target">
        {ticks.map((tk) => (
          <g key={tk}>
            <line x1={x(tk)} x2={x(tk)} y1={top} y2={top + runs.length * rowH} className="grid" />
            <text x={x(tk)} y={top + runs.length * rowH + 18} className="axis" textAnchor="middle">{tk / 1000} s</text>
          </g>
        ))}
        {runs.map((r, i) => {
          const y = top + i * rowH + 10;
          return (
            <g key={r.run}>
              <text x={0} y={y + 12} className="lbl">Run {r.run}</text>
              <text x={0} y={y + 27} className="axis">{r.run === "A" ? "/check" : "/explain (mock LLM)"}</text>
              <rect x={left} y={y} width={x(r.p95!) - left} height={22} rx={3} className="bar" />
              <line x1={x(r.target)} x2={x(r.target)} y1={y - 5} y2={y + 27} className="target" />
              <text x={labelX(x(r.p95!), x(r.target))} y={y + 15} className="val">{ms(r.p95)}</text>
            </g>
          );
        })}
      </svg>
      <p className="legend">
        <span className="sw bar" /> P95 measured <span className="sw target" /> target (1.5 s for /check, 8 s for /explain)
      </p>
    </div>
  );
}

export default function Evaluation() {
  const { t } = useI18n();
  const [lat, setLat] = useState<LatencyMetrics | null>(null);
  const [kb, setKb] = useState<KbInfo | null>(null);

  useEffect(() => {
    api<LatencyMetrics>("/api/v1/metrics/latency").then(setLat).catch(() => setLat(null));
    api<KbInfo>("/api/v1/kb").then(setKb).catch(() => setKb(null));
  }, []);

  const liveRows = lat ? Object.entries(lat.endpoints).filter(([ep]) => /check|explain|ask/.test(ep)) : [];

  return (
    <div className="page page-eval">
      <header className="page-head">
        <div>
          <h1>{t("eval.title")}</h1>
          <p className="muted">{t("eval.sub")}</p>
        </div>
      </header>

      <section className="eval-sec">
        <h2>{t("eval.quality")}</h2>
        <p className="meta">
          Run #{EVAL_META.run} · {EVAL_META.when} · KB {EVAL_META.kb} · {EVAL_META.chain} · source: {EVAL_META.source}
        </p>
        <div className="table-wrap">
          <table className="table eval-table">
            <thead>
              <tr>
                <th>Check</th>
                <th>Target</th>
                <th>Measured</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {EVAL_METRICS.map((m) => (
                <tr key={m.id}>
                  <td>
                    <b>{m.name}</b>
                    <div className="meta">{m.plain}</div>
                  </td>
                  <td>{m.target}</td>
                  <td>{m.actual}</td>
                  <td><VerdictTag v={m.verdict} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="eval-sec">
        <h2>{t("eval.load")}</h2>
        <p className="meta">{LOAD_META.when} · {LOAD_META.host} · {LOAD_META.stack} · source: {LOAD_META.source}</p>
        <P95Chart />
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Run</th>
                <th className="num">Users</th>
                <th className="num">Requests</th>
                <th className="num">P50</th>
                <th className="num">P95</th>
                <th className="num">P99</th>
                <th>Errors</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {LOAD_RUNS.map((r) => (
                <tr key={r.run}>
                  <td>
                    <b>Run {r.run}</b> <span className="meta">{r.what}</span>
                    {r.caveat && <div className="meta warn-text">{r.caveat}</div>}
                  </td>
                  <td className="num">{r.users ?? "—"}</td>
                  <td className="num">{r.requests?.toLocaleString("en-IN") ?? "—"}</td>
                  <td className="num">{ms(r.p50)}</td>
                  <td className="num"><b>{ms(r.p95)}</b></td>
                  <td className="num">{ms(r.p99)}</td>
                  <td>{r.errors}</td>
                  <td><VerdictTag v={r.verdict} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="eval-sec">
        <h2>{t("eval.live")}</h2>
        {isDemo() ? (
          <p className="muted">Live latency comes from the backend's request log and is not available in the offline demo.</p>
        ) : liveRows.length === 0 ? (
          <p className="muted">No requests logged on this server yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Endpoint</th>
                  <th className="num">Requests</th>
                  <th className="num">P50</th>
                  <th className="num">P95</th>
                  <th className="num">Target P95</th>
                  <th className="num">5xx rate</th>
                </tr>
              </thead>
              <tbody>
                {liveRows.map(([ep, m]) => (
                  <tr key={ep}>
                    <td className="code">{ep}</td>
                    <td className="num">{m.count}</td>
                    <td className="num">{ms(m.p50_ms)}</td>
                    <td className="num">{ms(m.p95_ms)}</td>
                    <td className="num">{lat?.targets[ep] ? ms(lat.targets[ep].p95_ms) : "—"}</td>
                    <td className="num">{(m.error_rate_5xx * 100).toFixed(2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {kb?.kb_version && (
        <section className="eval-sec">
          <h2>{t("eval.kb")}</h2>
          <p className="meta">
            KB {kb.kb_version}
            {kb.counts && <> · {kb.counts.drugs.toLocaleString("en-IN")} drugs · {kb.counts.interactions.toLocaleString("en-IN")} interaction pairs · {kb.counts.documents} guideline documents</>}
          </p>
          <ul className="sources">
            {kb.sources?.map((s) => (
              <li key={s.name}>
                <div>
                  <b>{s.name}</b> <span className="meta">{s.version}</span> {s.is_synthetic && <span className="tag tag-warn">Synthetic</span>}
                  <div className="meta">{s.notes}</div>
                </div>
                <div className="meta">{s.license}</div>
                {s.url && (
                  <a href={s.url} target="_blank" rel="noreferrer" className="ext" aria-label={`${s.name} website`}>
                    <Icon name="external" size={14} />
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
