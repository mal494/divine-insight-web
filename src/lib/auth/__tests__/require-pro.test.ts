import { describe, expect, test, vi } from "vitest";
import { requirePro, withPro, type ProGuardDeps } from "../require-pro";

const req = () => new Request("https://divine.example/api/pro/anything");
const user = { id: "u1", email: "u1@example.com" };

function deps(over: Partial<ProGuardDeps> = {}): ProGuardDeps {
  return {
    getUser: vi.fn(async () => user),
    checkPro: vi.fn(async () => true),
    ...over,
  };
}

describe("requirePro", () => {
  test("401 sign_in_required when signed out, without checking entitlements", async () => {
    const d = deps({ getUser: vi.fn(async () => null) });
    const r = await requirePro(req(), d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(401);
    expect(await r.response.json()).toEqual({ error: "sign_in_required" });
    expect(d.checkPro).not.toHaveBeenCalled();
  });

  test("403 pro_required for a signed-in non-Pro user", async () => {
    const d = deps({ checkPro: vi.fn(async () => false) });
    const r = await requirePro(req(), d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(403);
    expect(await r.response.json()).toEqual({ error: "pro_required" });
    expect(d.checkPro).toHaveBeenCalledWith("u1");
  });

  test("ok with the user for a Pro user", async () => {
    const r = await requirePro(req(), deps());
    expect(r).toEqual({ ok: true, user });
  });

  test("fails closed with 503 when the entitlement lookup throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await requirePro(req(), deps({ checkPro: vi.fn(async () => { throw new Error("db down"); }) }));
    spy.mockRestore();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(503);
    expect(r.response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("withPro", () => {
  const handler = vi.fn(async ({ user: u }: { request: Request; user: { id: string } }) =>
    new Response(JSON.stringify({ hello: u.id }), { status: 200 }),
  );

  test("signed out -> 401 and the handler never runs", async () => {
    handler.mockClear();
    const res = await withPro<{ request: Request }>(handler, deps({ getUser: vi.fn(async () => null) }))({ request: req() });
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  test("non-Pro -> 403 and the handler never runs", async () => {
    handler.mockClear();
    const res = await withPro<{ request: Request }>(handler, deps({ checkPro: vi.fn(async () => false) }))({ request: req() });
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  test("Pro -> handler runs with the user", async () => {
    handler.mockClear();
    const res = await withPro<{ request: Request }>(handler, deps())({ request: req() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: "u1" });
  });
});
