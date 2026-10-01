import { useEffect, useState } from "react";
import { api, ApiError, getToken, setToken } from "./api";
import Queue from "./pages/Queue";
import NewCheck from "./pages/NewCheck";
import Detail from "./pages/Detail";
import JudgePanel from "./pages/JudgePanel";
import Observability from "./pages/Observability";
import Sources from "./pages/Sources";

export interface Me {
  username: string;
  is_admin: boolean;
  demo_toggles_enabled: boolean;
  kb_version: string | null;
}

// Minimal hash router: #/queue, #/new, #/rx/12, #/attack, #/obs, #/sources
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

  useEffect(() => {
    if (!getToken()) return setChecked(true);
    api<Me>("/api/v1/me")
      .then(setMe)
      .catch(() => setToken(null))
      .finally(() => setChecked(true));
  }, []);

  if (!checked) return null;
  if (!me) return <Login onLogin={setMe} />;

  const tabs: [string, string][] = [
    ["queue", "Review queue"],
    ["new", "New check"],
    ["attack", "Judge Attack"],
    ["obs", "Observability"],
    ["sources", "Sources & licences"],
  ];
  const page = route[0];
  return (
    <>
      <div className="synthetic-strip">SYNTHETIC DEMO DATA · decision support for pharmacists · not for patients</div>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">Rx</span>RxGuard
        </div>
        <nav className="nav">
          {tabs.map(([k, label]) => (
            <button key={k} className={page === k ? "active" : ""} onClick={() => go(k)}>
              {label}
            </button>
          ))}
        </nav>
        <span className="who">
          {me.username}
          {me.is_admin ? " (admin)" : ""} · KB {me.kb_version ?? "—"}{" "}
          <button
            className="btn sm"
            onClick={() => {
              setToken(null);
              setMe(null);
            }}
          >
            Sign out
          </button>
        </span>
      </header>
      <main>
        {page === "queue" && <Queue open={(id) => go(`rx/${id}`)} />}
        {page === "new" && <NewCheck done={(id) => go(`rx/${id}`)} />}
        {page === "rx" && route[1] && <Detail id={Number(route[1])} key={route[1]} />}
        {page === "attack" && <JudgePanel me={me} open={(id) => go(`rx/${id}`)} />}
        {page === "obs" && <Observability />}
        {page === "sources" && <Sources />}
      </main>
    </>
  );
}

function Login({ onLogin }: { onLogin: (m: Me) => void }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    try {
      const r = await api<{ token: string }>("/api/v1/auth/token", { body: { username: u, password: p } });
      setToken(r.token);
      onLogin(await api<Me>("/api/v1/me"));
    } catch (ex) {
      setErr(ex instanceof ApiError ? ex.message : String(ex));
    }
  };
  return (
    <div className="login card">
      <div className="brand" style={{ marginBottom: 12 }}>
        <span className="brand-mark">Rx</span>RxGuard
      </div>
      <p className="sub">Evidence-proven prescription review. Pharmacist sign-in only.</p>
      <form onSubmit={submit} style={{ display: "grid", gap: 10 }}>
        <label className="field">
          Username
          <input type="text" value={u} onChange={(e) => setU(e.target.value)} autoFocus />
        </label>
        <label className="field">
          Password
          <input type="password" value={p} onChange={(e) => setP(e.target.value)} />
        </label>
        {err && <div className="error">{err}</div>}
        <button className="btn primary" type="submit">
          Sign in
        </button>
      </form>
    </div>
  );
}
