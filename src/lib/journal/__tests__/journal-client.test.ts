import { describe, expect, test, vi } from "vitest";
import { journalClient, journalErrorMessage, type FetchLike } from "../client";

const res = (body: unknown, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status });

describe("journalClient", () => {
  test("list hits /api/pro/journal with the session cookie", async () => {
    const f = vi.fn<FetchLike>(async () => res({ entries: [{ id: "1" }] }));
    const r = await journalClient(f).list();
    expect(r).toEqual({ ok: true, value: [{ id: "1" }] });
    expect(f.mock.calls[0][0]).toBe("/api/pro/journal");
    expect(f.mock.calls[0][1]?.credentials).toBe("same-origin");
  });
  test("create / update / remove use POST, PATCH, DELETE", async () => {
    const f = vi.fn<FetchLike>(async (_u, init) =>
      init?.method === "DELETE" ? res(null, 204) : res({ entry: { id: "e1" } }, init?.method === "POST" ? 201 : 200),
    );
    const c = journalClient(f);
    expect(await c.create({ title: "t" })).toEqual({ ok: true, value: { id: "e1" } });
    expect(await c.update("e1", { note: "n" })).toEqual({ ok: true, value: { id: "e1" } });
    expect(await c.remove("e1")).toEqual({ ok: true, value: true });
    expect(f.mock.calls.map((x) => [x[0], x[1]?.method])).toEqual([
      ["/api/pro/journal", "POST"],
      ["/api/pro/journal/e1", "PATCH"],
      ["/api/pro/journal/e1", "DELETE"],
    ]);
  });
  test("surfaces 401/403 and network errors", async () => {
    expect(await journalClient(async () => res({ error: "sign_in_required" }, 401)).list()).toEqual({ ok: false, status: 401, error: "sign_in_required" });
    expect(await journalClient(async () => res({ error: "pro_required" }, 403)).list()).toEqual({ ok: false, status: 403, error: "pro_required" });
    expect(await journalClient(async () => { throw new Error("x"); }).list()).toEqual({ ok: false, status: 0, error: "network_error" });
    expect(journalErrorMessage("sign_in_required", 401)).toMatch(/Sign in/);
    expect(journalErrorMessage("pro_required", 403)).toMatch(/Pro/);
  });
});
