// Machine translation of retrieved text (guideline passages, AI claims, follow-up answers).
// The English original is always shown first; the translation sits under it, labelled.
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { fixedSentenceKey, useI18n } from "../i18n";
import type { Lang, TranslateResult } from "../types";

type Entry = { state: "busy" } | { state: "ok"; text: string } | { state: "rejected" } | { state: "unavailable" };

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
const k = (lang: Lang, text: string) => `${lang}\u0000${text}`;

async function fetchBatch(lang: Lang, texts: string[]) {
  texts.forEach((t) => cache.set(k(lang, t), { state: "busy" }));
  listeners.forEach((f) => f());
  for (let i = 0; i < texts.length; i += 8) {
    const batch = texts.slice(i, i + 8);
    try {
      const r = await api<TranslateResult>("/api/v1/translate", { body: { lang, texts: batch } });
      batch.forEach((t, j) => {
        const tr = r.translations[j];
        cache.set(k(lang, t), tr?.status === "ok" && tr.text ? { state: "ok", text: tr.text } : tr?.status === "rejected" ? { state: "rejected" } : { state: "unavailable" });
      });
    } catch {
      batch.forEach((t) => cache.set(k(lang, t), { state: "unavailable" }));
    }
    listeners.forEach((f) => f());
  }
}

export function useTranslations(texts: string[]) {
  const { lang } = useI18n();
  const [, bump] = useState(0);
  const key = texts.join("\u0001");
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, []);
  useEffect(() => {
    if (lang === "en") return;
    const missing = [...new Set(texts)].filter((t) => t && !fixedSentenceKey(t) && !cache.has(k(lang, t)));
    if (missing.length) void fetchBatch(lang, missing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, key]);
  return useMemo(() => (text: string): Entry | null => (lang === "en" ? null : cache.get(k(lang, text)) ?? { state: "busy" }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lang, key, cache.size]);
}

/** Renders the translation of `text` under the English original, or nothing in English mode. */
export function TranslationOf({ text, get }: { text: string; get: (t: string) => Entry | null }) {
  const { lang, t } = useI18n();
  if (lang === "en") return null;
  const fixed = fixedSentenceKey(text);
  if (fixed) return <p className="tr" lang={lang}>{t(fixed)}</p>;
  const e = get(text);
  if (!e) return null;
  if (e.state === "busy") return <p className="tr tr-note">{t("tr.busy")}</p>;
  if (e.state === "ok")
    return (
      <div className="tr" lang={lang}>
        <p>{e.text}</p>
        <p className="tr-note">{t("tr.machine")}</p>
      </div>
    );
  return <p className="tr tr-note">{e.state === "rejected" ? t("tr.rejected") : t("tr.unavailable")}</p>;
}
