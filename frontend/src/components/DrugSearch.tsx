// Searchable medicine picker backed by GET /api/v1/drugs/search (dictionary + fuzzy match).
// Enter with no highlighted result adds the text as written; the backend then resolves or flags it.
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../api";
import { useI18n } from "../i18n";
import type { DrugHit } from "../types";
import Icon from "./Icon";

export default function DrugSearch({
  onPick,
  placeholder,
  autoFocus,
  compact,
  allowFree = true,
}: {
  onPick: (name: string, hit: DrugHit | null) => void;
  placeholder?: string;
  autoFocus?: boolean;
  compact?: boolean;
  allowFree?: boolean;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<DrugHit[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const seq = useRef(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits([]);
      setBusy(false);
      return;
    }
    setBusy(true);
    const my = ++seq.current;
    const h = setTimeout(() => {
      api<{ results: DrugHit[] }>(`/api/v1/drugs/search?q=${encodeURIComponent(term)}`)
        .then((r) => my === seq.current && setHits(r.results))
        .catch(() => my === seq.current && setHits([]))
        .finally(() => my === seq.current && setBusy(false));
    }, 200);
    return () => clearTimeout(h);
  }, [q]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const options: { label: string; hit: DrugHit | null }[] = [
    ...hits.map((h) => ({ label: h.name, hit: h })),
    ...(allowFree && q.trim().length >= 2 && !hits.some((h) => h.name.toLowerCase() === q.trim().toLowerCase())
      ? [{ label: q.trim(), hit: null }]
      : []),
  ];

  const choose = (i: number) => {
    const o = options[i];
    if (!o) return;
    onPick(o.label, o.hit);
    setQ("");
    setHits([]);
    setActive(-1);
    setOpen(false);
  };

  return (
    <div className={`combo ${compact ? "combo-compact" : ""}`} ref={box}>
      <div className="combo-field">
        <Icon name="search" size={compact ? 16 : 20} />
        <input
          type="text"
          role="combobox"
          aria-expanded={open && options.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          aria-label={placeholder ?? t("rx.search")}
          placeholder={placeholder ?? t("rx.search")}
          value={q}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActive((a) => Math.min(options.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(active >= 0 ? active : options.length - 1);
            } else if (e.key === "Escape") setOpen(false);
          }}
        />
        {busy && <span className="combo-busy">{t("rx.searching")}</span>}
      </div>
      {open && q.trim().length >= 2 && (
        <ul className="combo-list" id={listId} role="listbox">
          {options.map((o, i) => (
            <li
              key={`${o.label}-${i}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? "active" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(i);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {o.hit ? (
                <>
                  <span className="opt-name">{o.label}</span>
                  {o.hit.nlem_listed && <span className="tag tag-brand">{t("rx.nlem")}</span>}
                  {o.hit.score < 100 && <span className="opt-score">{Math.round(o.hit.score)}%</span>}
                </>
              ) : (
                <span className="opt-free">
                  <Icon name="plus" size={15} /> {t("rx.addAsWritten", { q: o.label })}
                </span>
              )}
            </li>
          ))}
          {!busy && hits.length === 0 && <li className="opt-empty" aria-disabled>{t("rx.noHits")}</li>}
        </ul>
      )}
    </div>
  );
}
