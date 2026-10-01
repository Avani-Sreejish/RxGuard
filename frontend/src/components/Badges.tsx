import { useI18n } from "../i18n";
import type { Priority } from "../types";

export function PriorityPill({ p }: { p: Priority }) {
  const { t } = useI18n();
  return <span className={`pill prio-${p}`}>{t(`prio.${p}`)}</span>;
}

export function SeverityPill({ s }: { s: string }) {
  const { t } = useI18n();
  return <span className={`pill sev-${s}`}>{t(`sev.${s}`)}</span>;
}

export function StatusText({ s }: { s: string }) {
  const { t } = useI18n();
  const done = s === "REVIEWED" || s === "CLEAR";
  return (
    <span className={`status ${done ? "done" : "open"}`}>
      <span className="dot" aria-hidden />
      {t(`status.${s}`)}
    </span>
  );
}

export function Tag({ children, tone = "plain", title }: { children: React.ReactNode; tone?: "plain" | "brand" | "warn" | "muted"; title?: string }) {
  return (
    <span className={`tag tag-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner" role="status" aria-label={label ?? "Loading"}>
      <span />
    </span>
  );
}

export function fmtDateTime(iso: string, lang: string) {
  const d = new Date(iso);
  const loc = lang === "ml" ? "ml-IN" : lang === "hi" ? "hi-IN" : "en-IN";
  return d.toLocaleString(loc, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function fmtDate(iso: string, lang: string) {
  const d = new Date(iso);
  const loc = lang === "ml" ? "ml-IN" : lang === "hi" ? "hi-IN" : "en-IN";
  return d.toLocaleDateString(loc, { day: "numeric", month: "short", year: "numeric" });
}
