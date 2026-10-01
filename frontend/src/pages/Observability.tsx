import { useEffect, useState } from "react";
import { api } from "../api";

export default function Observability() {
  const [ov, setOv] = useState<any>(null);
  const [lat, setLat] = useState<any>(null);
  const [cost, setCost] = useState<any>(null);
  const [ready, setReady] = useState<any>(null);
  const load = () => {
    api("/api/v1/metrics/overview").then(setOv);
    api("/api/v1/metrics/latency").then(setLat);
    api("/api/v1/metrics/cost").then(setCost);
    fetch("/readyz").then((r) => r.json()).then(setReady).catch(() => setReady({ status: "unreachable" }));
  };
  useEffect(load, []);

  const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
  return (
    <>
      <div className="row spread">
        <div>
          <h1>Observability</h1>
          <p className="sub">Computed from request_logs, llm_calls and tool_calls. Measured on this deployment only.</p>
        </div>
        <button className="btn" onClick={load}>Refresh</button>
      </div>
      {ov && (
        <div className="stats">
          <Stat v={ov.requests} l="API requests" />
          <Stat v={pct(ov.success_rate)} l="success rate (<400)" />
          <Stat v={ov.errors_5xx} l="5xx responses" />
          <Stat v={ov.llm_calls} l="LLM calls" />
          <Stat v={pct(cost?.zero_token_share)} l="zero-LLM-token queries" />
          <Stat v={cost?.total_input_tokens + cost?.total_output_tokens || 0} l="LLM tokens (in+out)" />
          <Stat v={cost?.mean_usd == null ? "—" : `$${cost.mean_usd}`} l="mean cost / query" />
          <Stat v={cost?.p95_usd == null ? "—" : `$${cost.p95_usd}`} l="P95 cost / query" />
          <Stat v={ov.fallback_activations} l="LLM fallbacks / failures" />
          <Stat v={ov.template_explanations} l="template-mode explanations" />
          <Stat v={ov.retrieval_failures} l="retrieval tool failures" />
          <Stat v={ov.degraded_retrievals} l="degraded (FULLTEXT) retrievals" />
          <Stat v={ov.injection_attempts} l="injection attempts flagged" />
        </div>
      )}
      <div className="grid2" style={{ marginTop: 14 }}>
        <div className="card">
          <h2>Latency by endpoint (request_logs)</h2>
          <table>
            <thead>
              <tr><th>Endpoint</th><th>n</th><th>P50</th><th>P95</th><th>P99</th><th>5xx rate</th></tr>
            </thead>
            <tbody>
              {lat && Object.entries<any>(lat.endpoints).sort().map(([ep, v]) => (
                <tr key={ep}>
                  <td className="mono">{ep}</td>
                  <td>{v.count}</td>
                  <td>{v.p50_ms} ms</td>
                  <td>
                    <b style={{ color: lat.targets[ep] && v.p95_ms > lat.targets[ep].p95_ms ? "var(--p1)" : undefined }}>{v.p95_ms} ms</b>
                  </td>
                  <td>{v.p99_ms} ms</td>
                  <td>{pct(v.error_rate_5xx)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">SLA targets (until measured under load): /check P95 &lt; 1500 ms · /explain P95 &lt; 8000 ms.</p>
        </div>
        <div className="card">
          <h2>Escalations and readiness</h2>
          {ov && Object.entries<number>(ov.escalations).map(([k, v]) => (
            <div key={k} className="row spread small"><span className="mono">{k}</span><b>{v}</b></div>
          ))}
          <h2 style={{ marginTop: 14 }}>/readyz</h2>
          <pre className="trace">{JSON.stringify(ready, null, 1)}</pre>
          {cost && (
            <>
              <h2>LLM configuration</h2>
              <div className="small">
                primary <span className="mono">{cost.models.primary}</span> · fallback <span className="mono">{cost.models.fallback}</span> · then template mode
                <br />cap: {cost.cap.max_calls_per_query} calls, {cost.cap.max_input_tokens_per_query} input tokens per query,
                {" "}{cost.cap.max_output_tokens_per_call} output tokens per call
                <br />prices (USD / 1M tokens, from configuration): <span className="mono">{cost.prices_usd_per_mtok}</span>
              </div>
            </>
          )}
        </div>
      </div>
      {ov?.latest_eval && (
        <div className="card" style={{ marginTop: 14 }}>
          <h2>Latest evaluation run</h2>
          <div className="small">
            #{ov.latest_eval.id} · KB {ov.latest_eval.kb_version} · {ov.latest_eval.llm_mode} · prompts <span className="mono">{ov.latest_eval.prompt_version}</span>
          </div>
        </div>
      )}
    </>
  );
}

function Stat({ v, l }: { v: unknown; l: string }) {
  return (
    <div className="stat">
      <div className="v">{String(v ?? "—")}</div>
      <div className="l">{l}</div>
    </div>
  );
}
