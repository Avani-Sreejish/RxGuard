// Patient register.
// RxGuard's backend deliberately stores no patient identity: it receives only the age band. Patient details
// come from the pharmacy's billing/dispensing system; this register is the front-end stand-in for that feed
// and links each check (prescription id) to a patient so the pharmacist can see their history.
// It lives in this browser's storage. Replace load/save with the billing-system API when integrating.
import { isDemo } from "./api";
import { DEMO_PATIENTS } from "./mock";

export type Sex = "Female" | "Male" | "Other";

export interface RxLink {
  rxId: number;
  createdAt: string;
  medicines: string[]; // resolved generic names at check time (for "previously dispensed")
  priority?: string;
}

export interface Patient {
  id: string;
  name: string;
  age: number;
  sex: Sex;
  uhid: string; // hospital ID / bill number from the billing system
  createdAt: string;
  checks: RxLink[];
}

const key = () => (isDemo() ? "rxguard.patients.demo.v1" : "rxguard.patients.v1");
let cache: { key: string; list: Patient[] } | null = null;
const listeners = new Set<() => void>();

function load(): Patient[] {
  const k = key();
  if (cache?.key === k) return cache.list;
  let list: Patient[] | null = null;
  try {
    const raw = localStorage.getItem(k);
    if (raw) list = JSON.parse(raw);
  } catch {
    list = null;
  }
  if (!list) list = isDemo() ? structuredClone(DEMO_PATIENTS) : [];
  cache = { key: k, list };
  return list;
}

function save(list: Patient[]) {
  cache = { key: key(), list };
  try {
    localStorage.setItem(key(), JSON.stringify(list));
  } catch {
    /* in-memory only */
  }
  listeners.forEach((f) => f());
}

export function subscribe(f: () => void) {
  listeners.add(f);
  return () => listeners.delete(f);
}

export function resetCache() {
  cache = null;
}

export function listPatients(): Patient[] {
  return [...load()].sort((a, b) => lastSeen(b).localeCompare(lastSeen(a)));
}

export function lastSeen(p: Patient): string {
  return p.checks.length ? p.checks[p.checks.length - 1].createdAt : p.createdAt;
}

export function getPatient(id: string | null | undefined): Patient | undefined {
  return id ? load().find((p) => p.id === id) : undefined;
}

export function patientForRx(rxId: number): Patient | undefined {
  return load().find((p) => p.checks.some((c) => c.rxId === rxId));
}

export function addPatient(input: Omit<Patient, "id" | "createdAt" | "checks">): Patient {
  const p: Patient = {
    ...input,
    id: crypto.randomUUID?.() ?? String(Date.now()),
    createdAt: new Date().toISOString(),
    checks: [],
  };
  save([...load(), p]);
  return p;
}

export function updatePatient(id: string, patch: Partial<Omit<Patient, "id" | "checks">>) {
  save(load().map((p) => (p.id === id ? { ...p, ...patch } : p)));
}

export function linkCheck(patientId: string, link: RxLink) {
  save(load().map((p) => (p.id === patientId ? { ...p, checks: [...p.checks.filter((c) => c.rxId !== link.rxId), link] } : p)));
}

export function updateCheck(rxId: number, patch: Partial<RxLink>) {
  const list = load();
  const owner = list.find((p) => p.checks.some((c) => c.rxId === rxId));
  if (!owner) return;
  const c = owner.checks.find((x) => x.rxId === rxId)!;
  if (Object.entries(patch).every(([k, v]) => JSON.stringify((c as any)[k]) === JSON.stringify(v))) return;
  save(list.map((p) => (p.id !== owner.id ? p : { ...p, checks: p.checks.map((x) => (x.rxId === rxId ? { ...x, ...patch } : x)) })));
}

/** The backend's age bands (engine/schemas.py AgeBand). Age drives the pediatric rule R3. */
export function ageBand(age: number | null | undefined): "<12" | "12-17" | "18-64" | "65+" | "unknown" {
  if (age === null || age === undefined || Number.isNaN(age)) return "unknown";
  if (age < 12) return "<12";
  if (age < 18) return "12-17";
  if (age < 65) return "18-64";
  return "65+";
}
