"""RxGuard load tests (spec 20.4). Run against the live URL.

Run A  /check, 20 users, 5 min, 2-8 drug synthetic prescriptions:
    locust -f loadtest/locustfile.py --headless -u 20 -r 5 -t 5m --host $HOST --csv loadtest/results/run_a CheckUser
Run B  /explain with the real LLM, 3-5 users (needs ANTHROPIC_API_KEY on the server):
    locust -f loadtest/locustfile.py --headless -u 4 -r 1 -t 5m --host $HOST --csv loadtest/results/run_b ExplainUser
Run C  /explain with the mocked LLM (server started with LLM_MOCK_SLEEP_MS=<median>), 20 users:
    locust -f loadtest/locustfile.py --headless -u 20 -r 5 -t 5m --host $HOST --csv loadtest/results/run_c ExplainUser

Credentials: RXGUARD_USER / RXGUARD_PASSWORD (a pharmacist account). Throttling is per user, so the server under
test runs with raised THROTTLE_* limits; throttling itself is covered by the API tests, not this report.
Percentiles are computed from the raw per-request samples by loadtest/report.py, not from Locust's buckets.
"""
import csv
import os
import random
import threading
import time
from pathlib import Path

from locust import HttpUser, between, events, task

DRUGS = ["Tab Warfarin 5 mg OD", "Tab Aspirin 75 mg OD", "Tab Fluconazole 150 mg weekly", "Tab Paracetamol 500 mg SOS",
         "Tab Simvastatin 20 mg HS", "Tab Clarithromycin 500 mg BD", "Tab Clopidogrel 75 mg OD",
         "Cap Omeprazole 20 mg OD", "Tab Enalapril 5 mg BD", "Tab Amlodipine 5 mg OD", "Tab Metformin 500 mg BD",
         "Tab Atorvastatin 10 mg HS", "Tab Ibuprofen 400 mg TDS", "Tab Digoxin 0.25 mg OD", "Tab Amiodarone 200 mg OD",
         "Tab Ciprofloxacin 500 mg BD", "Tab Levothyroxine 50 mcg OD", "Tab Losartan 50 mg OD", "Tab Glimepiride 1 mg OD",
         "Tab Synflam BD", "Tab Synpara 650 SOS", "Tab Synclot 75 OD", "Tab amlodipne 5 mg OD"]

SAMPLES = Path(os.environ.get("RXGUARD_SAMPLES", "loadtest/results/samples.csv"))
_lock = threading.Lock()


def prescription():
    lines = random.sample(DRUGS, random.randint(2, 8))
    return "Rx\n" + "\n".join(f"{i}. {x}" for i, x in enumerate(lines, start=1))


@events.request.add_listener
def record_sample(request_type, name, response_time, response_length, response, exception, **kw):
    """Keep every raw sample so percentiles are computed exactly."""
    SAMPLES.parent.mkdir(parents=True, exist_ok=True)
    status = getattr(response, "status_code", 0) if response is not None else 0
    with _lock:
        new = not SAMPLES.exists()
        with open(SAMPLES, "a", newline="") as f:
            w = csv.writer(f)
            if new:
                w.writerow(["ts", "run", "name", "status", "ms"])
            w.writerow([time.time(), os.environ.get("RXGUARD_RUN", "?"), name, status, round(response_time, 2)])


class _Base(HttpUser):
    abstract = True
    wait_time = between(0.5, 1.5)

    def on_start(self):
        r = self.client.post("/api/v1/auth/token", json={"username": os.environ.get("RXGUARD_USER", "pharmacist"),
                                                         "password": os.environ["RXGUARD_PASSWORD"]},
                             name="auth")
        self.client.headers["Authorization"] = f"Token {r.json()['token']}"


class CheckUser(_Base):
    @task
    def check(self):
        self.client.post("/api/v1/check", json={"text": prescription(), "age_band": "18-64"}, name="/api/v1/check")


class ExplainUser(_Base):
    @task
    def explain(self):
        r = self.client.post("/api/v1/check", json={"text": prescription()}, name="/api/v1/check")
        if r.status_code == 201 and r.json()["findings"]:
            self.client.post("/api/v1/explain", json={"prescription_id": r.json()["id"]}, name="/api/v1/explain")
