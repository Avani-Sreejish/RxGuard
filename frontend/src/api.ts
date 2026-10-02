// API client. Every request carries a fresh X-Request-ID so errors can quote a correlation ID.
// In demo mode the same calls are answered in the browser by mock.ts (no backend needed).
import { mockApi } from "./mock";

export class ApiError extends Error {
  status: number;
  code: string;
  correlationId: string;
  details: unknown;
  constructor(status: number, body: any) {
    // Most endpoints send {"error": {"code", "message"}}; the dataset upload endpoints send {"error": "text"}.
    const e = body?.error;
    super((typeof e === "string" ? e : e?.message) ?? `HTTP ${status}`);
    this.status = status;
    this.code = (typeof e === "string" ? "error" : e?.code) ?? "error";
    this.correlationId = body?.error?.correlation_id ?? "";
    this.details = body?.error?.details;
  }
}

const TOKEN_KEY = "rxguard.token";
const DEMO_KEY = "rxguard.demo";
let memToken: string | null = null;
let memDemo = false;

/** Build-time switch for the static preview: the app runs on demo data only. */
export const DEMO_ONLY = import.meta.env.VITE_DEMO_ONLY === "1";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, v);
  } catch {
    /* storage unavailable: keep in memory for this tab */
  }
}

export function getToken(): string | null {
  return read(TOKEN_KEY) ?? memToken;
}
export function setToken(t: string | null) {
  memToken = t;
  write(TOKEN_KEY, t);
}
export function isDemo(): boolean {
  return DEMO_ONLY || read(DEMO_KEY) === "1" || memDemo;
}
export function setDemo(on: boolean) {
  memDemo = on;
  write(DEMO_KEY, on ? "1" : null);
}

function rid() {
  return (crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^a-z0-9]/gi, "").slice(0, 32);
}

export interface ApiOpts {
  method?: string;
  body?: unknown;
  form?: FormData;
}

export async function api<T = any>(path: string, opts: ApiOpts = {}): Promise<T> {
  if (isDemo()) {
    try {
      return (await mockApi(path, opts)) as T;
    } catch (e: any) {
      if (e && typeof e.status === "number") throw new ApiError(e.status, e.body);
      throw e;
    }
  }
  const headers: Record<string, string> = { "X-Request-ID": rid() };
  const token = getToken();
  if (token) headers.Authorization = `Token ${token}`;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method: opts.method ?? (body ? "POST" : "GET"), headers, body });
  } catch {
    throw new ApiError(0, { error: { code: "network", message: "Cannot reach the RxGuard server. Check that the backend is running." } });
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: { message: text.slice(0, 200) } };
  }
  if (res.status === 401 && getToken()) {
    setToken(null);
    window.dispatchEvent(new Event("rxguard:signed-out"));
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}
