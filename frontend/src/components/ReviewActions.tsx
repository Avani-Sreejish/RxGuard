// Human-in-the-loop: the pharmacist records what they did about a finding. Recorded actions go to the
// hash-chained audit log with the knowledge-base version on screen. P1 findings need one before completion.
import { useState } from "react";
import { useI18n } from "../i18n";
import type { Review, ReviewActionType } from "../types";
import { fmtDateTime } from "./Badges";
import Icon from "./Icon";

const ACTIONS: { a: ReviewActionType; icon: string }[] = [
  { a: "ACKNOWLEDGE", icon: "check" },
  { a: "ESCALATE", icon: "flag" },
  { a: "REQUEST_MORE_EVIDENCE", icon: "book" },
  { a: "MARK_FOR_FOLLOW_UP", icon: "clock" },
];

export default function ReviewActions({
  reviews,
  required,
  locked,
  busy,
  compact = false,
  onRecord,
}: {
  reviews: Review[];
  required: boolean;
  locked: boolean;
  busy: boolean;
  /** Collapsed to a single "Record action" control until the card is selected or opened. */
  compact?: boolean;
  onRecord: (action: ReviewActionType, note: string) => Promise<void>;
}) {
  const { t, lang } = useI18n();
  const [pick, setPick] = useState<ReviewActionType | null>(null);
  const [note, setNote] = useState("");
  const [again, setAgain] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const last = reviews[reviews.length - 1];
  const showButtons = !locked && (!last || again) && (!compact || expanded);

  return (
    <div className="hitl" onClick={(e) => e.stopPropagation()}>
      {reviews.length > 0 && (
        <ul className="hitl-log">
          {reviews.map((r) => (
            <li key={r.id}>
              <Icon name="check" size={15} />
              <span>
                <b>{t("action.by", { action: t(`done.${r.action}`), user: r.user })}</b>
                <span className="meta"> · {fmtDateTime(r.created_at, lang)}</span>
                {r.stale && <span className="meta warn-text"> · {t("action.stale")}</span>}
                {r.note && <span className="hitl-note">{r.note}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {(!reviews.length || again) && !locked && !showButtons && !pick && (
        <div className="row">
          {required && !reviews.length && (
            <span className="need">
              <Icon name="alert" size={15} /> {t("action.required")}
            </span>
          )}
          <button type="button" className="btn sm ghost" onClick={() => setExpanded(true)}>
            {t("action.open")}
          </button>
        </div>
      )}
      {!reviews.length && required && !locked && showButtons && (
        <span className="need">
          <Icon name="alert" size={15} /> {t("action.required")}
        </span>
      )}
      {showButtons && !pick && (
        <div className="hitl-actions" role="group">
          {ACTIONS.map(({ a, icon }) => (
            <button key={a} type="button" className={`btn sm ${a === "ACKNOWLEDGE" ? "primary-soft" : a === "ESCALATE" ? "danger-soft" : "ghost"}`} onClick={() => setPick(a)}>
              <Icon name={icon} size={15} /> {t(`action.${a}`)}
            </button>
          ))}
        </div>
      )}
      {!showButtons && !locked && last && !again && (
        <button type="button" className="linkish sm" onClick={() => setAgain(true)}>
          + {t("action.another")}
        </button>
      )}
      {pick && (
        <form
          className="hitl-form"
          onSubmit={async (e) => {
            e.preventDefault();
            await onRecord(pick, note.trim());
            setPick(null);
            setNote("");
            setAgain(false);
            setExpanded(false);
          }}
        >
          <label className="field">
            <span>{t("action.note")}</span>
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("action.notePh")} maxLength={1000} autoFocus />
          </label>
          <div className="row">
            <button type="button" className="btn ghost sm" onClick={() => setPick(null)}>
              {t("common.cancel")}
            </button>
            <button type="submit" className="btn primary sm" disabled={busy}>
              {t("action.record", { action: t(`action.${pick}`) })}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
