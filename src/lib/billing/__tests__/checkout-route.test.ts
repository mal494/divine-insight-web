import { describe, expect, test, vi } from "vitest";
import { handleProCheckout, type CheckoutDeps } from "../checkout-route";

const req = () => new Request("https://divine.example/api/pro/checkout", { method: "POST" });
const user = { id: "u1", email: "u1@example.com" };

function deps(over: Partial<CheckoutDeps> = {}): CheckoutDeps {
  return {
    getUser: vi.fn(async () => user),
    checkPro: vi.fn(async () => false),
    createSession: vi.fn(async () => "https://checkout.stripe.com/x"),
    db: () => ({ query: vi.fn() }),
    ...over,
  };
}

describe("POST /api/pro/checkout", () => {
  test("401 when signed out", async () => {
    const d = deps({ getUser: vi.fn(async () => null) });
    const res = await handleProCheckout(req(), d);
    expect(res.status).toBe(401);
    expect(d.createSession).not.toHaveBeenCalled();
  });

  test("409 already_subscribed for an existing Pro user; no second Checkout Session", async () => {
    const d = deps({ checkPro: vi.fn(async () => true) });
    const res = await handleProCheckout(req(), d);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already_subscribed", manage: "/api/pro/portal" });
    expect(d.checkPro).toHaveBeenCalledWith("u1");
    expect(d.createSession).not.toHaveBeenCalled();
  });

  test("non-Pro user gets a Checkout URL", async () => {
    const d = deps();
    const res = await handleProCheckout(req(), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://checkout.stripe.com/x" });
    expect(d.createSession).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", email: "u1@example.com" }));
  });

  test("503 (and no session) when the entitlement check fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps({ checkPro: vi.fn(async () => { throw new Error("db down"); }) });
    const res = await handleProCheckout(req(), d);
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect(d.createSession).not.toHaveBeenCalled();
  });

  test("503 session_unavailable (not 401) when the session lookup throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps({ getUser: vi.fn(async () => { throw new Error("db down"); }) });
    const res = await handleProCheckout(req(), d);
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "session_unavailable" });
    expect(d.createSession).not.toHaveBeenCalled();
  });
});
