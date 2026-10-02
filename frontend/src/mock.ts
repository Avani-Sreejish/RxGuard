// Offline demo backend. Answers the same /api/v1 calls as the Django API, in the browser, so the UI can be
// explored without MySQL, DDInter or an LLM key. Everything here is SYNTHETIC DEMO DATA:
// - the interaction table is a small subset limited to pairs the repo's own evaluation reports (EVAL_REPORT.md);
// - guideline passages are sample text written for the demo and are marked as such in the UI;
// - patients are fictional.
import type {
  AskResult, AuditEntry, Claim, Duplication, EvidenceCard, Finding, Item, Prescription, Priority, QueueRow, Review,
  ReviewActionType, Severity,
} from "./types";
import type { Patient } from "./patients";

const KB = "v4";
const DOSING_REFUSAL = "RxGuard does not provide dosing. Refer to the prescriber and official references.";
const DECISION_REFUSAL = "RxGuard can't make dispensing decisions. Here is the evidence; the decision is yours.";
const INSUFFICIENT = "Insufficient evidence retrieved. Pharmacist review required.";
const INJECTION_BANNER = "Suspicious instructions detected in document; ignored.";

interface DemoDrug { id: number; name: string; aliases: string[]; nlem: boolean | null }
const DRUGS: DemoDrug[] = [
  { id: 101, name: "Warfarin", aliases: ["warfarin"], nlem: null },
  { id: 102, name: "Acetylsalicylic acid", aliases: ["acetylsalicylic acid", "aspirin"], nlem: null },
  { id: 103, name: "Fluconazole", aliases: ["fluconazole"], nlem: null },
  { id: 104, name: "Acetaminophen", aliases: ["acetaminophen", "paracetamol"], nlem: null },
  { id: 105, name: "Amlodipine", aliases: ["amlodipine"], nlem: true },
  { id: 106, name: "Atorvastatin", aliases: ["atorvastatin"], nlem: null },
  { id: 107, name: "Clopidogrel", aliases: ["clopidogrel"], nlem: null },
  { id: 108, name: "Omeprazole", aliases: ["omeprazole"], nlem: null },
  { id: 109, name: "Simvastatin", aliases: ["simvastatin"], nlem: null },
  { id: 110, name: "Clarithromycin", aliases: ["clarithromycin"], nlem: true },
  { id: 111, name: "Enalapril", aliases: ["enalapril"], nlem: null },
  { id: 112, name: "Potassium chloride", aliases: ["potassium chloride"], nlem: null },
  { id: 113, name: "Metformin", aliases: ["metformin"], nlem: null },
  { id: 114, name: "Glimepiride", aliases: ["glimepiride"], nlem: null },
];
// Fictional brands, as in data/synthetic/brands.csv
const PRODUCTS: { brand: string; ingredients: number[] }[] = [
  { brand: "Synwarf", ingredients: [101] },
  { brand: "Synpara", ingredients: [104] },
  { brand: "Synclot", ingredients: [107] },
  { brand: "Synclopi-A", ingredients: [107, 102] },
  { brand: "Synstatin", ingredients: [109] },
  { brand: "Synclar", ingredients: [110] },
  { brand: "Synamlo", ingredients: [105] },
  { brand: "Synglim-M", ingredients: [114, 113] },
  { brand: "Synprazole", ingredients: [108] },
  { brand: "Synenal", ingredients: [111] },
  { brand: "Synkal", ingredients: [112] },
  { brand: "Synflu", ingredients: [103] },
];
// Pairs and severities as reported in EVAL_REPORT.md (DDInter rows in KB v4).
const PAIRS: Record<string, Severity> = {
  "101|102": "Major",
  "101|103": "Major",
  "101|104": "Moderate",
  "102|103": "Unknown",
  "103|104": "Unknown",
  "102|104": "Unknown",
  "109|110": "Major",
  "107|108": "Major",
  "111|112": "Major",
};
const PAIR_SOURCE: Record<string, string> = {};
const pairKey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const drugById = (id: number) => DRUGS.find((d) => d.id === id)!;

interface DemoEvidence { cards: Omit<EvidenceCard, "chunk_id">[]; claim?: string; span?: string }
const EVIDENCE: Record<string, DemoEvidence> = {
  "101|102": {
    cards: [{
      document: "ICMR Standard Treatment Workflow: Stroke", doc_type: "ICMR_STW", source: "ICMR", version: "2022",
      license: "© ICMR and DHR, MoHFW", url: "https://www.icmr.gov.in/standard-treatment-workflows-stws",
      section: "Secondary prevention › Antithrombotic therapy", page: 2, file_name: "ICMR_STW_Stroke.pdf",
      text: "Combining an oral anticoagulant such as warfarin with an antiplatelet agent such as aspirin increases the risk of bleeding. Where both are prescribed, the indication for combined therapy should be reviewed and INR monitored closely.",
      score: 0.84, retrieval_mode: "hybrid", matched_via: { Warfarin: "direct", "Acetylsalicylic acid": "alias: aspirin" },
      label: "SOURCE TEXT (retrieved, not AI-generated)", sample: true,
    }],
    claim: "The stroke workflow notes that warfarin given with aspirin increases bleeding risk and asks for close INR monitoring.",
    span: "increases the risk of bleeding",
  },
  "107|108": {
    cards: [{
      document: "ICMR Standard Treatment Workflows: Cardiology", doc_type: "ICMR_STW", source: "ICMR", version: "2023",
      license: "© ICMR and DHR, MoHFW. All rights reserved", url: "https://www.icmr.gov.in/standard-treatment-workflows-stws",
      section: "Acute coronary syndrome › Antiplatelet therapy", page: 11, file_name: "ICMR_STW_Cardiology_Vol1.pdf",
      text: "When gastric protection is needed in patients on clopidogrel, note that omeprazole may reduce the antiplatelet effect of clopidogrel. The choice of proton pump inhibitor should take this interaction into account.",
      score: 0.83, retrieval_mode: "hybrid", matched_via: { Clopidogrel: "direct", Omeprazole: "direct" },
      label: "SOURCE TEXT (retrieved, not AI-generated)", sample: true,
    }],
    claim: "The cardiology workflow states that omeprazole may reduce the antiplatelet effect of clopidogrel.",
    span: "omeprazole may reduce the antiplatelet effect of clopidogrel",
  },
};

// Malayalam / Hindi renderings of the demo's sample passages and claims (the live app asks /api/v1/translate).
export const DEMO_TRANSLATIONS: Record<string, { ml: string; hi: string }> = {
  [EVIDENCE["101|102"].cards[0].text]: {
    ml: "warfarin പോലുള്ള ഒരു ഓറൽ ആന്റികോയാഗുലന്റിനൊപ്പം aspirin പോലുള്ള ഒരു ആന്റിപ്ലേറ്റ്‌ലെറ്റ് മരുന്ന് നൽകുമ്പോൾ രക്തസ്രാവ സാധ്യത കൂടുന്നു. രണ്ടും നിർദ്ദേശിച്ചിട്ടുണ്ടെങ്കിൽ, സംയുക്ത ചികിത്സയുടെ ആവശ്യകത പുനഃപരിശോധിക്കുകയും INR സൂക്ഷ്മമായി നിരീക്ഷിക്കുകയും വേണം.",
    hi: "warfarin जैसे मौखिक एंटीकोएगुलेंट को aspirin जैसी एंटीप्लेटलेट दवा के साथ देने से रक्तस्राव का जोखिम बढ़ता है। जब दोनों लिखी गई हों, तो संयुक्त उपचार के संकेत की समीक्षा करनी चाहिए और INR की बारीकी से निगरानी करनी चाहिए।",
  },
  [EVIDENCE["101|102"].claim!]: {
    ml: "warfarin, aspirin എന്നിവ ഒരുമിച്ച് നൽകുമ്പോൾ രക്തസ്രാവ സാധ്യത കൂടുമെന്നും INR സൂക്ഷ്മമായി നിരീക്ഷിക്കണമെന്നും സ്ട്രോക്ക് വർക്ക്ഫ്ലോ പറയുന്നു.",
    hi: "स्ट्रोक वर्कफ़्लो बताता है कि warfarin को aspirin के साथ देने से रक्तस्राव का जोखिम बढ़ता है और INR की बारीकी से निगरानी ज़रूरी है।",
  },
  [EVIDENCE["107|108"].cards[0].text]: {
    ml: "clopidogrel കഴിക്കുന്ന രോഗികൾക്ക് ആമാശയ സംരക്ഷണം ആവശ്യമുള്ളപ്പോൾ, omeprazole clopidogrel-ന്റെ ആന്റിപ്ലേറ്റ്‌ലെറ്റ് ഫലം കുറച്ചേക്കാം എന്ന് ശ്രദ്ധിക്കുക. പ്രോട്ടോൺ പമ്പ് ഇൻഹിബിറ്റർ തിരഞ്ഞെടുക്കുമ്പോൾ ഈ പ്രതിപ്രവർത്തനം കണക്കിലെടുക്കണം.",
    hi: "clopidogrel ले रहे मरीज़ों में जब पेट की सुरक्षा की ज़रूरत हो, तो ध्यान दें कि omeprazole, clopidogrel के एंटीप्लेटलेट प्रभाव को कम कर सकता है। प्रोटॉन पंप इनहिबिटर चुनते समय इस इंटरैक्शन को ध्यान में रखना चाहिए।",
  },
  [EVIDENCE["107|108"].claim!]: {
    ml: "omeprazole clopidogrel-ന്റെ ആന്റിപ്ലേറ്റ്‌ലെറ്റ് ഫലം കുറച്ചേക്കാമെന്ന് കാർഡിയോളജി വർക്ക്ഫ്ലോ പറയുന്നു.",
    hi: "कार्डियोलॉजी वर्कफ़्लो बताता है कि omeprazole, clopidogrel के एंटीप्लेटलेट प्रभाव को कम कर सकता है।",
  },
};

// ------------------------------------------------------------------ state
interface Stored {
  rx: Prescription;
  ownerNote: string;
  audit: Omit<AuditEntry, "hash" | "prev_hash">[];
  asks: { role: "user" | "assistant"; content: string; payload?: AskResult }[];
}
const db: Stored[] = [];
let seeding = true;
let nextId = 1, nextItem = 1, nextFinding = 1, nextReview = 1, nextChunk = 9000, nextEsc = 1;
const USER = "pharmacist";

const nowIso = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cid = () => Math.random().toString(16).slice(2, 14) + Math.random().toString(16).slice(2, 14);

function fail(status: number, code: string, message: string, details?: unknown): never {
  throw { status, body: { error: { code, message, correlation_id: cid(), details } } };
}

function norm(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function lev(a: string, b: string) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
// Same shape as rapidfuzz's ratio: "amlodipne" vs "amlodipine" scores 94.7, as in the eval.
const ratio = (a: string, b: string) => {
  const total = a.length + b.length || 1;
  return Math.round(((total - lev(a, b)) / total) * 1000) / 10;
};

const FORM_WORDS = new Set(["tab", "tablet", "tabs", "cap", "capsule", "caps", "syp", "syrup", "inj", "injection", "susp", "oint", "drops"]);
const ALIASES: { text: string; drugs: number[]; brand?: string }[] = [
  ...DRUGS.flatMap((d) => d.aliases.map((a) => ({ text: a, drugs: [d.id] }))),
  ...PRODUCTS.map((p) => ({ text: norm(p.brand), drugs: p.ingredients, brand: p.brand })),
];

const RED_FLAGS = ["chest pain", "breathless", "shortness of breath", "difficulty breathing", "seizure", "fits",
  "unconscious", "fainted", "black stool", "vomiting blood", "blood in stool", "bleeding", "swelling of face",
  "swelling of lips", "rash with fever", "suicidal"];
const INJECTION = ["ignore previous instructions", "mark all safe", "no interactions", "system message", "you are now",
  "developer mode", "disregard"];

function resolveLine(raw: string): { drugs: number[]; brand?: string; method: string; confidence: number | null; matched: string;
  candidates: Item["candidates"]; needs: boolean } {
  const words = norm(raw).split(" ").filter((w) => w && !/^\d/.test(w) && !FORM_WORDS.has(w));
  // longest alias found as a phrase
  for (let len = Math.min(3, words.length); len >= 1; len--) {
    for (let i = 0; i + len <= words.length; i++) {
      const phrase = words.slice(i, i + len).join(" ");
      const hit = ALIASES.find((a) => a.text === phrase);
      if (hit) return { drugs: hit.drugs, brand: hit.brand, method: "exact", confidence: 100, matched: phrase, candidates: [], needs: false };
    }
  }
  // fuzzy on single words
  let best: { score: number; alias: (typeof ALIASES)[number]; word: string } | null = null;
  const cands: Item["candidates"] = [];
  for (const w of words) {
    if (w.length < 4) continue;
    for (const a of ALIASES) {
      const s = ratio(w, a.text);
      if (!best || s > best.score) best = { score: s, alias: a, word: w };
      if (s >= 80 && a.drugs.length === 1 && !cands.some((c) => c.drug_id === a.drugs[0]))
        cands.push({ drug_id: a.drugs[0], name: drugById(a.drugs[0]).name, score: s });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  if (best && best.score >= 92)
    return { drugs: best.alias.drugs, brand: best.alias.brand, method: "fuzzy", confidence: best.score, matched: best.word, candidates: [], needs: false };
  return { drugs: [], method: "unresolved", confidence: best?.score ?? null, matched: words[0] ?? raw, candidates: cands.slice(0, 3),
    needs: true };
}

const PRIORITY_RANK: Record<Priority, number> = { P1: 0, P2: 1, P3: 2, CLEAR: 3 };
const RULES: Record<string, [Priority, string]> = {
  R1: ["P1", "Major severity recorded"], R2: ["P1", "Red-flag term in note"], R3: ["P1", "Pediatric signal or dosing request"],
  R4: ["P1", "Unresolved drug"], R5: ["P1", "Suspicious instructions in document"], R6: ["P2", "Moderate severity recorded"],
  R7: ["P2", "Hub drug (>=2 documented interactions)"], R8: ["P2", "Duplicate ingredient"], R9: ["P3", "Minor or Unknown severity only"],
};

function audit(s: Stored, event_type: string, entity: string, payload: Record<string, unknown>, actor = `user:${USER}`, at?: string) {
  s.audit.push({ seq: s.audit.length + 1, event_type, actor, entity, payload, kb_version: KB, timestamp: at ?? (seeding ? s.rx.created_at : nowIso()), correlation_id: cid() });
}

function review(action: ReviewActionType, note: string): Review {
  return { id: nextReview++, action, note, user: USER, kb_version_seen: KB, stale: false, created_at: nowIso() };
}

function runCheck(text: string, ageBand: string, note: string, createdAt?: string): Stored {
  const id = nextId++;
  const lines = text.split(/\r?\n/);
  const items: Item[] = [];
  const injectionPatterns: string[] = [];
  let lineNo = 0, ignored = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || /^rx\.?$/i.test(line) || /^note\s*:/i.test(line)) continue;
    const low = line.toLowerCase();
    const inj = INJECTION.filter((p) => low.includes(p));
    if (inj.length) {
      injectionPatterns.push(...inj);
      ignored++;
      continue;
    }
    lineNo++;
    const span = line.replace(/^\d+[.)]\s*/, "");
    const r = resolveLine(span);
    if (!r.drugs.length) {
      items.push({ id: nextItem++, line_no: lineNo, raw_span: span, matched_text: r.matched, drug_id: null, drug: null, product: null,
        is_synthetic: false, method: r.method, confidence: r.confidence, needs_confirmation: true, candidates: r.candidates, nlem_listed: null });
    }
    for (const did of r.drugs) {
      const d = drugById(did);
      items.push({ id: nextItem++, line_no: lineNo, raw_span: span, matched_text: r.matched, drug_id: did, drug: d.name,
        product: r.brand ?? null, is_synthetic: !!r.brand, method: r.method, confidence: r.confidence, needs_confirmation: false,
        candidates: [], nlem_listed: d.nlem });
    }
  }
  const s: Stored = { rx: null as unknown as Prescription, ownerNote: note, audit: [], asks: [] };
  s.rx = {
    id, session_id: id, status: "CHECKED", priority: "CLEAR", age_band: ageBand, note, raw_text: text, correlation_id: cid(),
    kb_version: KB, current_kb_version: KB, created_at: createdAt ?? nowIso(), injection_flag: injectionPatterns.length > 0,
    lines_ignored: ignored, items, findings: [], duplications: [], rule_hits: [], escalations: [], pairs_checked: 0,
    absent_pairs_count: 0, absent_pairs_wording: `No interaction recorded in DDInter (${KB})`,
    pairwise_notice: "DDInter is pairwise. This map makes no claim about combined effects of three or more drugs.",
    priority_notice: "Priority is a queue-ordering label, not a clinical risk score.", banners: [], explanation: null,
    reviews: [], llm_tokens_check: { input: 0, output: 0, calls: 0 },
  };
  (s.rx as any)._flags = { injectionPatterns: [...new Set(injectionPatterns)] };
  recompute(s, true);
  audit(s, "check_completed", `prescription:${id}`, { priority: s.rx.priority, findings: s.rx.findings.length }, "system");
  db.push(s);
  return s;
}

/** Re-derive findings, duplications, banners and priority from the current items (also after a confirmation). */
function recompute(s: Stored, fresh = false) {
  const rx = s.rx;
  const flags = (rx as any)._flags as { injectionPatterns: string[] };
  const ids = [...new Set(rx.items.filter((i) => i.drug_id).map((i) => i.drug_id!))].sort((a, b) => a - b);
  const prev = new Map(rx.findings.map((f) => [pairKey(f.drug_a_id, f.drug_b_id), f]));
  const findings: Finding[] = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const k = pairKey(ids[i], ids[j]);
      const sev = PAIRS[k];
      if (!sev) continue;
      const old = prev.get(k);
      const rule = sev === "Major" ? "R1" : sev === "Moderate" ? "R6" : "R9";
      findings.push(old ?? {
        id: nextFinding++, ordinal: 0, drug_a: drugById(ids[i]).name, drug_b: drugById(ids[j]).name, drug_a_id: ids[i], drug_b_id: ids[j],
        severity: sev, severity_label: `${sev} (as recorded in ${PAIR_SOURCE[k] ?? "DDInter"})`, source: PAIR_SOURCE[k] ?? "DDInter", source_record_id: `DEMO-${ids[i]}-${ids[j]}`,
        interaction_id: Number(`${ids[i]}${ids[j]}`), kb_version: KB, priority: RULES[rule][0], rule_id: rule,
        rule_description: RULES[rule][1], evidence_status: "PENDING", review_status: "pending", evidence: [], reviews: [],
      });
    }
  // hub rule R7: a drug with >= 2 documented interactions lifts its P3 findings to P2
  const degree = new Map<number, number>();
  findings.forEach((f) => [f.drug_a_id, f.drug_b_id].forEach((d) => degree.set(d, (degree.get(d) ?? 0) + 1)));
  for (const f of findings) {
    if (f.rule_id === "R9" && ((degree.get(f.drug_a_id) ?? 0) >= 2 || (degree.get(f.drug_b_id) ?? 0) >= 2)) {
      f.priority = "P2"; f.rule_id = "R7"; f.rule_description = RULES.R7[1];
    }
  }
  findings.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.drug_a.localeCompare(b.drug_a));
  findings.forEach((f, i) => (f.ordinal = i + 1));
  rx.findings = findings;

  // duplicate ingredients across different lines
  const byDrug = new Map<number, Item[]>();
  rx.items.filter((i) => i.drug_id).forEach((i) => byDrug.set(i.drug_id!, [...(byDrug.get(i.drug_id!) ?? []), i]));
  const dups: Duplication[] = [];
  byDrug.forEach((its, did) => {
    const lines = [...new Set(its.map((i) => i.line_no))];
    if (lines.length < 2) return;
    const old = rx.duplications.find((d) => d.drug === drugById(did).name);
    dups.push(old ?? { id: nextFinding++, drug: drugById(did).name, rule_id: "R8", reviews: [],
      item_labels: its.map((i) => `line ${i.line_no}: ${i.raw_span}`) });
  });
  rx.duplications = dups;

  const note = rx.note.toLowerCase();
  const redFlags = RED_FLAGS.filter((t) => note.includes(t));
  const dosing = /how much|what dose|dosage|how many (tablets|ml|times)/.test(note);
  const pediatric = rx.age_band === "<12";
  const unresolved = rx.items.filter((i) => !i.drug_id && i.method !== "pharmacist");

  const hits: Prescription["rule_hits"] = [];
  findings.forEach((f) => hits.push({ rule_id: f.rule_id, priority: f.priority, description: RULES[f.rule_id][1], input: `${f.drug_a} + ${f.drug_b}`, result: `${f.severity} (DDInter)` }));
  dups.forEach((d) => hits.push({ rule_id: "R8", priority: "P2", description: RULES.R8[1], input: d.drug, result: "P2 (duplicate ingredient)" }));
  unresolved.forEach((u) => hits.push({ rule_id: "R4", priority: "P1", description: RULES.R4[1], input: `line ${u.line_no}: '${u.raw_span}'`, result: "P1 (needs confirmation)" }));
  if (redFlags.length) hits.push({ rule_id: "R2", priority: "P1", description: RULES.R2[1], input: redFlags.join(", "), result: "P1 (red flag escalated)" });
  if (pediatric || dosing) hits.push({ rule_id: "R3", priority: "P1", description: RULES.R3[1], input: [pediatric && "age <12", dosing && "dosing request"].filter(Boolean).join("; "), result: "P1" });
  if (flags.injectionPatterns.length) hits.push({ rule_id: "R5", priority: "P1", description: RULES.R5[1], input: flags.injectionPatterns.join(", "), result: "P1 (instructions ignored)" });
  rx.rule_hits = hits;
  rx.priority = hits.reduce<Priority>((p, h) => (PRIORITY_RANK[h.priority] < PRIORITY_RANK[p] ? h.priority : p), "CLEAR");

  const banners: Prescription["banners"] = [];
  if (flags.injectionPatterns.length) banners.push({ kind: "INJECTION", text: INJECTION_BANNER, patterns: flags.injectionPatterns });
  if (redFlags.length) banners.push({ kind: "RED_FLAG", text: "Red-flag terms detected and escalated. Findings are still shown.", terms: redFlags });
  if (dosing) banners.push({ kind: "DOSING", text: DOSING_REFUSAL });
  if (pediatric) banners.push({ kind: "PEDIATRIC", text: "Pediatric signal. Escalated for pharmacist review." });
  if (unresolved.length) banners.push({ kind: "UNRESOLVED", text: `${unresolved.length} item(s) could not be verified. Pharmacist confirmation required.` });
  rx.banners = banners;

  const pairs = (ids.length * (ids.length - 1)) / 2;
  rx.pairs_checked = pairs;
  rx.absent_pairs_count = pairs - findings.length;

  if (fresh) {
    const esc: [string, string, string][] = [];
    findings.filter((f) => f.severity === "Major").forEach((f) => esc.push(["MAJOR_INTERACTION", "R1", `${f.drug_a} + ${f.drug_b}`]));
    if (redFlags.length) esc.push(["RED_FLAG", "R2", redFlags.join(", ")]);
    if (pediatric) esc.push(["PEDIATRIC", "R3", "age band <12"]);
    if (dosing) esc.push(["DOSING_REQUEST", "R3", "dosing question in note"]);
    unresolved.forEach((u) => esc.push(["UNRESOLVED_DRUG", "R4", u.raw_span]));
    if (flags.injectionPatterns.length) esc.push(["PROMPT_INJECTION", "R5", flags.injectionPatterns.join(", ")]);
    rx.escalations = esc.map(([reason_code, trigger_rule_id, detail]) => ({ id: nextEsc++, reason_code, trigger_rule_id, detail, created_by: "system" }));
    rx.status = rx.priority === "CLEAR" ? "CLEAR" : "AWAITING_PHARMACIST";
  }
}

function runExplain(s: Stored) {
  const rx = s.rx;
  const claims: Claim[] = [];
  let n = 1;
  for (const f of rx.findings) {
    const k = pairKey(f.drug_a_id, f.drug_b_id);
    claims.push({
      claim_id: `t${f.ordinal}`, text: `DDInter records ${f.drug_a} and ${f.drug_b} as a ${f.severity} interaction.`, source_type: "DATABASE",
      kept: true, drop_reason: "", support_score: null, support_span: "", finding_ordinal: f.ordinal, badge: "DATABASE FACT",
      generated_by: "template (no LLM)",
      database_record: { interaction_id: f.interaction_id, drug_a: f.drug_a, drug_b: f.drug_b, severity: f.severity, source: "DDInter",
        source_record_id: f.source_record_id, kb_version: KB },
    });
    const ev = EVIDENCE[k];
    if (ev) {
      f.evidence = ev.cards.map((c) => ({ ...c, chunk_id: nextChunk++, support_span: ev.span ?? "" }));
      f.evidence_status = "FOUND";
      delete f.evidence_message;
      if (ev.claim)
        claims.push({ claim_id: `c${n++}`, text: ev.claim, source_type: "RAG_CHUNK", kept: true, drop_reason: "", support_score: 0.82,
          support_span: ev.span ?? "", finding_ordinal: f.ordinal, badge: "AI EXPLANATION — VERIFIED", chunk: f.evidence[0] });
    } else {
      f.evidence = [];
      f.evidence_status = "INSUFFICIENT";
      f.evidence_message = INSUFFICIENT;
    }
  }
  rx.explanation = { id: rx.id, mode: "llm", mode_badge: "AI EXPLANATION — VERIFIED", model: "offline demo", prompt_version: "explanation_claims@v1",
    fallback_level: 0, degraded_retrieval: false, correlation_id: cid(), claims, dropped: [] };
  if (rx.status === "CHECKED") rx.status = "EXPLAINED";
  audit(s, "explanation_generated", `prescription:${rx.id}`, { claims: claims.length, mode: "llm" }, "system");
}

function queueRow(s: Stored): QueueRow {
  const rx = s.rx;
  return { id: rx.id, status: rx.status, priority: rx.priority, created_at: rx.created_at, interaction_count: rx.findings.length,
    unresolved_count: rx.items.filter((i) => !i.drug_id && i.method !== "pharmacist").length, escalation_count: rx.escalations.length,
    reviewed_count: rx.findings.filter((f) => f.review_status !== "pending").length, injection_flag: rx.injection_flag, kb_version: KB,
    first_line: (rx.raw_text ?? "").trim().split("\n")[0].slice(0, 80) };
}

function find(id: number) {
  return db.find((s) => s.rx.id === id) ?? fail(404, "not_found", "Prescription not found");
}

function gateReasons(rx: Prescription) {
  const r: string[] = [];
  rx.findings.filter((f) => f.priority === "P1" && !f.reviews.length).forEach((f) => r.push(`Finding ${f.ordinal} (${f.drug_a} + ${f.drug_b}) has no pharmacist action`));
  rx.items.filter((i) => !i.drug_id && i.method !== "pharmacist").forEach((i) => r.push(`Line ${i.line_no} ('${i.raw_span}') is not confirmed`));
  return r;
}

const snapshot = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const view = (s: Stored) => {
  const out = snapshot(s.rx) as any;
  delete out._flags;
  return out as Prescription;
};

async function sha256(text: string): Promise<string> {
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16).padStart(8, "0").repeat(8);
  }
}

async function chained(s: Stored): Promise<AuditEntry[]> {
  let prev = "0".repeat(64);
  const out: AuditEntry[] = [];
  for (const e of s.audit) {
    const hash = await sha256(prev + JSON.stringify(e));
    out.push({ ...e, prev_hash: prev, hash });
    prev = hash;
  }
  return out;
}

function ask(s: Stored, q: string): AskResult {
  const low = q.toLowerCase();
  const rx = s.rx;
  if (/\b(dose|dosage|how much|how many|mg should)\b/.test(low))
    return { answer: DOSING_REFUSAL, mode: "refusal", escalations: [{ reason_code: "DOSING_REQUEST", rule_id: "R3" }] };
  if (/(safe to (give|dispense)|should i (give|dispense)|can i dispense|approve)/.test(low))
    return { answer: DECISION_REFUSAL, mode: "refusal" };
  const words = ["first", "second", "third", "fourth", "fifth"];
  let ord = Number(low.match(/finding\s*#?(\d+)/)?.[1] ?? 0);
  if (!ord) ord = words.findIndex((w) => low.includes(`${w} one`) || low.includes(`${w} finding`)) + 1;
  let f = ord ? rx.findings.find((x) => x.ordinal === ord) : undefined;
  if (!f) f = rx.findings.find((x) => low.includes(x.drug_a.toLowerCase()) || low.includes(x.drug_b.toLowerCase()) ||
    (x.drug_a === "Acetylsalicylic acid" && low.includes("aspirin")) || (x.drug_b === "Acetylsalicylic acid" && low.includes("aspirin")));
  if (f) {
    const ev = f.evidence[0];
    const answer = `Finding ${f.ordinal} (${f.drug_a} + ${f.drug_b}) was flagged because DDInter records it as a ${f.severity} interaction, which triggers rule ${f.rule_id} (${f.rule_description}).` +
      (ev ? ` Supporting passage: ${ev.document}, ${ev.section}.` : " No guideline passage about this pair was retrieved.");
    return { answer, mode: "template", claims: [{ claim_id: "c1", text: answer, source_type: "DATABASE", source_id: f.interaction_id }],
      tool_trace: [{ tool: "get_finding", args: { finding_ordinal: f.ordinal }, status: "ok", result: `finding ${f.ordinal}: ${f.drug_a} + ${f.drug_b} (${f.severity})` }] };
  }
  return { answer: INSUFFICIENT, mode: "insufficient", tool_trace: [{ tool: "guideline_search", args: { query: q.slice(0, 60) }, status: "ok", result: "0 chunks above threshold" }] };
}

// ------------------------------------------------------------------ seed data
const day = (d: number, h = 10, m = 0) => {
  const t = new Date();
  t.setDate(t.getDate() - d);
  t.setHours(h, m, 0, 0);
  return t.toISOString();
};

const SEED: { patient: number; text: string; age: string; note: string; at: string; explain: boolean; complete?: boolean }[] = [
  { patient: 0, at: day(34, 11, 20), age: "65+", note: "", explain: true, complete: true,
    text: "Rx\n1. Tab Synwarf 5 mg OD\n2. Tab Synamlo 5 mg OD" },
  { patient: 1, at: day(6, 16, 5), age: "18-64", note: "", explain: true, complete: true,
    text: "Rx\n1. Tab Amlodipine 5 mg OD\n2. Tab Atorvastatin 10 mg HS" },
  { patient: 2, at: day(1, 9, 40), age: "18-64", note: "", explain: true,
    text: "Rx\n1. Tab Simvastatin 20 mg HS\n2. Tab Clarithromycin 500 mg BD x 7 days" },
  { patient: 3, at: day(0, 8, 55), age: "18-64", note: "Patient reports chest pain since morning", explain: true,
    text: "Rx\n1. Tab Synclot 75 mg OD\n2. Cap Omeprazole 20 mg OD before food" },
  { patient: 0, at: day(0, 10, 15), age: "65+", note: "", explain: false,
    text: "Rx\n1. Tab Synwarf 5 mg OD\n2. Tab Aspirin 75 mg OD after food\n3. Tab Fluconazole 150 mg once weekly\n4. Tab Paracetamol 500 mg TDS\n5. Tab Synpara 650 SOS\n6. Tab amlodipne 5 mg OD\n7. Cap Zyntrofex 20 mg OD" },
];

const PEOPLE: Omit<Patient, "checks">[] = [
  { id: "demo-p1", name: "Lakshmi Menon", age: 68, sex: "Female", uhid: "VAST-10412", createdAt: day(120) },
  { id: "demo-p2", name: "Fathima Rasheed", age: 59, sex: "Female", uhid: "VAST-10377", createdAt: day(60) },
  { id: "demo-p3", name: "Anjali Nair", age: 41, sex: "Female", uhid: "VAST-10508", createdAt: day(20) },
  { id: "demo-p4", name: "Rahul Verma", age: 54, sex: "Male", uhid: "VAST-10511", createdAt: day(3) },
  { id: "demo-p5", name: "Arjun Krishnan", age: 8, sex: "Male", uhid: "VAST-10530", createdAt: day(2) },
];

export const DEMO_PATIENTS: Patient[] = PEOPLE.map((p) => ({ ...p, checks: [] }));

for (const sd of SEED) {
  const s = runCheck(sd.text, sd.age, sd.note, sd.at);
  if (sd.explain) runExplain(s);
  if (sd.complete) {
    s.rx.findings.forEach((f) => { f.reviews.push({ ...review("ACKNOWLEDGE", "Counselled patient; prescriber aware."), created_at: sd.at }); f.review_status = "ACKNOWLEDGE"; });
    s.rx.status = "REVIEWED";
    audit(s, "review_completed", `prescription:${s.rx.id}`, {});
  }
  DEMO_PATIENTS[sd.patient].checks.push({ rxId: s.rx.id, createdAt: sd.at, priority: s.rx.priority,
    medicines: [...new Set(s.rx.items.filter((i) => i.drug).map((i) => i.drug!))] });
}

seeding = false;

// ------------------------------------------------------------------ reference data imports (demo)
const INT_TEMPLATE = "drug_a,drug_b,severity,notes\nWarfarin,Tramadol,Moderate,Elevated INR and increased bleeding risk\nAtorvastatin,Clarithromycin,Major,Higher statin exposure\n";
const GUIDE_TEMPLATE = "section,text,drugs\nHematology - Warfarin potentiation,Tramadol may enhance the anticoagulant effect of Warfarin. Monitor INR closely after starting.,\"Warfarin, Tramadol\"\n";
let addedDrugs = 0, addedPairs = 0, addedDocs = 0;

async function fileText(form: FormData) {
  const f = form.get("file") as File | null;
  return f ? await f.text() : String(form.get("csv_text") ?? "");
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cur = "", q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) { cells.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  return rows;
}

function drugFor(name: string): { d: DemoDrug; created: boolean } {
  const n = norm(name);
  const hit = DRUGS.find((d) => d.aliases.includes(n));
  if (hit) return { d: hit, created: false };
  const d: DemoDrug = { id: 200 + DRUGS.length, name: name.replace(/\b\w/g, (c) => c.toUpperCase()), aliases: [n], nlem: null };
  DRUGS.push(d);
  ALIASES.push({ text: n, drugs: [d.id] });
  addedDrugs++;
  return { d, created: true };
}

const SEV_WORDS: Record<string, Severity> = { major: "Major", severe: "Major", high: "Major", contraindicated: "Major", moderate: "Moderate",
  medium: "Moderate", monitor: "Moderate", minor: "Minor", low: "Minor", unknown: "Unknown" };

function importInteractions(text: string, source: string) {
  const rows = csvRows(text);
  if (!rows.length) fail(400, "invalid_input", "CSV file is empty");
  const head = rows[0].map((h) => h.toLowerCase());
  const ia = head.findIndex((h) => h === "drug_a" || h === "drug1"), ib = head.findIndex((h) => h === "drug_b" || h === "drug2");
  const is = head.indexOf("severity"), inotes = head.indexOf("notes");
  if (ia < 0 || ib < 0) fail(400, "invalid_input", "CSV must contain columns for both drugs (e.g., 'drug_a,drug_b,severity')");
  let added = 0, updated = 0, created = 0;
  const sample: { drug_a: string; drug_b: string; severity: string; status: string; notes?: string }[] = [];
  for (const r of rows.slice(1)) {
    if (!r[ia] || !r[ib]) continue;
    const a = drugFor(r[ia]), b = drugFor(r[ib]);
    created += Number(a.created) + Number(b.created);
    const sev = SEV_WORDS[(r[is] ?? "").toLowerCase()] ?? "Unknown";
    const k = pairKey(a.d.id, b.d.id);
    const status = PAIRS[k] ? "updated" : "added";
    if (PAIRS[k]) updated++; else { added++; addedPairs++; }
    PAIRS[k] = sev;
    PAIR_SOURCE[k] = source;
    if (sample.length < 8) sample.push({ drug_a: a.d.name, drug_b: b.d.name, severity: sev, status, notes: inotes >= 0 ? r[inotes] : undefined });
  }
  return { status: "success", kb_version: KB, total_rows_parsed: rows.length - 1, added_interactions: added, updated_interactions: updated,
    new_drugs_created: created, total_interactions_now: 160235 + addedPairs, sample };
}

function importGuideline(text: string, title: string, docType: string, source: string, version: string) {
  if (!text.trim()) fail(400, "invalid_input", "No guideline file or text provided");
  const rows = csvRows(text);
  const isCsv = rows[0]?.map((h) => h.toLowerCase()).join(",").startsWith("section,text");
  const parts = isCsv
    ? rows.slice(1).map((r) => ({ section: r[0], body: r[1] ?? "", drugs: (r[2] ?? "").split(/[;,]/).map((x) => x.trim()).filter(Boolean) }))
    : text.split(/\n\s*\n/).map((body, i) => ({ section: `Part ${i + 1}`, body: body.trim(), drugs: [] as string[] }));
  let mentions = 0;
  const sample: { section: string; text_preview: string; drugs_tagged: string[] }[] = [];
  for (const part of parts) {
    if (!part.body) continue;
    const named = new Set(part.drugs.map((d) => drugFor(d).d));
    DRUGS.forEach((d) => { if (d.aliases.some((a) => norm(part.body).includes(a))) named.add(d); });
    const tagged = [...named];
    mentions += tagged.length;
    for (let i = 0; i < tagged.length; i++)
      for (let j = i + 1; j < tagged.length; j++) {
        const k = pairKey(tagged[i].id, tagged[j].id);
        const card = { document: title, doc_type: docType, source, version, license: `${source} (uploaded by pharmacist)`, url: "",
          section: part.section, page: null, file_name: `${title.toLowerCase().replace(/\s+/g, "_")}.csv`, text: part.body, score: null,
          retrieval_mode: "hybrid", matched_via: Object.fromEntries([tagged[i], tagged[j]].map((d) => [d.name, "direct"])),
          label: "SOURCE TEXT (retrieved, not AI-generated)" };
        EVIDENCE[k] = { cards: [...(EVIDENCE[k]?.cards ?? []), card], claim: EVIDENCE[k]?.claim, span: EVIDENCE[k]?.span };
      }
    if (sample.length < 6) sample.push({ section: part.section, text_preview: part.body.slice(0, 120) + "...", drugs_tagged: tagged.map((d) => d.name).slice(0, 6) });
  }
  addedDocs++;
  return { status: "success", document_id: 900 + addedDocs, document_title: title, doc_type: docType, chunks_created: parts.length,
    drug_mentions_tagged: mentions, sample_chunks: sample };
}

// ------------------------------------------------------------------ router
export async function mockApi(path: string, opts: { method?: string; body?: unknown; form?: FormData }): Promise<unknown> {
  const url = new URL(path, "http://demo");
  const p = url.pathname.replace(/^\/api\/v1/, "");
  const body = (opts.body ?? {}) as any;
  const method = opts.method ?? (opts.body !== undefined || opts.form ? "POST" : "GET");
  await sleep(p === "/explain" ? 1400 : p === "/check" ? 650 : p === "/translate" ? 500 : 160);
  let m: RegExpMatchArray | null;

  if (p === "/auth/token") {
    if (!body.username || !body.password) fail(401, "invalid_credentials", "Invalid username or password");
    return { token: "demo-token", username: body.username, is_admin: false };
  }
  if (p === "/me") return { username: USER, is_admin: false, demo_toggles_enabled: false, kb_version: KB };
  if (p === "/check") {
    let text = body.text, age = body.age_band ?? "unknown", note = body.note ?? "";
    if (opts.form) {
      const f = opts.form.get("file") as File | null;
      age = String(opts.form.get("age_band") ?? "unknown");
      note = String(opts.form.get("note") ?? "");
      if (f) {
        if (f.name.toLowerCase().endsWith(".pdf")) fail(400, "invalid_input", "PDF reading needs the live backend; paste the text instead in the demo.");
        text = await f.text();
      }
    }
    if (!text || !String(text).trim()) fail(400, "invalid_input", "Prescription text is empty");
    return view(runCheck(String(text), age, note));
  }
  if (p === "/explain") {
    const s = find(Number(body.prescription_id));
    runExplain(s);
    return view(s);
  }
  if (p === "/prescriptions") {
    const open: Record<string, number> = { AWAITING_PHARMACIST: 0, IN_REVIEW: 1, CHECKED: 2, EXPLAINED: 2, REVIEWED: 3, CLEAR: 4 };
    return { results: db.map(queueRow).sort((a, b) => (open[a.status] ?? 5) - (open[b.status] ?? 5) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.id - a.id) };
  }
  if ((m = p.match(/^\/prescriptions\/(\d+)$/))) return view(find(Number(m[1])));
  if ((m = p.match(/^\/prescriptions\/(\d+)\/complete$/))) {
    const s = find(Number(m[1]));
    const reasons = gateReasons(s.rx);
    if (reasons.length) fail(409, "review_gate_not_met", "Every P1 finding needs a recorded pharmacist action and every unresolved item needs confirmation first.", { reasons });
    s.rx.status = "REVIEWED";
    audit(s, "review_completed", `prescription:${s.rx.id}`, {});
    return view(s);
  }
  if ((m = p.match(/^\/prescriptions\/(\d+)\/items\/(\d+)\/confirm$/))) {
    const s = find(Number(m[1]));
    const it = s.rx.items.find((i) => i.id === Number(m![2])) ?? fail(404, "not_found", "Item not found");
    if (body.drug_id) {
      const d = drugById(Number(body.drug_id));
      Object.assign(it, { drug_id: d.id, drug: d.name, method: "pharmacist", needs_confirmation: false, nlem_listed: d.nlem, confidence: null });
    } else Object.assign(it, { method: "pharmacist", needs_confirmation: false });
    recompute(s);
    s.rx.escalations = s.rx.escalations.filter((e) => !(e.reason_code === "UNRESOLVED_DRUG" && e.detail === it.raw_span));
    if (s.rx.explanation) runExplain(s);
    audit(s, "item_confirmed", `item:${it.id}`, { drug_id: body.drug_id ?? null, not_in_database: !!body.not_in_database });
    return view(s);
  }
  if ((m = p.match(/^\/reviews\/(\d+)$/))) {
    const id = Number(m[1]);
    const s = db.find((x) => x.rx.findings.some((f) => f.id === id) || x.rx.duplications.some((d) => d.id === id)) ?? fail(404, "not_found", "Finding not found");
    const target = body.target === "duplication" ? s.rx.duplications.find((d) => d.id === id) : s.rx.findings.find((f) => f.id === id);
    if (!target) fail(404, "not_found", "Finding not found");
    const r = review(body.action, body.note ?? "");
    target.reviews.push(r);
    if ("review_status" in target) target.review_status = body.action;
    if (body.action === "ESCALATE") s.rx.escalations.push({ id: nextEsc++, reason_code: "PHARMACIST_ESCALATION", trigger_rule_id: "", detail: body.note || "Escalated by pharmacist", created_by: `user:${USER}` });
    if (s.rx.status !== "REVIEWED") s.rx.status = "IN_REVIEW";
    audit(s, "review_recorded", `finding:${id}`, { action: body.action, note: body.note ?? "" });
    return view(s);
  }
  if ((m = p.match(/^\/findings\/(\d+)$/))) {
    const id = Number(m[1]);
    const s = db.find((x) => x.rx.findings.some((f) => f.id === id)) ?? fail(404, "not_found", "Finding not found");
    const f = s.rx.findings.find((x) => x.id === id)!;
    const claims = (s.rx.explanation?.claims ?? []).filter((c) => c.finding_ordinal === f.ordinal);
    return {
      finding: f, prescription_id: s.rx.id,
      database_record: { interaction_id: f.interaction_id, drug_a: f.drug_a, drug_a_ddinter_id: `DEMO${f.drug_a_id}`, drug_b: f.drug_b,
        drug_b_ddinter_id: `DEMO${f.drug_b_id}`, severity: f.severity, source: f.source, source_record_id: f.source_record_id, kb_version: KB, table: "drug_interactions",
        source_file: f.source === "DDInter" ? "ddinter_downloads_code_B.csv (DDInter 1.0 Dataset, demo subset)" : `${f.source}.csv` },
      sources: [{ name: "DDInter 1.0 (demo subset)", version: "1.0", license: "Academic / non-commercial (verify before other use)", url: "http://ddinter.scbdd.com/", retrieved_at: "2026-09-30", checksum: "demo" }],
      explanation: s.rx.explanation ? { id: s.rx.explanation.id, mode: s.rx.explanation.mode, model: s.rx.explanation.model, prompt_version: s.rx.explanation.prompt_version, correlation_id: s.rx.explanation.correlation_id, fallback_level: 0 } : null,
      claims_kept: claims, claims_dropped: [], check_correlation_id: s.rx.correlation_id,
    };
  }
  if ((m = p.match(/^\/audit\/(\d+)\/verify$/))) {
    const s = find(Number(m[1]));
    const rows = await chained(s);
    return { prescription_id: s.rx.id, status: "VALID", entries_checked: rows.length, head_hash: rows[rows.length - 1]?.hash ?? "" };
  }
  if ((m = p.match(/^\/audit\/(\d+)$/))) {
    const s = find(Number(m[1]));
    const entries = await chained(s);
    return { total: entries.length, page: 1, page_size: 200, entries };
  }
  if ((m = p.match(/^\/sessions\/(\d+)$/))) {
    const s = find(Number(m[1]));
    return { session_id: s.rx.id, messages: s.asks.map((a) => ({ role: a.role, content: a.content, payload: a.payload ?? {}, prescription_id: s.rx.id })) };
  }
  if (p === "/ask") {
    const s = find(Number(body.session_id));
    const r = ask(s, String(body.question ?? ""));
    s.asks.push({ role: "user", content: body.question }, { role: "assistant", content: r.answer, payload: r });
    return r;
  }
  if (p === "/escalations" && method === "POST") {
    const s = find(Number(body.prescription_id));
    const e = { id: nextEsc++, reason_code: body.reason_code, trigger_rule_id: body.trigger_rule_id ?? "", detail: body.detail ?? "", created_by: `user:${USER}` };
    s.rx.escalations.push(e);
    audit(s, "escalation_raised", `escalation:${e.id}`, { reason_code: e.reason_code, detail: e.detail });
    return e;
  }
  if (p === "/drugs/search") {
    const q = norm(url.searchParams.get("q") ?? "");
    if (q.length < 2) return { results: [] };
    const seen = new Set<number>();
    const out: { drug_id: number; name: string; score: number; nlem_listed: boolean | null }[] = [];
    for (const d of DRUGS) if (d.aliases.some((a) => a.startsWith(q))) { seen.add(d.id); out.push({ drug_id: d.id, name: d.name, score: 100, nlem_listed: d.nlem }); }
    const fz = DRUGS.map((d) => ({ d, s: Math.max(...d.aliases.map((a) => ratio(q, a.slice(0, Math.max(q.length, 4))))) }))
      .filter((x) => x.s >= 70 && !seen.has(x.d.id)).sort((a, b) => b.s - a.s);
    fz.forEach((x) => out.push({ drug_id: x.d.id, name: x.d.name, score: x.s, nlem_listed: null }));
    return { results: out.slice(0, 10) };
  }
  if (p === "/translate") {
    const lang = body.lang as "ml" | "hi";
    return { lang, model: "offline demo", translations: (body.texts as string[]).map((t) => {
      const hit = DEMO_TRANSLATIONS[t]?.[lang];
      return hit ? { text: hit, status: "ok" } : { text: null, status: "unavailable", reason: "The offline demo has translations for its sample passages only." };
    }) };
  }
  if (p === "/kb/templates") return { interactions_template: INT_TEMPLATE, guidelines_template: GUIDE_TEMPLATE };
  if (p === "/kb/interactions/upload") return importInteractions(opts.form ? await fileText(opts.form) : String(body.csv_text ?? ""),
    String((opts.form ? opts.form.get("source") : body.source) ?? "").trim() || "Pharmacist_Upload");
  if (p === "/kb/guidelines/upload") {
    const get = (k: string) => String((opts.form ? opts.form.get(k) : body[k]) ?? "").trim();
    return importGuideline(opts.form ? await fileText(opts.form) : String(body.csv_text ?? ""), get("title") || "Hospital Clinical Guideline",
      get("doc_type") || "GUIDELINE", get("source") || "Pharmacist_Upload", get("version") || "2026.10");
  }
  if (p === "/kb") return {
    kb_version: KB, loaded_at: "2026-10-01T09:12:00Z",
    counts: { drugs: 1939 + addedDrugs, aliases: 4120 + addedDrugs, interactions: 160235 + addedPairs, documents: 14 + addedDocs },
    sources: [
      { name: "DDInter 1.0", version: "1.0", license: "No licence text on the download page; treated as academic / non-commercial", url: "http://ddinter.scbdd.com/", retrieved_at: "2026-09-30", is_synthetic: false, notes: "Interaction existence and severity" },
      { name: "NLEM 2022", version: "2022", license: "Government of India publication", url: "https://main.mohfw.gov.in/", retrieved_at: "2026-09-30", is_synthetic: false, notes: "Essential-medicine fields and RAG chunks" },
      { name: "ICMR Standard Treatment Workflows", version: "13 documents", license: "© ICMR and DHR, MoHFW", url: "https://www.icmr.gov.in/standard-treatment-workflows-stws", retrieved_at: "2026-09-30", is_synthetic: false, notes: "RAG corpus" },
      { name: "Synthetic brands", version: "1", license: "Project data", url: "", retrieved_at: "2026-09-30", is_synthetic: true, notes: "Fictional brand names for the demo" },
    ],
  };
  if (p === "/metrics/latency") return { endpoints: {}, targets: { "/api/v1/check": { p95_ms: 1500 }, "/api/v1/explain": { p95_ms: 8000 } } };
  fail(404, "not_found", `No demo handler for ${p}`);
}
