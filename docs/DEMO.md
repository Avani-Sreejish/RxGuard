# 5-minute demo runbook (maps spec section 24 onto the built UI)

Sign in as `admin` (Judge Attack toggles need an admin and `DEMO_TOGGLES_ENABLED=1`).

| Time | Click | Point to |
|---|---|---|
| 0:00–0:30 | (slide) | A five-drug prescription with brand names: which pair first, and can you prove why? |
| 0:30–1:15 | **New check → Demo loader → "Demo prescription" → Run check** | Resolution panel: *Synwarf* → Warfarin (SYNTHETIC badge), *amlodipne* → Amlodipine (fuzzy 94.7), *Synflam* → Ibuprofen + Acetaminophen (combination), *Zyntrofex* UNRESOLVED |
| 1:15–2:00 | Detail page header + map | green "/check: 0 LLM tokens"; map with Warfarin hub, Acetaminophen duplicate ring, dashed "?" node; P1 badge with rule IDs in "Why this priority" |
| 2:00–2:45 | **Explain**, then **Prove why** on Warfarin ↔ Acetylsalicylic acid | DATABASE FACT row → DDInter record id → evidence chunk with highlighted span; an INSUFFICIENT EVIDENCE finding; any "claim(s) removed by the verifier" line |
| 2:45–3:15 | **Demo loader → "Red-flag note"**, then the Follow-up box: "Why was the second one flagged?" | red RED_FLAG banner while findings still show; tool trace `get_finding({finding_ordinal: 2})` |
| 3:15–3:50 | **Judge Attack**: Prompt-injection document · Pediatric dosing · LLM unavailable | "interaction set identical: true" + red banner; fixed dosing refusal + escalations; TEMPLATE MODE with identical findings |
| 3:50–4:30 | Back on the demo prescription: Acknowledge one finding, Escalate another, **Complete review** (409 gate), confirm Zyntrofex as "Not in database", Complete again | "Audit integrity ✓", "reviewed against KB vN" (the current version) on each review |
| 4:30–5:00 | EVAL_REPORT.md, loadtest/REPORT.md, Observability page | only measured numbers; NOT MEASURED rows stated plainly |

Tamper demo (optional, 20 s): `docker compose exec mysql mysql -urxguard -p rxguard -e "UPDATE audit_logs SET payload='{}' WHERE prescription_id=<id> AND seq=3"`
then reload the detail page → **TAMPERED at seq 3**.

Backups: local `docker compose` copy and a recorded video (spec: rehearse three times on the live deployment).
