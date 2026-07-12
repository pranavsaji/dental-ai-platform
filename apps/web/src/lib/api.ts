// Client-side API helper. F2: the session JWT lives in an httpOnly cookie set
// by the API (XSS cannot read it); every request sends credentials and
// mutations echo the CSRF double-submit cookie as X-CSRF-Token. localStorage
// keeps only the non-sensitive user profile for instant shell rendering —
// authorization always comes from the cookie, never from localStorage.

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4100";

export interface SessionUser {
  sub: number;
  orgId: number;
  email: string;
  name: string;
  role: string;
  locationId: number | null;
}

export interface Location {
  id: number;
  key: string;
  name: string;
  // Integration provenance (A1): what the edge last reported via heartbeat.
  integrationMode?: string; // api | mysql | mock | unknown
  integrationStatus?: string; // live | degraded | unknown
  lastHeartbeatAt?: string | null;
}

export function setSession(user: SessionUser): void {
  window.localStorage.setItem("dental.user", JSON.stringify(user));
}

export function getUser(): SessionUser | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem("dental.user");
  return raw ? (JSON.parse(raw) as SessionUser) : null;
}

export function clearSession(): void {
  window.localStorage.removeItem("dental.user");
  // Best-effort cookie clear; ignore failures (we're leaving anyway).
  void fetch(`${API_URL}/auth/logout`, { method: "POST", credentials: "include" }).catch(() => {});
}

function csrfToken(): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "dental_csrf") return decodeURIComponent(v.join("="));
  }
  return null;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const csrf = MUTATING.has(method) ? csrfToken() : null;
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      ...init?.headers
    }
  });
  if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/auth")) {
    clearSession();
    window.location.href = "/login";
    throw new ApiError(401, "Unauthorized");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(res.status, body.slice(0, 300) || res.statusText);
  }
  return res.json() as Promise<T>;
}
