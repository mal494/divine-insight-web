import { beforeEach, describe, expect, test, vi } from "vitest";
import { createPortalSession, createProCheckoutSession, syncSubscription } from "../pro";
import { encodeForm } from "../stripe-api";

const okJson = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.STRIPE_PRO_PRICE_ID = "price_pro";
});

describe("encodeForm", () => {
  test("nests objects stripe-style", () => {
    expect(decodeURIComponent(encodeForm({ a: 1, b: { 0: { p: "x" } }, c: undefined }))).toBe("a=1&b[0][p]=x");
  });
});

describe("createProCheckoutSession", () => {
  test("subscription mode with price from env and user reference", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const fetchImpl = vi.fn(async (_u: string, _i?: RequestInit) => okJson({ url: "https://checkout.stripe.com/x" }));
    const url = await createProCheckoutSession({ userId: "u1", email: "a@b.c", origin: "https://s", db }, fetchImpl);
    expect(url).toBe("https://checkout.stripe.com/x");
    const [u, init] = fetchImpl.mock.calls[0];
    expect(u).toBe("https://api.stripe.com/v1/checkout/sessions");
    const body = decodeURIComponent(String(init?.body));
    expect(body).toContain("mode=subscription");
    expect(body).toContain("line_items[0][price]=price_pro");
    expect(body).toContain("client_reference_id=u1");
    expect(body).toContain("subscription_data[metadata][user_id]=u1");
    expect(body).toContain("customer_email=a@b.c");
    expect(body).not.toContain("trial");
  });
  test("throws without STRIPE_PRO_PRICE_ID", async () => {
    delete process.env.STRIPE_PRO_PRICE_ID;
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    await expect(createProCheckoutSession({ userId: "u1", email: "e", origin: "o", db }, vi.fn())).rejects.toThrow();
  });
});

describe("createPortalSession", () => {
  test("null without a customer", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    expect(await createPortalSession({ userId: "u1", origin: "o", db }, vi.fn())).toBeNull();
  });
  test("returns portal url for known customer", async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ stripe_customer_id: "cus_1" }] })) };
    const fetchImpl = vi.fn(async () => okJson({ url: "https://billing.stripe.com/p" }));
    expect(await createPortalSession({ userId: "u1", origin: "o", db }, fetchImpl)).toBe("https://billing.stripe.com/p");
  });
});

describe("syncSubscription", () => {
  const sub = (over = {}) => ({
    id: "sub_1", status: "active", customer: "cus_1", current_period_end: 1900000000,
    metadata: { user_id: "u1" }, items: { data: [{ price: { id: "price_pro" } }] }, ...over,
  });
  test("upserts entitlement", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    expect(await syncSubscription(sub(), db)).toBe("synced");
    const [q, v] = db.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(q).toMatch(/on conflict \(user_id, plan\)/);
    expect(v).toEqual(["u1", "active", new Date(1900000000 * 1000).toISOString(), "cus_1", "sub_1", "price_pro"]);
  });
  test("ignores other prices", async () => {
    const db = { query: vi.fn() };
    expect(await syncSubscription(sub({ items: { data: [{ price: { id: "price_other" } }] } }), db)).toBe("wrong-price");
    expect(db.query).not.toHaveBeenCalled();
  });
  test("falls back to customer lookup", async () => {
    const db = { query: vi.fn(async (q: string) => ({ rows: q.startsWith("select") ? [{ user_id: "u9" }] : [] })) };
    expect(await syncSubscription(sub({ metadata: {} }), db)).toBe("synced");
    expect((db.query.mock.calls[1] as unknown as [string, unknown[]])[1][0]).toBe("u9");
  });
  test("no-user when unknown", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    expect(await syncSubscription(sub({ metadata: {} }), db)).toBe("no-user");
  });
});
