import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { Synthetic } from "../components/Badges";

interface Demo {
  id: string;
  title: string;
  text: string;
  age_band: string;
  note: string;
}

const AGE_BANDS = ["unknown", "<12", "12-17", "18-64", "65+"];

export default function NewCheck({ done }: { done: (id: number) => void }) {
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [age, setAge] = useState("unknown");
  const [file, setFile] = useState<File | null>(null);
  const [demos, setDemos] = useState<Demo[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  useEffect(() => {
    api<{ results: Demo[] }>("/api/v1/demo/prescriptions").then((r) => setDemos(r.results)).catch(() => {});
  }, []);

  const load = (d: Demo) => {
    setText(d.text);
    setNote(d.note);
    setAge(d.age_band);
    setFile(null);
  };

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      let r;
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("age_band", age);
        fd.append("note", note);
        r = await api("/api/v1/check", { form: fd });
      } else {
        r = await api("/api/v1/check", { body: { text, note, age_band: age } });
      }
      done(r.id);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>New check</h1>
      <p className="sub">
        Paste a synthetic prescription or upload a text-based PDF. The check is deterministic: no LLM is used unless a
        line cannot be matched by the drug dictionary.
      </p>
      <div className="grid2">
        <div className="card">
          <label className="field">
            Prescription text
            <textarea rows={12} value={text} onChange={(e) => setText(e.target.value)}
              placeholder={"Rx\n1. Tab Warfarin 5 mg OD\n2. Tab Aspirin 75 mg OD"} disabled={!!file} />
          </label>
          <div className="row" style={{ marginTop: 10 }}>
            <label className="field" style={{ flex: 1 }}>
              Or upload (.txt or text-based .pdf, max 2 MB)
              <input type="file" accept=".txt,.pdf,text/plain,application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
          </div>
          <div className="row" style={{ marginTop: 10, alignItems: "flex-end" }}>
            <label className="field" style={{ width: 150 }}>
              Age band
              <select value={age} onChange={(e) => setAge(e.target.value)}>
                {AGE_BANDS.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </label>
            <label className="field" style={{ flex: 1 }}>
              Note (optional)
              <input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
            </label>
          </div>
          {err && (
            <div className="error" style={{ marginTop: 10 }}>
              {err.status}: {err.message} <span className="mono small">· {err.correlationId}</span>
            </div>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={submit} disabled={busy || (!text.trim() && !file)}>
              {busy ? <span className="spin" /> : "Run check"}
            </button>
            <span className="small muted">Limits: 20,000 characters · 25 medication lines</span>
          </div>
        </div>
        <div className="card">
          <h2>
            Demo loader <Synthetic />
          </h2>
          <p className="small muted">Deterministic synthetic prescriptions. Brand names are fictional.</p>
          {demos.map((d) => (
            <div key={d.id} className="row spread" style={{ padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
              <span>{d.title}</span>
              <button className="btn sm" onClick={() => load(d)}>
                Load
              </button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
