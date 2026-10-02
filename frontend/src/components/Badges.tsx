import type { Priority } from "../types";

export const DbFact = () => <span className="badge db">DATABASE FACT</span>;
export const AiVerified = () => <span className="badge ai">AI EXPLANATION — VERIFIED</span>;
export const Insufficient = () => <span className="badge insuff">INSUFFICIENT EVIDENCE</span>;
export const Escalation = ({ code }: { code?: string }) => (
  <span className="badge esc">ESCALATION{code ? ` · ${code}` : ""}</span>
);
export const Unresolved = () => <span className="badge unres">UNRESOLVED</span>;
export const Synthetic = () => <span className="badge synth">SYNTHETIC DEMO DATA</span>;
export const Template = () => <span className="badge tpl">TEMPLATE MODE (no LLM)</span>;
export const Degraded = () => <span className="badge degraded">DEGRADED RETRIEVAL (FULLTEXT)</span>;

export function Prio({ p, rule, title }: { p: Priority; rule?: string; title?: string }) {
  return (
    <span className={`pill prio-${p}`} title={title ?? "Queue-ordering label, not a clinical risk score"}>
      {p}
      {rule ? ` · ${rule}` : ""}
    </span>
  );
}

export function Sev({ s }: { s: string }) {
  return <span className={`pill sev-${s}`}>{s}</span>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner" role="status" aria-label={label ?? "Loading"}>
      <span />
    </span>
  );
}

export function Highlight({ text, span }: { text: string; span?: string }) {
  if (!span) return <>{text}</>;
  const i = text.indexOf(span);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{span}</mark>
      {text.slice(i + span.length)}
    </>
  );
}
