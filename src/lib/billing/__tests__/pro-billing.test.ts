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
  test("subscription mode with price from env, user reference and the stored customer", async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ stripe_customer_id: "cus_1" }] })) };
    const fetchImpl = vi.fn(async (_u: string, _i?: RequestInit) => okJson({ url: "https://checkout.stripe.com/x" }));
    const url = await createProCheckoutSession({ userId: "u1", email: "a@b.c", origin: "https://s", db }, fetchImpl);
    expect(url).toBe("https://checkout.stripe.com/x");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [u, init] = fetchImpl.mock.calls[0];
    expect(u).toBe("https://api.stripe.com/v1/checkout/sessions");
    const body = decodeURIComponent(String(init?.body));
    expect(body).toContain("mode=subscription");
    expect(body).toContain("line_items[0][price]=price_pro");
    expect(body).toContain("client_reference_id=u1");
    expect(body).toContain("subscription_data[metadata][user_id]=u1");
    expect(body).toContain("customer=cus_1");
    expect(body).not.toContain("customer_email");
    expect(body).not.toContain("trial");
  });
  test("throws without STRIPE_PRO_PRICE_ID", async () => {
    delete process.env.STRIPE_PRO_PRICE_ID;
    const db = { query: vi.fn(async () => ({ rows: [{ stripe_customer_id: "cus_1" }] })) };
    await expect(createProCheckoutSession({ userId: "u1", email: "e", origin: "o", db }, vi.fn())).rejects.toThrow();
  });
});

describe("Stripe customer created before the first checkout", () => {
  /** Fake entitlements table: one row per user, coalescing stripe_customer_id like the SQL. */
  function custDb() {
    const rows = new Map<string, { status: string; stripe_customer_id: string | null }>();
    const query = vi.fn(async (q: string, v: unknown[]) => {
      if (q.startsWith("select stripe_customer_id")) {
        const r = rows.get(v[0] as string);
        return { rows: r?.stripe_customer_id ? [{ stripe_customer_id: r.stripe_customer_id }] : [] };
      }
      if (q.includes("insert into entitlements") && q.includes("'incomplete'")) {
        expect(q).toMatch(/coalesce\(entitlements\.stripe_customer_id, excluded\.stripe_customer_id\)/);
        const cur = rows.get(v[0] as string);
        const id = cur?.stripe_customer_id ?? (v[1] as string);
        rows.set(v[0] as string, { status: cur?.status ?? "incomplete", stripe_customer_id: id });
        return { rows: [{ stripe_customer_id: id }] };
      }
      return { rows: [] };
    });
    return { db: { query }, rows };
  }
  /** Fake Stripe: honours Idempotency-Key on POST /customers like Stripe does. */
  function fakeStripe() {
    const byKey = new Map<string, string>();
    let n = 0;
    const customerCalls: RequestInit[] = [];
    const sessionBodies: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v1/customers")) {
        customerCalls.push(init!);
        const key = (init?.headers as Record<string, string>)["idempotency-key"];
        if (!byKey.has(key)) byKey.set(key, `cus_${++n}`);
        return okJson({ id: byKey.get(key) });
      }
      sessionBodies.push(decodeURIComponent(String(init?.body)));
      return okJson({ url: `https://checkout.stripe.com/${sessionBodies.length}` });
    });
    return { fetchImpl, customerCalls, sessionBodies };
  }

  test("first checkout creates the customer, stores it as a non-granting row, and checks out with it", async () => {
    const { db, rows } = custDb();
    const s = fakeStripe();
    await createProCheckoutSession({ userId: "u1", email: "A@b.c", origin: "o", db }, s.fetchImpl);
    expect(s.customerCalls).toHaveLength(1);
    const headers = s.customerCalls[0].headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBe("di-pro-customer:u1");
    expect(headers["idempotency-key"]).not.toContain("@");
    expect(decodeURIComponent(String(s.customerCalls[0].body))).toContain("metadata[user_id]=u1");
    expect(rows.get("u1")).toEqual({ status: "incomplete", stripe_customer_id: "cus_1" });
    expect(s.sessionBodies[0]).toContain("customer=cus_1");
    expect(s.sessionBodies[0]).not.toContain("customer_email");
  });

  test("two concurrent checkout tabs share ONE customer", async () => {
    const { db } = custDb();
    const s = fakeStripe();
    await Promise.all([
      createProCheckoutSession({ userId: "u1", email: "a@b.c", origin: "o", db }, s.fetchImpl),
      createProCheckoutSession({ userId: "u1", email: "a@b.c", origin: "o", db }, s.fetchImpl),
    ]);
    expect(s.sessionBodies).toHaveLength(2);
    for (const b of s.sessionBodies) expect(b).toContain("customer=cus_1");
  });

  test("if another tab stored a customer first, the stored one wins", async () => {
    const { db, rows } = custDb();
    const s = fakeStripe();
    // Simulate a racing tab committing cus_other between our read and write.
    const realQuery = db.query.getMockImplementation()!;
    db.query.mockImplementation(async (q: string, v: unknown[]) => {
      if (q.includes("'incomplete'") && !rows.has("u1")) rows.set("u1", { status: "incomplete", stripe_customer_id: "cus_other" });
      return realQuery(q, v);
    });
    await createProCheckoutSession({ userId: "u1", email: "a@b.c", origin: "o", db }, s.fetchImpl);
    expect(s.sessionBodies[0]).toContain("customer=cus_other");
  });

  test("an existing customer is reused without calling Stripe /customers", async () => {
    const { db, rows } = custDb();
    rows.set("u1", { status: "canceled", stripe_customer_id: "cus_old" });
    const s = fakeStripe();
    await createProCheckoutSession({ userId: "u1", email: "a@b.c", origin: "o", db }, s.fetchImpl);
    expect(s.customerCalls).toHaveLength(0);
    expect(s.sessionBodies[0]).toContain("customer=cus_old");
  });

  test("the pre-created 'incomplete' row does not grant Pro", async () => {
    const { hasPro } = await import("~/lib/auth/entitlements");
    const db = { query: vi.fn(async (_q: string, _v: unknown[]) => ({ rows: [] as unknown[] })) };
    await hasPro("u1", db);
    expect(db.query.mock.calls[0][0]).toMatch(/status in \('active', 'trialing', 'past_due'\)/);
    expect(db.query.mock.calls[0][0]).not.toMatch(/incomplete/);
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
    const db = { query: vi.fn(async () => ({ rows: [{ user_id: "u1" }] })) };
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
    const db = { query: vi.fn(async (_q: string) => ({ rows: [{ user_id: "u9" }] })) };
    expect(await syncSubscription(sub({ metadata: {} }), db)).toBe("synced");
    expect((db.query.mock.calls[1] as unknown as [string, unknown[]])[1][0]).toBe("u9");
  });
  test("no-user when unknown", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    expect(await syncSubscription(sub({ metadata: {} }), db)).toBe("no-user");
  });
});

describe("syncSubscription double-subscription guard", () => {
  const sub = (over = {}) => ({
    id: "sub_old", status: "canceled", customer: "cus_1", current_period_end: 1900000000,
    metadata: { user_id: "u1" }, items: { data: [{ price: { id: "price_pro" } }] }, ...over,
  });
  test("upsert only overwrites a different stored subscription when it would grant access or the stored one has lapsed", async () => {
    const db = { query: vi.fn(async (_q: string, _v: unknown[]) => ({ rows: [{ user_id: "u1" }] })) };
    await syncSubscription(sub(), db);
    const q = db.query.mock.calls[0][0];
    expect(q).toMatch(/where entitlements\.stripe_subscription_id is null/);
    expect(q).toMatch(/or entitlements\.stripe_subscription_id = excluded\.stripe_subscription_id/);
    expect(q).toMatch(/or excluded\.status in \('active', 'trialing', 'past_due'\)/);
    expect(q).toMatch(/returning user_id/);
  });
  test("returns superseded when the guard skips the write", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    expect(await syncSubscription(sub(), db)).toBe("superseded");
  });
});

describe("findOtherActiveProSubscription", () => {
  test("finds another active Pro subscription for the customer, excluding the given one", async () => {
    const { findOtherActiveProSubscription } = await import("../pro");
    const s = (id: string, status: string, price = "price_pro") => ({ id, status, customer: "cus_1", items: { data: [{ price: { id: price } }] } });
    const fetchImpl = vi.fn(async (_u: string) => okJson({ data: [s("sub_a", "canceled"), s("sub_x", "active", "price_other"), s("sub_b", "past_due")] }));
    const other = await findOtherActiveProSubscription("cus_1", "sub_a", fetchImpl);
    expect(other?.id).toBe("sub_b");
    expect(decodeURIComponent(fetchImpl.mock.calls[0][0])).toContain("/v1/subscriptions?customer=cus_1&status=all");
    expect(await findOtherActiveProSubscription("cus_1", "sub_b", fetchImpl)).toBeNull();
  });
});
