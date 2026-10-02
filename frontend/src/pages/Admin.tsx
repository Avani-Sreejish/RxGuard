// Administrator tools, kept out of the pharmacist's everyday screens.
import DatasetIngestion from "./DatasetIngestion";
import Sources from "./Sources";

const SECTIONS: [string, string][] = [
  ["uploads", "Upload data"],
  ["sources", "Data sources & licences"],
];

export default function Admin({ section }: { section?: string }) {
  const current = SECTIONS.some(([k]) => k === section) ? section! : "uploads";
  return (
    <>
      <div className="seg" role="tablist" aria-label="Knowledge base" style={{ marginBottom: 20 }}>
        {SECTIONS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={current === k} className={current === k ? "on" : ""}
            onClick={() => (window.location.hash = `/admin/${k}`)}>
            {label}
          </button>
        ))}
      </div>
      {current === "uploads" ? <DatasetIngestion /> : <Sources />}
    </>
  );
}
