// Minimal hash router: #/check, #/rx/12, #/queue, #/patients/<id>, #/evaluation.
// Falls back to in-memory state when the hash cannot be written (sandboxed previews).
import { useEffect, useState } from "react";

let current = readHash();
const listeners = new Set<() => void>();

function readHash() {
  try {
    const h = window.location.hash.replace(/^#/, "");
    return h.startsWith("/") ? h : "/check";
  } catch {
    return "/check";
  }
}

export function navigate(path: string) {
  current = path;
  try {
    if (window.location.hash !== `#${path}`) window.location.hash = path;
  } catch {
    /* ignore */
  }
  listeners.forEach((f) => f());
  window.scrollTo?.({ top: 0 });
}

if (typeof window !== "undefined") {
  window.addEventListener("hashchange", () => {
    const h = readHash();
    if (h !== current) {
      current = h;
      listeners.forEach((f) => f());
    }
  });
}

export function useRoute(): string[] {
  const [path, setPath] = useState(current);
  useEffect(() => {
    const f = () => setPath(current);
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, []);
  const [base, query] = path.split("?");
  const parts = base.split("/").filter(Boolean);
  if (query) parts.push(`?${query}`);
  return parts;
}

export function Link({ to, children, className, ...rest }: { to: string; children: React.ReactNode; className?: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      href={`#${to}`}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
