import { useState } from "react";
import type { Prescription } from "../types";

const SEV_COLOR: Record<string, string> = {
  Major: "var(--p1)",
  Moderate: "var(--p2)",
  Minor: "var(--muted)",
  Unknown: "var(--muted)",
};

interface Props {
  rx: Prescription;
  selected: number | null;
  onSelect: (findingId: number) => void;
}

export default function InteractionMap({ rx, selected, onSelect }: Props) {
  const [hoveredDrug, setHoveredDrug] = useState<string | null>(null);

  const drugs = new Map<number, string>();
  rx.items.forEach((i) => i.drug_id && i.drug && drugs.set(i.drug_id, i.drug));
  const unresolved = rx.items.filter((i) => !i.drug_id && i.method !== "pharmacist");
  const degree = new Map<number, number>();
  rx.findings.forEach((f) => {
    degree.set(f.drug_a_id, (degree.get(f.drug_a_id) ?? 0) + 1);
    degree.set(f.drug_b_id, (degree.get(f.drug_b_id) ?? 0) + 1);
  });
  const dupDrugs = new Set(rx.duplications.map((d) => d.drug));

  const ids = [...drugs.keys()];
  const n = ids.length + unresolved.length;
  const W = 580,
    H = 360,
    cx = W / 2,
    cy = H / 2,
    R = Math.min(W, H) / 2 - 62;
  const pos = new Map<string, [number, number]>();

  [...ids.map((i) => `d${i}`), ...unresolved.map((u) => `u${u.id}`)].forEach((k, i) => {
    const a = (2 * Math.PI * i) / Math.max(n, 1) - Math.PI / 2;
    pos.set(k, n === 1 ? [cx, cy] : [cx + R * Math.cos(a), cy + R * Math.sin(a)]);
  });

  const majorCount = rx.findings.filter((f) => f.severity === "Major").length;
  const moderateCount = rx.findings.filter((f) => f.severity === "Moderate").length;

  return (
    <div className="map card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 14 }}>
          <span>🌐</span> Interaction Topology Map
        </h2>
        <div style={{ display: "flex", gap: 6, fontSize: 11.5 }}>
          {majorCount > 0 && (
            <span className="badge esc" style={{ padding: "2px 6px" }}>
              {majorCount} Major
            </span>
          )}
          {moderateCount > 0 && (
            <span className="badge degraded" style={{ padding: "2px 6px" }}>
              {moderateCount} Moderate
            </span>
          )}
          <span className="small muted">
            {ids.length} drugs · {rx.findings.length} pairs
          </span>
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Prescription interaction map">
        <defs>
          <filter id="glow-rose" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="0" stdDeviation="3" floodColor="#f43f5e" floodOpacity="0.6" />
          </filter>
          <filter id="glow-blue" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="0" stdDeviation="3" floodColor="#3b82f6" floodOpacity="0.5" />
          </filter>
        </defs>

        {/* Clear State indicator when 0 interactions exist */}
        {rx.findings.length === 0 && (
          <g>
            <rect
              x={W / 2 - 140}
              y={H / 2 - 16}
              width={280}
              height={32}
              rx={16}
              fill="var(--surface)"
              stroke="var(--p3)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              style={{ filter: "var(--shadow-sm)" }}
            />
            <text
              x={W / 2}
              y={H / 2 + 4}
              textAnchor="middle"
              fontSize={11}
              fill="var(--text)"
              fontWeight={700}
            >
              ✓ 0 DDInter interactions detected (Clear)
            </text>
          </g>
        )}

        {/* Interaction Lines / Chords */}
        {rx.findings.map((f) => {
          const posA = pos.get(`d${f.drug_a_id}`);
          const posB = pos.get(`d${f.drug_b_id}`);
          if (!posA || !posB) return null;
          const [x1, y1] = posA;
          const [x2, y2] = posB;
          const mx = (x1 + x2) / 2,
            my = (y1 + y2) / 2;
          const sel = selected === f.id;
          const ev = f.evidence_status === "FOUND" ? "✓ev" : f.evidence_status === "INSUFFICIENT" ? "no ev" : "";
          const isMajor = f.severity === "Major";

          return (
            <g
              key={f.id}
              style={{ cursor: "pointer" }}
              onClick={() => onSelect(f.id)}
              filter={sel ? (isMajor ? "url(#glow-rose)" : "url(#glow-blue)") : undefined}
            >
              {/* Invisible wide hit area for easy clicking */}
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={18} />
              <line
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={SEV_COLOR[f.severity]}
                strokeWidth={sel ? 5.5 : isMajor ? 3.5 : 2}
                strokeDasharray={f.severity === "Unknown" ? "4 4" : undefined}
                opacity={selected && !sel ? 0.3 : 1}
              />
              <rect
                x={mx - 46}
                y={my - 12}
                width={92}
                height={24}
                rx={6}
                fill="var(--surface)"
                stroke={sel ? "var(--accent)" : SEV_COLOR[f.severity]}
                strokeWidth={sel ? 2 : 1.2}
                style={{ filter: "var(--shadow-sm)" }}
              />
              <text
                x={mx}
                y={my + 4}
                textAnchor="middle"
                fontSize={10.5}
                fill="var(--text)"
                fontWeight={700}
                letterSpacing="0.02em"
              >
                #{f.ordinal} {f.severity} {ev}
                {f.review_status !== "pending" ? " ●" : ""}
              </text>
            </g>
          );
        })}

        {/* Drug Nodes */}
        {ids.map((id) => {
          const p = pos.get(`d${id}`);
          if (!p) return null;
          const [x, y] = p;
          const name = drugs.get(id) ?? "";
          const hub = (degree.get(id) ?? 0) >= 2;
          const dup = dupDrugs.has(name);
          const isHovered = hoveredDrug === name;

          return (
            <g
              key={id}
              className="node"
              style={{ cursor: "pointer" }}
              onMouseEnter={() => setHoveredDrug(name)}
              onMouseLeave={() => setHoveredDrug(null)}
            >
              {dup && (
                <circle
                  cx={x}
                  cy={y}
                  r={29}
                  fill="none"
                  stroke="var(--synth)"
                  strokeDasharray="3 3"
                  strokeWidth={2}
                />
              )}
              {hub && (
                <circle
                  cx={x}
                  cy={y}
                  r={26}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={1.5}
                  opacity={0.4}
                />
              )}
              <circle
                cx={x}
                cy={y}
                r={22}
                fill={hub ? "var(--accent-soft)" : "var(--surface)"}
                stroke={isHovered ? "var(--accent)" : hub ? "var(--accent)" : "var(--border)"}
                strokeWidth={isHovered ? 3.5 : hub ? 2.5 : 2}
              />
              <text
                x={x}
                y={y + 40}
                textAnchor="middle"
                fontSize={11.5}
                fontWeight={700}
                fill="var(--text)"
              >
                {name.length > 20 ? name.slice(0, 19) + "…" : name}
              </text>
              <text
                x={x}
                y={y + 4}
                textAnchor="middle"
                fontSize={9.5}
                fill={hub ? "var(--accent)" : "var(--muted)"}
                fontWeight={800}
              >
                {hub ? "HUB" : dup ? "×2" : `${degree.get(id) ?? 0} int`}
              </text>
            </g>
          );
        })}

        {/* Unresolved Nodes */}
        {unresolved.map((u) => {
          const p = pos.get(`u${u.id}`);
          if (!p) return null;
          const [x, y] = p;
          return (
            <g key={u.id}>
              <circle
                cx={x}
                cy={y}
                r={22}
                fill="var(--insuff-soft)"
                stroke="var(--insuff)"
                strokeDasharray="4 3"
                strokeWidth={2}
              />
              <text x={x} y={y + 5} textAnchor="middle" fontSize={15} fill="var(--insuff)" fontWeight={900}>
                ?
              </text>
              <text x={x} y={y + 40} textAnchor="middle" fontSize={11} fill="var(--insuff)" fontWeight={600}>
                line {u.line_no}: unresolved
              </text>
            </g>
          );
        })}
      </svg>

      <div className="legend">
        <span>
          <b style={{ color: "var(--p1)" }}>━</b> Major (Contraindicated)
        </span>
        <span>
          <b style={{ color: "var(--p2)" }}>━</b> Moderate (Monitor)
        </span>
        <span>
          <b style={{ color: "var(--muted)" }}>┅</b> Minor / Unknown
        </span>
        <span>
          <b style={{ color: "var(--accent)" }}>◯</b> Hub (≥2 interactions)
        </span>
        <span>
          <b style={{ color: "var(--synth)" }}>◌</b> Duplicate Active Ingredient
        </span>
        <span>
          <b style={{ color: "var(--insuff)" }}>?</b> Unresolved Molecule
        </span>
        <span>● Reviewed by Pharmacist</span>
      </div>
      <p className="small muted" style={{ margin: "8px 0 0" }}>
        {rx.pairwise_notice}
      </p>
    </div>
  );
}
