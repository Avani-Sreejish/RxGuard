// Thin API client. Every request carries a fresh X-Request-ID so the UI can show correlation IDs.
export class ApiError extends Error {
  status: number;
  code: string;
  correlationId: string;
  details: unknown;
  constructor(status: number, body: any) {
    super(body?.error?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.error?.code ?? "error";
    this.correlationId = body?.error?.correlation_id ?? "";
    this.details = body?.error?.details;
  }
}

const TOKEN_KEY = "rxguard.token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(t: string | null) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: session-only login */
  }
}

function rid() {
  return crypto.randomUUID().replace(/-/g, "");
}

export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: unknown; form?: FormData; simulate?: string[] } = {},
): Promise<T> {
  const headers: Record<string, string> = { "X-Request-ID": rid() };
  const token = getToken();
  if (token) headers.Authorization = `Token ${token}`;
  if (opts.simulate?.length) headers["X-RxGuard-Simulate"] = opts.simulate.join(",");
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { method: opts.method ?? (body ? "POST" : "GET"), headers, body });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: { message: text.slice(0, 200) } };
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}
