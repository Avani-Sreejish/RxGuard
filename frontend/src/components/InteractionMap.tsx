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
  const W = 560, H = 360, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 60;
  const pos = new Map<string, [number, number]>();
  [...ids.map((i) => `d${i}`), ...unresolved.map((u) => `u${u.id}`)].forEach((k, i) => {
    const a = (2 * Math.PI * i) / Math.max(n, 1) - Math.PI / 2;
    pos.set(k, n === 1 ? [cx, cy] : [cx + R * Math.cos(a), cy + R * Math.sin(a)]);
  });

  return (
    <div className="map">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Prescription interaction map">
        {rx.findings.map((f) => {
          const [x1, y1] = pos.get(`d${f.drug_a_id}`)!;
          const [x2, y2] = pos.get(`d${f.drug_b_id}`)!;
          const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
          const sel = selected === f.id;
          const ev = f.evidence_status === "FOUND" ? "✓ev" : f.evidence_status === "INSUFFICIENT" ? "no ev" : "";
          return (
            <g key={f.id} style={{ cursor: "pointer" }} onClick={() => onSelect(f.id)}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={14} />
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={SEV_COLOR[f.severity]}
                strokeWidth={sel ? 5 : f.severity === "Major" ? 3.5 : 2}
                strokeDasharray={f.severity === "Unknown" ? "4 4" : undefined} opacity={selected && !sel ? 0.35 : 1} />
              <rect x={mx - 44} y={my - 11} width={88} height={22} rx={4} fill="var(--surface)"
                stroke={SEV_COLOR[f.severity]} />
              <text x={mx} y={my + 4} textAnchor="middle" fontSize={10.5} fill="var(--text)" fontWeight={600}>
                #{f.ordinal} {f.severity} {ev}
                {f.review_status !== "pending" ? " ●" : ""}
              </text>
            </g>
          );
        })}
        {ids.map((id) => {
          const [x, y] = pos.get(`d${id}`)!;
          const hub = (degree.get(id) ?? 0) >= 2;
          const dup = dupDrugs.has(drugs.get(id)!);
          return (
            <g key={id} className="node">
              {dup && <circle cx={x} cy={y} r={27} fill="none" stroke="var(--synth)" strokeDasharray="3 3" strokeWidth={2} />}
              <circle cx={x} cy={y} r={21} fill={hub ? "var(--accent-soft)" : "var(--surface)"}
                stroke={hub ? "var(--accent)" : "var(--border)"} strokeWidth={hub ? 3 : 2} />
              <text x={x} y={y + 38} textAnchor="middle" fontSize={11.5} fontWeight={600} fill="var(--text)">
                {drugs.get(id)!.length > 22 ? drugs.get(id)!.slice(0, 21) + "…" : drugs.get(id)}
              </text>
              <text x={x} y={y + 4} textAnchor="middle" fontSize={10} fill="var(--muted)" fontWeight={700}>
                {hub ? "HUB" : dup ? "×2" : ""}
              </text>
            </g>
          );
        })}
        {unresolved.map((u) => {
          const [x, y] = pos.get(`u${u.id}`)!;
          return (
            <g key={u.id}>
              <circle cx={x} cy={y} r={21} fill="var(--insuff-soft)" stroke="var(--insuff)" strokeDasharray="4 3" strokeWidth={2} />
              <text x={x} y={y + 4} textAnchor="middle" fontSize={14} fill="var(--insuff)" fontWeight={800}>?</text>
              <text x={x} y={y + 38} textAnchor="middle" fontSize={11} fill="var(--insuff)">
                line {u.line_no}: unresolved
              </text>
            </g>
          );
        })}
      </svg>
      <div className="legend">
        <span><b style={{ color: "var(--p1)" }}>━</b> Major</span>
        <span><b style={{ color: "var(--p2)" }}>━</b> Moderate</span>
        <span><b style={{ color: "var(--muted)" }}>┅</b> Minor / Unknown</span>
        <span><b style={{ color: "var(--accent)" }}>◯</b> hub (≥2 documented interactions)</span>
        <span><b style={{ color: "var(--synth)" }}>◌</b> duplicate ingredient</span>
        <span><b style={{ color: "var(--insuff)" }}>?</b> unresolved</span>
        <span>● reviewed</span>
      </div>
      <p className="small muted" style={{ margin: "6px 0 0" }}>{rx.pairwise_notice}</p>
    </div>
  );
}
