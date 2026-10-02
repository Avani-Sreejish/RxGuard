import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { Sev } from "../components/Badges";

interface KbStats {
  kb_version: string;
  loaded_at: string;
  counts: {
    drugs: number;
    aliases: number;
    interactions: number;
    documents: number;
  };
}

interface IngestInteractionResult {
  status: string;
  kb_version: string;
  total_rows_parsed: number;
  added_interactions: number;
  kept_existing: number;
  rejected_rows: number;
  total_interactions_now: number;
  added: Array<{ drug_a: string; drug_b: string; severity: string; source_record_id: string }>;
  kept: Array<{ row: number; drug_a: string; drug_b: string; severity: string; source: string; uploaded_severity: string }>;
  rejected: Array<{ row: number; drug_a: string; drug_b: string; reason: string }>;
}

interface IngestGuidelineResult {
  status: string;
  document_id: number;
  document_title: string;
  doc_type: string;
  chunks_created: number;
  drug_mentions_tagged: number;
  sample_chunks: Array<{
    section: string;
    text_preview: string;
    drugs_tagged: string[];
  }>;
}

// Format templates only. They are deliberately not clinical content, so nothing fabricated can be uploaded
// by accident: replace every row with your hospital's reviewed data.
// Format templates only. They are deliberately not clinical content, so nothing fabricated can be uploaded
// by accident: replace every row with your hospital's reviewed data.
const SAMPLE_INTERACTIONS_CSV = `drug_a,drug_b,severity,notes
<generic name in the KB>,<generic name in the KB>,Major,<optional; not stored>`;

const SAMPLE_GUIDELINES_CSV = `section,text
"<section heading>","<exact wording of this section from your approved protocol>"`;

export default function DatasetIngestion() {
  const [activeTab, setActiveTab] = useState<"interactions" | "guidelines">("interactions");
  const [stats, setStats] = useState<KbStats | null>(null);

  // Interactions State
  const [intCsv, setIntCsv] = useState("");
  const [intFile, setIntFile] = useState<File | null>(null);
  const [intLoading, setIntLoading] = useState(false);
  const [intResult, setIntResult] = useState<IngestInteractionResult | null>(null);
  const [intError, setIntError] = useState("");

  // Guidelines State
  const [guideTitle, setGuideTitle] = useState("");
  const [guideType, setGuideType] = useState("GUIDELINE");
  const [guideSource, setGuideSource] = useState("");
  const [guideCsv, setGuideCsv] = useState("");
  const [guideFile, setGuideFile] = useState<File | null>(null);
  const [guideLoading, setGuideLoading] = useState(false);
  const [guideResult, setGuideResult] = useState<IngestGuidelineResult | null>(null);
  const [guideError, setGuideError] = useState("");

  const refreshStats = () => {
    api<KbStats>("/api/v1/kb")
      .then(setStats)
      .catch((e) => console.error("Could not load KB stats", e));
  };

  useEffect(() => {
    refreshStats();
  }, []);

  const handleUploadInteractions = async (e: React.FormEvent) => {
    e.preventDefault();
    setIntLoading(true);
    setIntError("");
    setIntResult(null);

    try {
      let res: IngestInteractionResult;
      if (intFile) {
        const form = new FormData();
        form.append("file", intFile);
        res = await api<IngestInteractionResult>("/api/v1/kb/interactions/upload", { form });
      } else {
        res = await api<IngestInteractionResult>("/api/v1/kb/interactions/upload", {
          body: { csv_text: intCsv },
        });
      }
      setIntResult(res);
      refreshStats();
    } catch (err) {
      const ae = err as ApiError;
      setIntError(ae.message || "Failed to ingest interactions CSV");
    } finally {
      setIntLoading(false);
    }
  };

  const handleUploadGuidelines = async (e: React.FormEvent) => {
    e.preventDefault();
    setGuideLoading(true);
    setGuideError("");
    setGuideResult(null);

    try {
      let res: IngestGuidelineResult;
      if (guideFile) {
        const form = new FormData();
        form.append("file", guideFile);
        form.append("title", guideTitle);
        form.append("doc_type", guideType);
        form.append("source", guideSource);
        res = await api<IngestGuidelineResult>("/api/v1/kb/guidelines/upload", { form });
      } else {
        res = await api<IngestGuidelineResult>("/api/v1/kb/guidelines/upload", {
          body: {
            csv_text: guideCsv,
            title: guideTitle,
            doc_type: guideType,
            source: guideSource,
          },
        });
      }
      setGuideResult(res);
      refreshStats();
    } catch (err) {
      const ae = err as ApiError;
      setGuideError(ae.message || "Failed to ingest guidelines dataset");
    } finally {
      setGuideLoading(false);
    }
  };

  const downloadSample = (content: string, filename: string) => {
    const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <>
      <div className="row spread" style={{ marginBottom: 14 }}>
        <div>
          <h1>Knowledge Base & Dataset Ingestion</h1>
          <p className="sub">
            Administrators can add local interaction pairs and hospital guideline text. Uploads only add: existing DDInter records are never changed, and uploaded pairs are always shown as "Hospital upload", never as DDInter.
          </p>
        </div>
        {stats && (
          <div className="row" style={{ gap: 8 }}>
            <span className="zero-token">
              Active KB: <b>{stats.kb_version}</b>
            </span>
            <span className="badge synth">
              💊 {stats.counts.interactions.toLocaleString()} Interactions
            </span>
            <span className="badge esc">
              📚 {stats.counts.documents} Guidelines
            </span>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="card" style={{ padding: "8px 12px", marginBottom: 16 }}>
        <div className="row" style={{ gap: 10 }}>
          <button
            type="button"
            className={`btn ${activeTab === "interactions" ? "primary" : ""}`}
            onClick={() => setActiveTab("interactions")}
          >
            💊 Ingest Drug Interactions (CSV)
          </button>
          <button
            type="button"
            className={`btn ${activeTab === "guidelines" ? "primary" : ""}`}
            onClick={() => setActiveTab("guidelines")}
          >
            📋 Ingest Clinical Guidelines (CSV/TXT)
          </button>
        </div>
      </div>

      {/* Tab 1: Drug Interactions */}
      {activeTab === "interactions" && (
        <div className="grid2">
          <div className="card elevated">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <h2 style={{ margin: 0, fontSize: 16 }}>Import Drug-Drug Interactions CSV</h2>
              <div className="row" style={{ gap: 6 }}>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => downloadSample(SAMPLE_INTERACTIONS_CSV, "sample_interactions.csv")}
                >
                  📥 Download CSV Template
                </button>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    setIntFile(null);
                    setIntCsv(SAMPLE_INTERACTIONS_CSV);
                  }}
                >
                  🔄 Load format template
                </button>
              </div>
            </div>

            <p className="small muted" style={{ marginTop: 0 }}>
              Expected columns: <code>drug_a</code>, <code>drug_b</code>, <code>severity</code> (Major, Moderate, Minor, or Unknown). Drug names must already be in the knowledge base; <code>notes</code> is ignored.
            </p>

            <form onSubmit={handleUploadInteractions}>
              <div style={{ marginBottom: 12 }}>
                <label className="field" style={{ margin: 0 }}>
                  <span style={{ fontWeight: 600 }}>CSV Content (Paste or Edit):</span>
                  <textarea
                    rows={9}
                    value={intCsv}
                    onChange={(e) => setIntCsv(e.target.value)}
                    disabled={!!intFile}
                    placeholder="drug_a,drug_b,severity&#10;Generic name,Generic name,Major"
                    className="mono small"
                  />
                </label>
              </div>

              <div className="row" style={{ marginBottom: 16, alignItems: "center", gap: 12 }}>
                <label className="field" style={{ flex: 1, margin: 0 }}>
                  <span>Or Upload .csv File:</span>
                  <input
                    type="file"
                    accept=".csv,.txt"
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null;
                      setIntFile(f);
                    }}
                  />
                </label>
                {intFile && (
                  <button
                    type="button"
                    className="btn sm"
                    style={{ alignSelf: "flex-end" }}
                    onClick={() => setIntFile(null)}
                  >
                    ✕ Clear file
                  </button>
                )}
              </div>

              {intError && <div className="error" style={{ marginBottom: 12 }}>{intError}</div>}

              <button type="submit" className="btn primary" disabled={intLoading || (!intCsv && !intFile)}>
                {intLoading ? <span className="spin" /> : "🚀 Ingest Interactions into Active KB"}
              </button>
            </form>
          </div>

          <div>
            {intResult ? (
              <div className="card" style={{ border: "1px solid var(--p3)" }}>
                <div className="row spread" style={{ marginBottom: 10 }}>
                  <h2 style={{ margin: 0, color: "var(--p3)" }}>✓ Ingestion Complete</h2>
                  <span className="badge esc">{intResult.total_interactions_now.toLocaleString()} Total in KB</span>
                </div>
                <div className="grid2" style={{ gap: 8, marginBottom: 12 }}>
                  <div className="card" style={{ padding: "8px 12px", background: "var(--surface)" }}>
                    <div className="small muted">Rows Parsed</div>
                    <b style={{ fontSize: 18 }}>{intResult.total_rows_parsed}</b>
                  </div>
                  <div className="card" style={{ padding: "8px 12px", background: "var(--surface)" }}>
                    <div className="small muted">New Interactions</div>
                    <b style={{ fontSize: 18, color: "var(--p1)" }}>+{intResult.added_interactions}</b>
                  </div>
                  <div className="card" style={{ padding: "8px 12px", background: "var(--surface)" }}>
                    <div className="small muted">Already recorded (unchanged)</div>
                    <b style={{ fontSize: 18, color: "var(--p2)" }}>{intResult.kept_existing}</b>
                  </div>
                  <div className="card" style={{ padding: "8px 12px", background: "var(--surface)" }}>
                    <div className="small muted">Rejected rows</div>
                    <b style={{ fontSize: 18, color: "var(--accent)" }}>{intResult.rejected_rows}</b>
                  </div>
                </div>

                <table>
                  <thead>
                    <tr>
                      <th>Row / pair</th>
                      <th>Severity in KB</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {intResult.added.map((s) => (
                      <tr key={`a${s.source_record_id}`}>
                        <td><b>{s.drug_a} ↔ {s.drug_b}</b></td>
                        <td><Sev s={s.severity as any} /></td>
                        <td><span className="badge synth">added · Hospital upload</span></td>
                      </tr>
                    ))}
                    {intResult.kept.map((s) => (
                      <tr key={`k${s.row}`}>
                        <td><b>{s.drug_a} ↔ {s.drug_b}</b> <span className="small muted">row {s.row}</span></td>
                        <td><Sev s={s.severity as any} /></td>
                        <td className="small">kept: already recorded by {s.source} (upload said {s.uploaded_severity})</td>
                      </tr>
                    ))}
                    {intResult.rejected.map((s) => (
                      <tr key={`r${s.row}`}>
                        <td>{s.drug_a} ↔ {s.drug_b} <span className="small muted">row {s.row}</span></td>
                        <td>—</td>
                        <td className="small" style={{ color: "var(--p1)" }}>rejected: {s.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="card" style={{ background: "var(--accent-soft)" }}>
                <h3>💡 How Interaction Ingestion Works</h3>
                <ul style={{ paddingLeft: 18, lineHeight: 1.6, color: "var(--text)" }}>
                  <li>
                    <b>Canonical Ordering:</b> Pairs are automatically ordered so <code>A ↔ B</code> and <code>B ↔ A</code> map to the same unique relation.
                  </li>
                  <li>
                    <b>Entity Normalization:</b> Drug names resolve through the same dictionary as prescriptions (generic, synonym, brand). Unknown names are rejected, never created.
                  </li>
                  <li>
                    <b>Instant Cache Invalidation:</b> Once ingested, the in-memory lookup cache is cleared. Every subsequent <code>/check</code> request immediately detects these interactions!
                  </li>
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab 2: Clinical Guidelines */}
      {activeTab === "guidelines" && (
        <div className="grid2">
          <div className="card elevated">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <h2 style={{ margin: 0, fontSize: 16 }}>Import Clinical Treatment Guidelines</h2>
              <div className="row" style={{ gap: 6 }}>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => downloadSample(SAMPLE_GUIDELINES_CSV, "sample_guidelines.csv")}
                >
                  📥 Download CSV Template
                </button>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    setGuideFile(null);
                    setGuideCsv(SAMPLE_GUIDELINES_CSV);
                  }}
                >
                  🔄 Load format template
                </button>
              </div>
            </div>

            <p className="small muted" style={{ marginTop: 0 }}>
              Import hospital treatment guidelines or ICMR STWs. Chunks are automatically indexed for RAG retrieval and pharmacist Copilot queries.
            </p>

            <form onSubmit={handleUploadGuidelines}>
              <div className="row" style={{ marginBottom: 12, gap: 10 }}>
                <label className="field" style={{ flex: 2, margin: 0 }}>
                  <span style={{ fontWeight: 600 }}>Document Title:</span>
                  <input
                    type="text"
                    value={guideTitle}
                    onChange={(e) => setGuideTitle(e.target.value)}
                    placeholder="e.g. Hospital Anticoagulation Guidelines 2026"
                    required
                  />
                </label>
                <label className="field" style={{ flex: 1, margin: 0 }}>
                  <span style={{ fontWeight: 600 }}>Doc Type:</span>
                  <select value={guideType} onChange={(e) => setGuideType(e.target.value)}>
                    <option value="GUIDELINE">Clinical guideline</option>
                    <option value="HOSPITAL_PROTOCOL">Hospital protocol</option>
                    <option value="FORMULARY">Formulary note</option>
                  </select>
                </label>
                <label className="field" style={{ flex: 1.5, margin: 0 }}>
                  <span style={{ fontWeight: 600 }}>Source / Committee:</span>
                  <input
                    type="text"
                    value={guideSource}
                    onChange={(e) => setGuideSource(e.target.value)}
                    placeholder="e.g. Pharmacy Committee"
                    required
                  />
                </label>
              </div>

              <div style={{ marginBottom: 12 }}>
                <label className="field" style={{ margin: 0 }}>
                  <span style={{ fontWeight: 600 }}>Guidelines Content (CSV or text paragraphs):</span>
                  <textarea
                    rows={9}
                    value={guideCsv}
                    onChange={(e) => setGuideCsv(e.target.value)}
                    disabled={!!guideFile}
                    placeholder="section,text&#10;&quot;Section heading&quot;,&quot;Exact wording from your approved protocol&quot;"
                    className="mono small"
                  />
                </label>
              </div>

              <div className="row" style={{ marginBottom: 16, alignItems: "center", gap: 12 }}>
                <label className="field" style={{ flex: 1, margin: 0 }}>
                  <span>Or Upload .csv / .txt Document:</span>
                  <input
                    type="file"
                    accept=".csv,.txt"
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null;
                      setGuideFile(f);
                    }}
                  />
                </label>
                {guideFile && (
                  <button
                    type="button"
                    className="btn sm"
                    style={{ alignSelf: "flex-end" }}
                    onClick={() => setGuideFile(null)}
                  >
                    ✕ Clear file
                  </button>
                )}
              </div>

              {guideError && <div className="error" style={{ marginBottom: 12 }}>{guideError}</div>}

              <button type="submit" className="btn primary" disabled={guideLoading || (!guideCsv && !guideFile)}>
                {guideLoading ? <span className="spin" /> : "🚀 Ingest Guidelines into Corpus"}
              </button>
            </form>
          </div>

          <div>
            {guideResult ? (
              <div className="card" style={{ border: "1px solid var(--p3)" }}>
                <div className="row spread" style={{ marginBottom: 10 }}>
                  <h2 style={{ margin: 0, color: "var(--p3)" }}>✓ Guideline Document Indexed</h2>
                  <span className="badge esc">{guideResult.doc_type}</span>
                </div>
                <div className="grid2" style={{ gap: 8, marginBottom: 12 }}>
                  <div className="card" style={{ padding: "8px 12px", background: "var(--surface)" }}>
                    <div className="small muted">Document Title</div>
                    <b style={{ fontSize: 14 }}>{guideResult.document_title}</b>
                  </div>
                  <div className="card" style={{ padding: "8px 12px", background: "var(--surface)" }}>
                    <div className="small muted">Corpus Chunks Created</div>
                    <b style={{ fontSize: 18, color: "var(--accent)" }}>+{guideResult.chunks_created}</b>
                  </div>
                  <div className="card" style={{ padding: "8px 12px", background: "var(--surface)" }}>
                    <div className="small muted">Drug Mentions Linked</div>
                    <b style={{ fontSize: 18, color: "var(--p2)" }}>+{guideResult.drug_mentions_tagged}</b>
                  </div>
                  <div className="card" style={{ padding: "8px 12px", background: "var(--surface)" }}>
                    <div className="small muted">Document ID</div>
                    <b style={{ fontSize: 18 }}>#{guideResult.document_id}</b>
                  </div>
                </div>

                <h3>Preview of Indexed Chunks:</h3>
                {guideResult.sample_chunks.map((sc, idx) => (
                  <div key={idx} className="claim" style={{ marginBottom: 8 }}>
                    <div style={{ width: "100%" }}>
                      <div className="row spread">
                        <b>{sc.section}</b>
                        <div className="row" style={{ gap: 4 }}>
                          {sc.drugs_tagged.map((d) => (
                            <span key={d} className="badge synth" style={{ fontSize: 10 }}>
                              {d}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="small muted" style={{ marginTop: 4 }}>
                        {sc.text_preview}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="card" style={{ background: "var(--accent-soft)" }}>
                <h3>💡 How Guideline Indexing Works</h3>
                <ul style={{ paddingLeft: 18, lineHeight: 1.6, color: "var(--text)" }}>
                  <li>
                    <b>Corpus Document Registration:</b> Documents are registered with SHA-256 provenance in the active knowledge base.
                  </li>
                  <li>
                    <b>Chunk Entity Linking:</b> Each guideline paragraph is automatically scanned for drug mentions and linked via <code>ChunkDrugMention</code> relations.
                  </li>
                  <li>
                    <b>Instant RAG Search:</b> Sections are embedded and added to the search index straight away. They count as evidence only if they pass the same relevance cutoff and verifier as the national guidelines.
                  </li>
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
