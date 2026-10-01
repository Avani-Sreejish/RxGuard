import { useEffect, useMemo, useState } from "react";
import { api, DEMO_ONLY, getToken, isDemo, setDemo, setToken } from "./api";
import { LangContext, makeT } from "./i18n";
import { resetCache } from "./patients";
import { Link, navigate, useRoute } from "./router";
import type { Lang } from "./types";
import Icon, { RxMark } from "./components/Icon";
import LangSwitch from "./components/LangSwitch";
import Login from "./pages/Login";
import NewCheck from "./pages/NewCheck";
import Review from "./pages/Review";
import Queue from "./pages/Queue";
import Patients from "./pages/Patients";
import Evaluation from "./pages/Evaluation";

const LANG_KEY = "rxguard.lang";
function initialLang(): Lang {
  try {
    const l = localStorage.getItem(LANG_KEY);
    if (l === "en" || l === "ml" || l === "hi") return l;
  } catch {
    /* ignore */
  }
  return "en";
}

export default function App() {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const [user, setUser] = useState<string | null>(getToken() ? "…" : null);
  const route = useRoute();
  const ctx = useMemo(
    () => ({
      lang,
      t: makeT(lang),
      setLang: (l: Lang) => {
        setLangState(l);
        try {
          localStorage.setItem(LANG_KEY, l);
        } catch {
          /* ignore */
        }
      },
    }),
    [lang],
  );

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  useEffect(() => {
    if (!getToken()) return;
    api<{ username: string }>("/api/v1/me")
      .then((m) => setUser(m.username))
      .catch(() => {
        setToken(null);
        setUser(null);
      });
    const out = () => setUser(null);
    window.addEventListener("rxguard:signed-out", out);
    return () => window.removeEventListener("rxguard:signed-out", out);
  }, []);

  const signOut = () => {
    setToken(null);
    if (!DEMO_ONLY) setDemo(false);
    resetCache();
    setUser(null);
    navigate("/check");
  };

  const t = ctx.t;
  if (!user)
    return (
      <LangContext.Provider value={ctx}>
        <Login
          onSignedIn={(u) => {
            resetCache();
            setUser(u);
          }}
        />
      </LangContext.Provider>
    );

  const [page, arg] = route;
  const query = route.find((r) => r.startsWith("?"));
  const patientParam = query ? new URLSearchParams(query.slice(1)).get("patient") ?? undefined : undefined;
  const nav: { to: string; key: string; icon: string; match: string[] }[] = [
    { to: "/check", key: "nav.check", icon: "plus", match: ["check"] },
    { to: "/queue", key: "nav.queue", icon: "list", match: ["queue", "rx"] },
    { to: "/patients", key: "nav.patients", icon: "users", match: ["patients"] },
    { to: "/evaluation", key: "nav.eval", icon: "chart", match: ["evaluation"] },
  ];

  let body: React.ReactNode;
  if (page === "rx" && arg) body = <Review key={arg} id={Number(arg)} />;
  else if (page === "queue") body = <Queue />;
  else if (page === "patients") body = <Patients id={arg && !arg.startsWith("?") ? arg : undefined} />;
  else if (page === "evaluation") body = <Evaluation />;
  else body = <NewCheck key={patientParam ?? "new"} patientId={patientParam} />;

  return (
    <LangContext.Provider value={ctx}>
      <a href="#main" className="skip">Skip to content</a>
      {isDemo() && (
        <div className="demo-strip" role="note">
          <Icon name="info" size={15} /> {t("demo.banner")}
          {!DEMO_ONLY && (
            <button className="linkish" onClick={signOut}>
              {t("demo.exit")}
            </button>
          )}
        </div>
      )}
      <header className="topbar">
        <Link to="/check" className="brand">
          <RxMark size={30} />
          <span className="brand-name">RxGuard</span>
        </Link>
        <nav aria-label="Main">
          {nav.map((n) => (
            <Link key={n.to} to={n.to} className={n.match.includes(page ?? "check") || (!page && n.to === "/check") ? "on" : ""}>
              <Icon name={n.icon} size={17} />
              <span>{t(n.key)}</span>
            </Link>
          ))}
        </nav>
        <div className="topbar-right">
          <LangSwitch />
          <span className="who" title={user}>
            <Icon name="user" size={17} /> <span>{user}</span>
          </span>
          <button className="icon-btn" onClick={signOut} aria-label={t("common.signOut")} title={t("common.signOut")}>
            <Icon name="logout" />
          </button>
        </div>
      </header>
      <main id="main">{body}</main>
    </LangContext.Provider>
  );
}
