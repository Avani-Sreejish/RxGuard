import { useEffect, useState } from "react";
import { api, ApiError, getToken, setToken } from "./api";
import Queue from "./pages/Queue";
import NewCheck from "./pages/NewCheck";
import Detail from "./pages/Detail";
import JudgePanel from "./pages/JudgePanel";
import Observability from "./pages/Observability";
import Sources from "./pages/Sources";
import DatasetIngestion from "./pages/DatasetIngestion";

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

  const tabs: [string, string, string][] = [
    ["queue", "📋", "Review queue"],
    ["new", "➕", "New check"],
    ["dataset", "📥", "Dataset Ingestion"],
    ["attack", "⚔️", "Judge Attack"],
    ["obs", "📈", "Observability"],
    ["sources", "📚", "Sources & licences"],
  ];
  const page = route[0];

  return (
    <>
      <div className="synthetic-strip">
        SYNTHETIC DEMO DATA · Clinical Decision Support for Pharmacists · Never for Patient Direct Use
      </div>
      <header className="topbar">
        <div className="brand cursor-pointer" onClick={() => go("queue")}>
          <span className="brand-mark">Rx</span>
          <span>RxGuard</span>
        </div>
        <nav className="nav">
          {tabs.map(([k, icon, label]) => (
            <button key={k} className={page === k ? "active" : ""} onClick={() => go(k)}>
              <span style={{ marginRight: 5 }}>{icon}</span>
              {label}
            </button>
          ))}
        </nav>
        <div className="who">
          <div className="status-pill">
            <span className="status-dot"></span>
            <span>KB {me.kb_version ?? "v1"} (160k pairs)</span>
          </div>
          <span style={{ fontWeight: 600, color: "var(--text)" }}>
            {me.username}
            {me.is_admin ? " (admin)" : ""}
          </span>
          <button
            className="btn sm"
            onClick={() => {
              setToken(null);
              setMe(null);
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main>
        {page === "queue" && <Queue open={(id) => go(`rx/${id}`)} />}
        {page === "new" && <NewCheck done={(id) => go(`rx/${id}`)} />}
        {page === "dataset" && <DatasetIngestion />}
        {page === "rx" && route[1] && <Detail id={Number(route[1])} key={route[1]} />}
        {page === "attack" && <JudgePanel me={me} open={(id) => go(`rx/${id}`)} />}
        {page === "obs" && <Observability />}
        {page === "sources" && <Sources />}
      </main>
    </>
  );
}

function Login({ onLogin }: { onLogin: (m: Me) => void }) {
  const [u, setU] = useState("pharmacist");
  const [p, setP] = useState("rxguard-demo");
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
    <div className="login card elevated">
      <div className="brand" style={{ marginBottom: 8, justifyContent: "center" }}>
        <span className="brand-mark" style={{ width: 32, height: 32, fontSize: 16 }}>Rx</span>
        <span style={{ fontSize: 20 }}>RxGuard</span>
      </div>
      <p className="sub" style={{ textAlign: "center", marginBottom: 18 }}>
        Evidence-proven prescription review · Pharmacist sign-in only
      </p>

      <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <label className="field">
          Username
          <input type="text" value={u} onChange={(e) => setU(e.target.value)} autoFocus />
        </label>
        <label className="field">
          Password
          <input type="password" value={p} onChange={(e) => setP(e.target.value)} />
        </label>
        {err && <div className="error">{err}</div>}
        <button className="btn primary" type="submit" disabled={loading} style={{ height: 40, marginTop: 4 }}>
          {loading ? <span className="spin" /> : "Sign in to Workspace"}
        </button>
      </form>

      <div style={{ marginTop: 20, paddingTop: 14, borderTop: "1px solid var(--border)", fontSize: 12 }}>
        <div style={{ color: "var(--muted)", marginBottom: 8, textAlign: "center", fontWeight: 600 }}>
          Quick Demo Credentials:
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          <button
            type="button"
            className="btn sm"
            onClick={() => quickFill("pharmacist")}
            title="Standard Pharmacist Account"
          >
            👤 Pharmacist
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() => quickFill("admin")}
            title="Admin with Judge Attack toggles"
          >
            🛡️ Admin
          </button>
        </div>
      </div>
    </div>
  );
}
