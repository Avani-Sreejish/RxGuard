import { useEffect, useState } from "react";
import { api, ApiError, getToken, setToken } from "./api";
import Icon, { RxMark } from "./components/Icon";
import { Spinner } from "./components/Badges";
import Queue from "./pages/Queue";
import NewCheck from "./pages/NewCheck";
import Detail from "./pages/Detail";
import Sources from "./pages/Sources";
import Admin from "./pages/Admin";

export type Lang = "en" | "hi" | "ml";
const LANGS: { code: Lang; label: string; name: string }[] = [
  { code: "en", label: "EN", name: "English" },
  { code: "hi", label: "हिंदी", name: "Hindi" },
  { code: "ml", label: "മലയാളം", name: "Malayalam" },
];
const LANG_KEY = "rxguard.lang";

function initialLang(): Lang {
  try {
    const l = localStorage.getItem(LANG_KEY);
    if (l === "hi" || l === "ml") return l;
  } catch {
    /* storage unavailable */
  }
  return "en";
}

export interface Me {
  username: string;
  is_admin: boolean;
  demo_toggles_enabled: boolean;
  kb_version: string | null;
}

// Minimal hash router: #/queue, #/new, #/rx/12, #/admin/uploads, #/sources
function useRoute(): [string[], (r: string) => void] {
  const parse = () => (window.location.hash.replace(/^#\/?/, "") || "queue").split("/");
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [route, (r) => (window.location.hash = "/" + r)];
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);
  const [route, go] = useRoute();
  const [lang, setLangState] = useState<Lang>(initialLang);
  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(LANG_KEY, l);
    } catch {
      /* storage unavailable */
    }
  };

  useEffect(() => {
    if (!getToken()) return setChecked(true);
    api<Me>("/api/v1/me")
      .then(setMe)
      .catch(() => setToken(null))
      .finally(() => setChecked(true));
  }, []);

  if (!checked) return null;
  if (!me) return <Login onLogin={setMe} />;

  // [route, icon, label, routes that keep the tab highlighted]
  const tabs: [string, string, string, string[]][] = [
    ["queue", "list", "Review queue", ["queue", "rx"]],
    ["new", "plus", "New check", ["new"]],
    ...(me.is_admin ? [["admin", "database", "Knowledge base", ["admin"]] as [string, string, string, string[]]] : []),
  ];
  const page = route[0];

  return (
    <>
      <a href="#main" className="skip">Skip to content</a>
      <div className="synthetic-strip" role="note">
        Demo with synthetic prescriptions · Supports the pharmacist's review, never replaces it
      </div>
      <header className="topbar">
        <a href="#/queue" className="brand">
          <RxMark size={30} />
          <span className="brand-name">RxGuard</span>
        </a>
        <nav aria-label="Main">
          {tabs.map(([k, icon, label, match]) => (
            <a key={k} href={`#/${k}`} className={match.includes(page) ? "on" : ""}>
              <Icon name={icon} size={17} />
              <span>{label}</span>
            </a>
          ))}
        </nav>
        <div className="topbar-right">
          <div className="langswitch" role="group" aria-label="Language">
            {LANGS.map((l) => (
              <button key={l.code} type="button" lang={l.code} title={l.name} aria-pressed={lang === l.code}
                className={lang === l.code ? "on" : ""} onClick={() => setLang(l.code)}>
                {l.label}
              </button>
            ))}
          </div>
          <span className="who" title={me.username}>
            <Icon name="user" size={17} />
            <span>
              {me.username}
              {me.is_admin ? " (admin)" : ""}
            </span>
          </span>
          <button
            className="icon-btn"
            aria-label="Sign out"
            title="Sign out"
            onClick={() => {
              setToken(null);
              setMe(null);
            }}
          >
            <Icon name="logout" />
          </button>
        </div>
      </header>
      <main id="main">
        <div className="page">
          {page === "queue" && <Queue open={(id) => go(`rx/${id}`)} />}
          {page === "new" && <NewCheck done={(id) => go(`rx/${id}`)} />}
                    {page === "rx" && route[1] && <Detail id={Number(route[1])} key={route[1]} lang={lang} />}
          {page === "admin" && me.is_admin && <Admin section={route[1]} />}
          {page === "sources" && <Sources />}
        </div>
      </main>
      <footer className="app-foot">
        <a href="#/sources">Data sources &amp; licences</a>
        <span>Knowledge base {me.kb_version ?? "—"}</span>
      </footer>
    </>
  );
}

function Login({ onLogin }: { onLogin: (m: Me) => void }) {
  const [u, setU] = useState("pharmacist");
  const [p, setP] = useState("rxguard-demo");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setErr("");
    setLoading(true);
    try {
      const r = await api<{ token: string }>("/api/v1/auth/token", { body: { username: u, password: p } });
      setToken(r.token);
      onLogin(await api<Me>("/api/v1/me"));
    } catch (ex) {
      setErr(ex instanceof ApiError ? ex.message : String(ex));
    } finally {
      setLoading(false);
    }
  };

  const quickFill = (user: string) => {
    setU(user);
    setP("rxguard-demo");
  };

  return (
    <div className="login">
      <div className="login-photo" aria-hidden />
      <header className="login-top" />
      <main className="login-main">
        <section className="login-panel" aria-labelledby="login-h">
          <div className="brand brand-lg">
            <RxMark size={44} />
            <div>
              <div className="brand-name">RxGuard</div>
              <div className="brand-tag">Evidence-proven prescription review for pharmacists</div>
            </div>
          </div>
          <form onSubmit={submit} className="login-form">
            <h1 id="login-h">Sign in to RxGuard</h1>
            <label className="field">
              <span>Username</span>
              <input type="text" autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} autoFocus />
            </label>
            <label className="field">
              <span>Password</span>
              <span className="pw">
                <input type={show ? "text" : "password"} autoComplete="current-password" value={p}
                  onChange={(e) => setP(e.target.value)} />
                <button type="button" className="pw-toggle" onClick={() => setShow((s) => !s)}
                  aria-label={show ? "Hide password" : "Show password"}>
                  <Icon name={show ? "eyeOff" : "eye"} />
                </button>
              </span>
            </label>
            {err && <p className="err-text" role="alert">{err}</p>}
            <button className="btn primary btn-block" type="submit" disabled={loading}>
              {loading ? <><Spinner /> Signing in…</> : "Sign in"}
            </button>
          </form>
          <div className="login-demo">
            <span>Quick demo credentials</span>
            <div className="login-quick">
              <button type="button" className="btn sm ghost" onClick={() => quickFill("pharmacist")} title="Standard pharmacist account">
                <Icon name="user" size={15} /> Pharmacist
              </button>
              <button type="button" className="btn sm ghost" onClick={() => quickFill("admin")} title="Admin with Judge Attack toggles">
                <Icon name="shield" size={15} /> Admin
              </button>
            </div>
          </div>
          <p className="login-foot">
            <Icon name="shield" size={16} />
            For registered pharmacists. RxGuard supports your review; the dispensing decision stays with you.
          </p>
        </section>
      </main>
    </div>
  );
}
