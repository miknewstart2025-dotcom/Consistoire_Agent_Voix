"use client";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const KEY = "hotelos.token";

/** Access token kept in sessionStorage only (cleared when the tab closes). */
export const session = {
  get: () => (typeof window === "undefined" ? null : sessionStorage.getItem(KEY)),
  set: (t: string) => sessionStorage.setItem(KEY, t),
  clear: () => sessionStorage.removeItem(KEY),
};

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(typeof body === "object" && body && "code" in body ? String((body as { code: unknown }).code) : `HTTP ${status}`);
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = session.get();
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (res.status === 401 && token) {
    session.clear();
    if (typeof window !== "undefined" && !location.pathname.startsWith("/login")) location.href = "/login";
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const b = e.body as { code?: string; message?: string; issues?: { path: string; message: string }[] } | null;
    if (b?.issues?.length) return b.issues.map((i) => `${i.path || "body"}: ${i.message}`).join(" · ");
    return [b?.code, b?.message].filter(Boolean).join(" – ") || e.message;
  }
  return (e as Error)?.message ?? String(e);
}
