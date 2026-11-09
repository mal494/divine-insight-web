/** Browser client for the Pro Journal API (/api/pro/journal). */
import type { JournalEntry } from "./types";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type JournalResult<T> = { ok: true; value: T } | { ok: false; error: string; status: number };

const BASE = "/api/pro/journal";

async function call<T>(fetchImpl: FetchLike, path: string, init: RequestInit, pick: (b: any) => T): Promise<JournalResult<T>> {
  try {
    const res = await fetchImpl(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
      headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
    });
    if (res.status === 204) return { ok: true, value: pick(null) };
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, status: res.status, error: (body && typeof body.error === "string" && body.error) || "error" };
    return { ok: true, value: pick(body) };
  } catch {
    return { ok: false, status: 0, error: "network_error" };
  }
}

export function journalClient(fetchImpl: FetchLike) {
  return {
    list: () => call(fetchImpl, BASE, { method: "GET" }, (b) => (Array.isArray(b?.entries) ? (b.entries as JournalEntry[]) : [])),
    create: (input: { title: string; note?: string; spread?: string | null; reading?: unknown }) =>
      call(fetchImpl, BASE, { method: "POST", body: JSON.stringify(input) }, (b) => b.entry as JournalEntry),
    update: (id: string, patch: { title?: string; note?: string }) =>
      call(fetchImpl, `${BASE}/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }, (b) => b.entry as JournalEntry),
    remove: (id: string) =>
      call(fetchImpl, `${BASE}/${encodeURIComponent(id)}`, { method: "DELETE" }, () => true as const),
  };
}

export function journalErrorMessage(_error: string, status: number): string {
  if (status === 401) return "Sign in to see your journal.";
  if (status === 403) return "The journal is part of Divine Insight Pro.";
  return "The journal is unavailable right now. Please try again.";
}
