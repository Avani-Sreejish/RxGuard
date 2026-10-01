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
  updated_interactions: number;
  new_drugs_created: number;
  total_interactions_now: number;
  sample: Array<{
    drug_a: string;
    drug_b: string;
    severity: string;
    status: string;
    notes?: string;
  }>;
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

const SAMPLE_INTERACTIONS_CSV = `drug_a,drug_b,severity,notes
Amiodarone,Ciprofloxacin,Major,High risk of QT prolongation and torsades de pointes ventricular arrhythmia
Metformin,Iodinated Contrast,Major,Risk of fatal lactic acidosis and acute contrast-induced nephrotoxicity
Warfarin,Tramadol,Moderate,Elevated INR and increased hypoprothrombinemic bleeding risk
Levothyroxine,Calcium Carbonate,Moderate,Decreased levothyroxine GI absorption; administer 4 hours apart
Atorvastatin,Clarithromycin,Major,Marked increase in statin plasma concentration; risk of rhabdomyolysis`;

const SAMPLE_GUIDELINES_CSV = `section,text,drugs
Cardiology - Arrhythmia & QT Risk,Concomitant administration of Amiodarone and Ciprofloxacin markedly increases the risk of QT interval prolongation and torsades de pointes ventricular arrhythmia. Concurrent use is contraindicated or requires continuous telemetry monitoring with electrolyte correction.,Amiodarone, Ciprofloxacin
Endocrinology - Metformin & Radiocontrast,Patients receiving Metformin must withhold medication at the time of or prior to iodinated radiocontrast imaging procedures and for 48 hours post-procedure due to acute renal failure and fatal lactic acidosis risk.,Metformin
Hematology - Warfarin Potentiation,Tramadol inhibits CYP2D6 and may enhance the hypoprothrombinemic effect of Warfarin. Monitor INR closely within 3 to 5 days of initiation.,Warfarin, Tramadol`;

export default function DatasetIngestion() {
  const [activeTab, setActiveTab] = useState<"interactions" | "guidelines">("interactions");
  const [stats, setStats] = useState<KbStats | null>(null);

  // Interactions State
  const [intSource, setIntSource] = useState("Hospital_Formulary_2026");
  const [intCsv, setIntCsv] = useState(SAMPLE_INTERACTIONS_CSV);
  const [intFile, setIntFile] = useState<File | null>(null);
  const [intLoading, setIntLoading] = useState(false);
  const [intResult, setIntResult] = useState<IngestInteractionResult | null>(null);
  const [intError, setIntError] = useState("");

  // Guidelines State
  const [guideTitle, setGuideTitle] = useState("Hospital Clinical Practice Protocol 2026");
  const [guideType, setGuideType] = useState("CLINICAL_GUIDELINE");
  const [guideSource, setGuideSource] = useState("Hospital_Pharmacy_Committee");
  const [guideCsv, setGuideCsv] = useState(SAMPLE_GUIDELINES_CSV);
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
        form.append("source", intSource);
        res = await api<IngestInteractionResult>("/api/v1/kb/interactions/upload", { form });
      } else {
        res = await api<IngestInteractionResult>("/api/v1/kb/interactions/upload", {
          body: { csv_text: intCsv, source: intSource },
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
            Add custom drug-drug interaction CSV datasets and clinical treatment guidelines into RxGuard's verified knowledge engine.
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
                  🔄 Load Example
                </button>
              </div>
            </div>

            <p className="small muted" style={{ marginTop: 0 }}>
              Expected columns: <code>drug_a</code>, <code>drug_b</code>, <code>severity</code> (Major, Moderate, Minor, or Unknown), and optional <code>notes</code>.
            </p>

            <form onSubmit={handleUploadInteractions}>
              <div className="row" style={{ marginBottom: 12 }}>
                <label className="field" style={{ flex: 1, margin: 0 }}>
                  <span style={{ fontWeight: 600 }}>Formulary / Source Name:</span>
                  <input
                    type="text"
                    value={intSource}
                    onChange={(e) => setIntSource(e.target.value)}
                    placeholder="e.g. Apollo_Hospital_Formulary_2026"
                    required
                  />
                </label>
              </div>

              <div style={{ marginBottom: 12 }}>
                <label className="field" style={{ margin: 0 }}>
                  <span style={{ fontWeight: 600 }}>CSV Content (Paste or Edit):</span>
                  <textarea
                    rows={9}
                    value={intCsv}
                    onChange={(e) => setIntCsv(e.target.value)}
                    disabled={!!intFile}
                    placeholder="drug_a,drug_b,severity,notes&#10;Amiodarone,Ciprofloxacin,Major,QT prolongation risk"
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
                    <div className="small muted">Updated Pairs</div>
                    <b style={{ fontSize: 18, color: "var(--p2)" }}>{intResult.updated_interactions}</b>
                  </div>
                  <div className="card" style={{ padding: "8px 12px", background: "var(--surface)" }}>
                    <div className="small muted">New Molecules Registered</div>
                    <b style={{ fontSize: 18, color: "var(--accent)" }}>+{intResult.new_drugs_created}</b>
                  </div>
                </div>

                <h3>Sample Ingested Pairs:</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Pair</th>
                      <th>Severity</th>
                      <th>Status</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {intResult.sample.map((s, idx) => (
                      <tr key={idx}>
                        <td><b>{s.drug_a} ↔ {s.drug_b}</b></td>
                        <td><Sev s={s.severity as any} /></td>
                        <td><span className="badge synth">{s.status}</span></td>
                        <td className="small muted">{s.notes || "—"}</td>
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
                    <b>Entity Normalization:</b> Drug names are normalized using INN/USAN rules. Missing drugs are automatically registered into the active KB version.
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
                  🔄 Load Example
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
                    <option value="CLINICAL_GUIDELINE">Clinical Guideline</option>
                    <option value="ICMR_STW">ICMR STW</option>
                    <option value="HOSPITAL_POLICY">Hospital Policy</option>
                    <option value="FORMULARY_NOTE">Formulary Note</option>
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
                    placeholder="section,text,drugs&#10;Cardiology - Arrhythmia,Amiodarone and Ciprofloxacin should not be combined...,Amiodarone, Ciprofloxacin"
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
                    <b>Instant RAG Search:</b> Pharmacists can immediately query these guidelines using the AI Copilot (<code>AskPanel</code>) or during prescription explanation verification.
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
