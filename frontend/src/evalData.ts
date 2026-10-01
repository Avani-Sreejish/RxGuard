// Measured results copied from the repo's reports. Update when the reports are regenerated:
//   EVAL_REPORT.md       (eval/run.py, run #13, 2026-10-01 13:21 UTC, KB v4)
//   loadtest/REPORT.md   (loadtest/locustfile.py, 2026-10-01 UTC)

export type Verdict = "PASS" | "FAIL" | "NOT MEASURED" | "REPORTED";

export const EVAL_META = {
  run: 13,
  when: "2026-10-01 13:21 UTC",
  kb: "v4",
  chain: "gemini-3.5-flash-lite → gemini-3.5-flash → template",
  retrieval: "Hybrid FAISS + BM25 (RRF), dense cutoff 0.81, reranker off",
  source: "EVAL_REPORT.md",
};

export const EVAL_METRICS: { id: string; name: string; plain: string; target: string; actual: string; verdict: Verdict }[] = [
  { id: "A", name: "Interaction correctness", plain: "Flags exactly the DDInter pairs, nothing more or less", target: "100% precision and recall", actual: "8 / 8 checks", verdict: "PASS" },
  { id: "B", name: "Citation correctness", plain: "Displayed claims are supported by their cited passage", target: "≥ 90%", actual: "5 / 6 checks (83%); human labelling not yet done", verdict: "FAIL" },
  { id: "C", name: "Retrieval quality", plain: "The right guideline passages are found", target: "Recall@5 ≥ 0.8", actual: "Mean Recall@5 0.778, MRR 1.0", verdict: "FAIL" },
  { id: "D", name: "Drug name resolution", plain: "Brands, misspellings and combinations map to the right molecule", target: "≥ 95%; pair logic 100%", actual: "16 / 16 checks", verdict: "PASS" },
  { id: "E", name: "Safety and refusals", plain: "Refuses dosing, escalates red flags, children and unknown drugs", target: "100%", actual: "27 / 27 checks", verdict: "PASS" },
  { id: "F", name: "Injection resistance", plain: "Instructions hidden in a prescription change nothing", target: "100%", actual: "2 / 2 checks", verdict: "PASS" },
  { id: "H", name: "Server errors", plain: "No unexpected 5xx responses", target: "0 unexpected", actual: "1 of 54 (the deliberate database-down case)", verdict: "PASS" },
  { id: "I", name: "Cost per query", plain: "LLM spend and share of checks needing no LLM", target: "Reported, with cap", actual: "75.5% of queries used zero LLM tokens; cap 3 calls / 6,000 input tokens", verdict: "REPORTED" },
  { id: "E21", name: "Malayalam / Hindi explanations", plain: "Regional-language layer", target: "Stretch goal", actual: "Built in this UI after run #13; not yet in the eval", verdict: "NOT MEASURED" },
];

export const LOAD_META = {
  when: "2026-10-01 UTC",
  host: "Windows 11 laptop, Docker Desktop (8 vCPU, 3.67 GiB), localhost via nginx, no TLS",
  stack: "Django + gunicorn 2×8, MySQL 8.4, Locust 2.32.4 on the same host",
  source: "loadtest/REPORT.md",
};

export const LOAD_RUNS: {
  run: string; what: string; users: number | null; requests: number | null; rps: number | null;
  p50: number | null; p95: number | null; p99: number | null; errors: string; target: number; verdict: Verdict; caveat?: string;
}[] = [
  { run: "A", what: "Interaction check (/check)", users: 20, requests: 3788, rps: 12.7, p50: 490, p95: 1068, p99: 2710, errors: "0 (0.00%)", target: 1500, verdict: "PASS" },
  { run: "C", what: "Guideline evidence (/explain), mocked LLM", users: 20, requests: 673, rps: 2.3, p50: 2775, p95: 5029, p99: 14454, errors: "0 (0.00%)", target: 8000, verdict: "PASS",
    caveat: "LLM latency assumed at 2 s per call, not measured; cache-friendly drug pool." },
  { run: "B", what: "Guideline evidence (/explain), real LLM", users: null, requests: null, rps: null, p50: null, p95: null, p99: null, errors: "—", target: 8000, verdict: "NOT MEASURED",
    caveat: "No API key in the load-test environment." },
];
