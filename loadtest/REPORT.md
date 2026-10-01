# RxGuard load-test report

Measured 2026-10-01 (UTC) with `loadtest/locustfile.py`; percentiles computed from the raw per-request samples
(`loadtest/results/samples_run_*.csv`) by `loadtest/report.py`, not from Locust's histogram buckets.

## Environment (numbers apply only to this setup)

| Item | Value |
|---|---|
| Host | Windows 11 laptop, Docker Desktop 29.8 (WSL2 VM: 8 vCPU, 3.67 GiB RAM) |
| Target | `docker compose` stack on the same machine, via nginx at `http://localhost:8080` (no TLS) — **not a public deployment** |
| web | Django + gunicorn, 2 workers × 8 threads, embedding model warmed at start |
| mysql | MySQL 8.4, binary log off, `innodb_redo_log_capacity` 512 MB, buffer pool 512 MB, `innodb_flush_log_at_trx_commit=1` |
| Load generator | Locust 2.32.4 on the same host (shares CPU with the system under test) |
| Data | KB v2 in Docker: real DDInter (160,235 pairs), NLEM 2022, 13 ICMR STWs (527 chunks) |
| Throttling | `THROTTLE_CHECK` / `THROTTLE_EXPLAIN` raised for the runs (one shared test account); throttling is covered by the API tests |
| Prescriptions | synthetic, 2–8 lines drawn from a pool of 23 lines (brands, a misspelling, combination products) |

## Results

| Run | Setup | Endpoint | Requests | RPS | P50 | P95 | P99 | Errors | Target | Result |
|---|---|---|---|---|---|---|---|---|---|---|
| **A** | `/check`, 20 users, 5 min | `/api/v1/check` | 3,788 | 12.7 | 490 ms | **1,068 ms** | 2,710 ms | 0 (0.00%) | P95 < 1.5 s | **PASS** |
| **B** | `/explain` with the real LLM, 3–5 users | — | — | — | — | — | — | — | P95 < 8 s | **NOT MEASURED** (no `ANTHROPIC_API_KEY` in this environment) |
| **C** | `/explain` with mocked LLM, 20 users, 5 min | `/api/v1/explain` | 673 | 2.3 | 2,775 ms | **5,029 ms** | 14,454 ms | 0 (0.00%) | P95 < 8 s | **PASS** (see caveats) |
| C | (same run; every user also calls `/check` first) | `/api/v1/check` | 705 | 2.4 | 416 ms | 1,207 ms | 2,433 ms | 0 (0.00%) | P95 < 1.5 s | PASS |

**Run C caveats — read before quoting it:**
- The mocked LLM sleeps **2,000 ms per call — an assumed value, not a measured provider median** (run B was not
  possible). Replace it with the measured median from run B and re-run. RxGuard's own overhead at P50 was therefore
  ~775 ms (2,775 − 2,000).
- Query embeddings are cached by exact text. The synthetic pool has 23 lines, so after warm-up almost every drug
  pair is a cache hit. The P99 (14.5 s) reflects the cold-cache start. Real prescriptions with more diverse
  pairs would see more cold encodes; the earlier cold run below shows what that costs on this CPU.

## What changed between runs (all measured, same environment)

| Configuration | Run | P50 | P95 | Errors | Finding |
|---|---|---|---|---|---|
| 1 worker, MySQL defaults, one tool call + audit entry per escalation | A | 1,200 ms | ~3,800 ms | 0 | misses SLA |
| + batched escalations (one Tool 3 call, one audit entry) | A | 1,216 ms | 2,036 ms | 0 | ~100 → 88 SQL statements per check |
| + 2 workers | A | 1,252 ms | 2,406 ms | 0 | no gain: web was not the bottleneck |
| experiment: `innodb_flush_log_at_trx_commit=2` (reverted) | A (90 s) | 1,440 ms | 2,539 ms | 0 | no gain: the binary-log fsync still ran on every commit |
| **+ binary log off, larger redo log / buffer pool, agent_steps stores deltas (full state on final node)** | **A** | **490 ms** | **1,068 ms** | **0** | **meets SLA**; INSERTs had averaged 100 ms–1 s (`performance_schema`) with zero lock time |
| /explain, per-finding embeddings, 1 s Tool 2 timeout | C | 5,352 ms | 10,152 ms | 2 × HTTP 400 | encoder-lock queueing; 400s were >30 findings breaking the claim schema (fixed: LLM explains top 10, the rest get database claims) |
| batch-embed every finding | C | 16,015 ms | 30,229 ms | 2 × 5xx | worse: embedded findings that had no candidate chunks |
| batch-embed only findings with candidate chunks | C | 5,151 ms | 10,001 ms | 0 | still misses |
| + precomputed expansion queries | C | 19,056 ms | 35,059 ms | 50 × 5xx | worse: long expansion texts held the encoder lock |
| **+ query-embedding cache** | **C** | **2,775 ms** | **5,029 ms** | **0** | meets SLA under this (cache-friendly) profile |

Lessons recorded for the team: on this hardware the CPU text encoder is the `/explain` capacity limit, and MySQL
commit I/O was the `/check` limit. The deterministic `/check` path never touched the encoder.

## Not measured

- Run B (real LLM latency and provider rate limits).
- A public live URL. All runs were against `localhost`; network latency and TLS are not included.
- Throughput above 20 concurrent users, and runs longer than 5 minutes.

## Reproduce

```bash
export RXGUARD_PASSWORD=<pharmacist password> RXGUARD_RUN=A
locust -f loadtest/locustfile.py --headless -u 20 -r 5 -t 5m --host $HOST --csv loadtest/results/run_a CheckUser
python loadtest/report.py loadtest/results/samples.csv
# run C: start web with LLM_MOCK_SLEEP_MS=<measured median from run B>, then use ExplainUser; never set it in production
```
