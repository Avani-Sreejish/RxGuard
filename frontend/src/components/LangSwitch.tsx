import { LANGS, useI18n } from "../i18n";

export default function LangSwitch() {
  const { lang, setLang } = useI18n();
  return (
    <div className="langswitch" role="group" aria-label="Language">
      {LANGS.map((l) => (
        <button
          key={l.code}
          type="button"
          lang={l.code}
          className={lang === l.code ? "on" : ""}
          aria-pressed={lang === l.code}
          title={l.name}
          onClick={() => setLang(l.code)}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
