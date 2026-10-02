# 5-minute demo runbook

Sign in as `admin` (also shows the **Knowledge base** menu). All prescriptions are synthetic.

| Time | Click | Point to |
|---|---|---|
| 0:00–0:30 | (slide) | A five-drug prescription with brand names: which pair first, and can you prove why? |
| 0:30–1:15 | **New check → Try an example → "Demo prescription (brand, misspelling, combination, unknown drug)" → Check for interactions** | Medicines list: *Synwarf* → Warfarin and *Synflam* → Ibuprofen + Acetaminophen (SYNTHETIC DEMO DATA badges), *amlodipne* read as Amlodipine "from a misspelling, please check", *Zyntrofex* "not recognised — which medicine is it?" |
| 1:15–2:00 | Review page header | One-line summary ("N interactions between M medicines, K Major"), the **Act now** label, "0 of N required steps done" |
| 2:00–2:45 | **Needs your action** cards, then **How was this found?** on Warfarin + Acetylsalicylic acid | Database fact in plain words; "What the guidelines say" with the *AI summary · verified* tag and the source quote; in the drawer: database record → DDInter source file → guideline passage → document licence |
| 2:45–3:15 | Top-bar **हिंदी / മലയാളം** | Each interaction's database record in Hindi / Malayalam; medicine names stay in Latin script |
| 3:15–3:50 | **Ask a question** tab: "Why was the second one flagged?" · then **New check → Try an example → "Prompt Injection Attack Defense"** | Session memory resolves "the second one"; the injected line is flagged with a red banner and never becomes a drug |
| 3:50–4:30 | Acknowledge one card, Escalate another, **Complete review** (blocked until every Act-now item has an action), confirm *Zyntrofex* as "It is not in the database", Complete again | The gate message, then "Review completed"; **History** tab: hash-chained audit trail, "Chain intact" |
| 4:30–5:00 | EVAL_REPORT.md, loadtest/REPORT.md | only measured numbers; FAIL and NOT MEASURED rows stated plainly |

Failure behaviour (LLM down, vector index down, database down) is exercised by `eval/run.py` and can be triggered
by an admin with the `X-RxGuard-Simulate` header when `DEMO_TOGGLES_ENABLED=1`; there is no UI screen for it.

Tamper demo (optional, 20 s): `docker compose exec mysql mysql -urxguard -p rxguard -e "UPDATE audit_logs SET payload='{}' WHERE prescription_id=<id> AND seq=3"`
then open the prescription's **History** tab → **TAMPERED at seq 3**.

Backups: local `docker compose` copy and a recorded video (spec: rehearse three times on the live deployment).
