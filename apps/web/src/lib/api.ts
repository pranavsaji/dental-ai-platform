// Client-side API helper. JWT lives in localStorage for this local demo;
// production would use httpOnly cookies behind a BFF.

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
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem("dental.token");
}

export function setSession(token: string, user: SessionUser): void {
  window.localStorage.setItem("dental.token", token);
  window.localStorage.setItem("dental.user", JSON.stringify(user));
}

export function getUser(): SessionUser | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem("dental.user");
  return raw ? (JSON.parse(raw) as SessionUser) : null;
}

export function clearSession(): void {
  window.localStorage.removeItem("dental.token");
  window.localStorage.removeItem("dental.user");
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
