import { describe, expect, test, vi } from "vitest";
import { handleProCheckout, type CheckoutDeps } from "../checkout-route";

const req = () => new Request("https://divine.example/api/pro/checkout", { method: "POST" });
const user = { id: "u1", email: "u1@example.com" };

/** Checkout switched on with every Pro Stripe setting present (fake values). */
const ON = {
  PRO_CHECKOUT_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_PRO_PRICE_ID: "price_pro",
  STRIPE_PRO_WEBHOOK_SECRET: "whsec_x",
};

function deps(over: Partial<CheckoutDeps> = {}): CheckoutDeps {
  return {
    getUser: vi.fn(async () => user),
    checkPro: vi.fn(async () => false),
    createSession: vi.fn(async () => "https://checkout.stripe.com/x"),
    db: () => ({ query: vi.fn() }),
    env: ON,
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

describe("PRO_CHECKOUT_ENABLED kill switch", () => {
  /** Deps whose every side-effecting call is a spy, plus a db factory spy. */
  function spied(env: Record<string, string | undefined>) {
    const query = vi.fn();
    const db = vi.fn(() => ({ query }));
    const d = deps({ env, db });
    return { d, db, query };
  }

  test.each([
    ["unset", {}],
    ["empty", { PRO_CHECKOUT_ENABLED: "" }],
    ["not exactly true", { PRO_CHECKOUT_ENABLED: "TRUE" }],
    ["1", { PRO_CHECKOUT_ENABLED: "1" }],
  ])("%s -> 503 checkout_paused with no DB read and no Stripe call (even with Stripe keys set)", async (_n, flag) => {
    const { PRO_CHECKOUT_ENABLED: _drop, ...keys } = ON;
    const { d, db, query } = spied({ ...keys, ...flag });
    const res = await handleProCheckout(req(), d);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "checkout_paused" });
    expect(d.checkPro).not.toHaveBeenCalled();
    expect(d.createSession).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  test("signed out is still 401 while paused", async () => {
    const d = deps({ env: {}, getUser: vi.fn(async () => null) });
    const res = await handleProCheckout(req(), d);
    expect(res.status).toBe(401);
  });

  test("defaults to process.env, where the flag is unset -> paused", async () => {
    vi.stubEnv("PRO_CHECKOUT_ENABLED", "");
    const d = deps({ env: undefined });
    const res = await handleProCheckout(req(), d);
    vi.unstubAllEnvs();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "checkout_paused" });
    expect(d.checkPro).not.toHaveBeenCalled();
  });

  test.each(["STRIPE_SECRET_KEY", "STRIPE_PRO_PRICE_ID", "STRIPE_PRO_WEBHOOK_SECRET"])(
    "enabled but %s missing -> 503 checkout_unavailable, no customer, no DB, names logged not values",
    async (name) => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { d, db, query } = spied({ ...ON, [name]: "" });
      const res = await handleProCheckout(req(), d);
      const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
      spy.mockRestore();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "checkout_unavailable" });
      expect(d.checkPro).not.toHaveBeenCalled();
      expect(d.createSession).not.toHaveBeenCalled();
      expect(db).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(logged).toContain(name);
      expect(logged).not.toContain("sk_test_x");
    },
  );

  test("enabled with full config -> 200 and a Checkout URL", async () => {
    const d = deps({ env: ON });
    const res = await handleProCheckout(req(), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://checkout.stripe.com/x" });
    expect(d.checkPro).toHaveBeenCalledWith("u1");
    expect(d.createSession).toHaveBeenCalledTimes(1);
  });
});
