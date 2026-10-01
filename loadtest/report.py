"""Compute P50/P95/P99, RPS and error rate per run and endpoint from the raw Locust samples.

    python loadtest/report.py [loadtest/results/samples.csv]
"""
import csv
import sys
from collections import defaultdict


def pct(v, p):
    v = sorted(v)
    k = (len(v) - 1) * p / 100
    lo, hi = int(k), min(int(k) + 1, len(v) - 1)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)


def main(path="loadtest/results/samples.csv"):
    groups = defaultdict(list)
    for r in csv.DictReader(open(path)):
        if r["name"] == "auth":
            continue
        groups[(r["run"], r["name"])].append((float(r["ts"]), int(r["status"]), float(r["ms"])))
    print("| Run | Endpoint | Requests | RPS | P50 ms | P95 ms | P99 ms | Errors (non-2xx) | 5xx |")
    print("|---|---|---|---|---|---|---|---|---|")
    for (run, name), rows in sorted(groups.items()):
        ms = [x[2] for x in rows]
        span = max(x[0] for x in rows) - min(x[0] for x in rows) or 1
        errs = sum(1 for x in rows if not 200 <= x[1] < 300)
        e5 = sum(1 for x in rows if x[1] >= 500 or x[1] == 0)
        print(f"| {run} | {name} | {len(rows)} | {len(rows) / span:.1f} | {pct(ms, 50):.0f} | {pct(ms, 95):.0f} | "
              f"{pct(ms, 99):.0f} | {errs} ({errs / len(rows):.2%}) | {e5} |")


if __name__ == "__main__":
    main(*sys.argv[1:])
