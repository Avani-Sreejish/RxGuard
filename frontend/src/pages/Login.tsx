import { useState } from "react";
import { api, ApiError, DEMO_ONLY, setDemo, setToken } from "../api";
import { useI18n } from "../i18n";
import Icon, { RxMark } from "../components/Icon";
import LangSwitch from "../components/LangSwitch";

export default function Login({ onSignedIn }: { onSignedIn: (username: string) => void }) {
  const { t } = useI18n();
  const [username, setUsername] = useState(DEMO_ONLY ? "pharmacist" : "");
  const [password, setPassword] = useState(DEMO_ONLY ? "demo" : "");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return setErr(t("login.missing"));
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ token: string; username: string }>("/api/v1/auth/token", { body: { username: username.trim(), password } });
      setToken(r.token);
      onSignedIn(r.username);
    } catch (ex) {
      setErr((ex as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const demo = () => {
    setDemo(true);
    setToken("demo-token");
    onSignedIn("pharmacist");
  };

  return (
    <div className="login">
      <div className="login-photo" aria-hidden />
      <header className="login-top">
        <LangSwitch />
      </header>
      <main className="login-main">
        <section className="login-panel" aria-labelledby="login-h">
          <div className="brand brand-lg">
            <RxMark size={44} />
            <div>
              <div className="brand-name">RxGuard</div>
              <div className="brand-tag">{t("app.tagline")}</div>
            </div>
          </div>
          <form onSubmit={submit} className="login-form" noValidate>
            <h1 id="login-h">{t("login.heading")}</h1>
            <label className="field">
              <span>{t("login.username")}</span>
              <input id="login-user" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
            </label>
            <label className="field">
              <span>{t("login.password")}</span>
              <span className="pw">
                <input
                  id="login-pass"
                  type={show ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button type="button" className="pw-toggle" onClick={() => setShow((s) => !s)} aria-label={show ? t("login.hide") : t("login.show")}>
                  <Icon name={show ? "eyeOff" : "eye"} />
                </button>
              </span>
            </label>
            {err && <p className="err-text" role="alert">{err}</p>}
            <button className="btn primary btn-block" type="submit" disabled={busy}>
              {busy ? t("login.busy") : t("login.submit")}
            </button>
          </form>
          {!DEMO_ONLY && (
            <div className="login-demo">
              <button type="button" className="linkish" onClick={demo}>
                {t("login.demo")}
              </button>
              <span>{t("login.demoHint")}</span>
            </div>
          )}
          <p className="login-foot">
            <Icon name="shield" size={16} />
            {t("login.footer")}
          </p>
        </section>
      </main>
    </div>
  );
}
