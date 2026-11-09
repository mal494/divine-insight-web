import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("~/lib/stripe-signature", () => ({ verifyStripeSignature: mocks.verify }));

import { handleSubscriptionWebhook } from "../subscription-webhook";

const req = (event: unknown) =>
  new Request("https://s/api/stripe-subscription-webhook", {
    method: "POST", headers: { "stripe-signature": "t=1,v1=x" }, body: JSON.stringify(event),
  });

function fakeDb() {
  const events = new Set<string>();
  const ent = new Map<string, unknown[]>();
  const query = vi.fn(async (q: string, v: unknown[]) => {
    if (q.includes("insert into stripe_subscription_events")) {
      if (events.has(v[0] as string)) return { rows: [] };
      events.add(v[0] as string); return { rows: [{ event_id: v[0] }] };
    }
    if (q.includes("delete from stripe_subscription_events")) { events.delete(v[0] as string); return { rows: [] }; }
    if (q.includes("insert into entitlements")) { ent.set(v[0] as string, v); return { rows: [{ user_id: v[0] }] }; }
    return { rows: [] };
  });
  return { db: { query }, events, ent };
}

const stripeSub = (status: string) => ({
  id: "sub_1", status, customer: "cus_1", current_period_end: 1900000000,
  metadata: { user_id: "u1" }, items: { data: [{ price: { id: "price_pro" } }] },
});

beforeEach(() => {
  vi.resetAllMocks();
  process.env.STRIPE_PRO_WEBHOOK_SECRET = "whsec_pro";
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.STRIPE_PRO_PRICE_ID = "price_pro";
  mocks.verify.mockResolvedValue({ ok: true });
});

describe("handleSubscriptionWebhook", () => {
  test("rejects bad signature", async () => {
    mocks.verify.mockResolvedValue({ ok: false, reason: "mismatch" });
    const { db } = fakeDb();
    const r = await handleSubscriptionWebhook(req({ id: "e", type: "invoice.paid" }), { db: () => db });
    expect(r.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  test("500 when secret missing", async () => {
    delete process.env.STRIPE_PRO_WEBHOOK_SECRET;
    const { db } = fakeDb();
    expect((await handleSubscriptionWebhook(req({}), { db: () => db })).status).toBe(500);
  });

  test("checkout.session.completed grants pro from refetched subscription", async () => {
    const { db, ent } = fakeDb();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(stripeSub("active"))));
    const ev = { id: "evt_1", type: "checkout.session.completed", data: { object: { mode: "subscription", subscription: "sub_1", client_reference_id: "u1" } } };
    const r = await handleSubscriptionWebhook(req(ev), { db: () => db, fetchImpl });
    expect(await r.text()).toBe("synced");
    expect(ent.get("u1")?.[1]).toBe("active");
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe("https://api.stripe.com/v1/subscriptions/sub_1");
  });

  test("payment-mode checkout (one-time orders) is ignored", async () => {
    const { db } = fakeDb();
    const ev = { id: "evt_p", type: "checkout.session.completed", data: { object: { mode: "payment" } } };
    expect(await (await handleSubscriptionWebhook(req(ev), { db: () => db })).text()).toBe("ignored");
  });

  test("duplicate event is processed once", async () => {
    const { db } = fakeDb();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(stripeSub("active"))));
    const ev = { id: "evt_2", type: "customer.subscription.updated", data: { object: { id: "sub_1" } } };
    await handleSubscriptionWebhook(req(ev), { db: () => db, fetchImpl });
    const r = await handleSubscriptionWebhook(req(ev), { db: () => db, fetchImpl });
    expect(await r.text()).toBe("duplicate");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("deleted revokes (status canceled from Stripe)", async () => {
    const { db, ent } = fakeDb();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(stripeSub("canceled"))));
    const ev = { id: "evt_3", type: "customer.subscription.deleted", data: { object: { id: "sub_1" } } };
    await handleSubscriptionWebhook(req(ev), { db: () => db, fetchImpl });
    expect(ent.get("u1")?.[1]).toBe("canceled");
  });

  test("deleted falls back to payload when fetch fails", async () => {
    const { db, ent } = fakeDb();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 404 }));
    const ev = { id: "evt_4", type: "customer.subscription.deleted", data: { object: stripeSub("active") } };
    await handleSubscriptionWebhook(req(ev), { db: () => db, fetchImpl });
    expect(ent.get("u1")?.[1]).toBe("canceled");
  });

  test("failure releases claim and returns 500 for retry", async () => {
    const { db, events } = fakeDb();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));
    const ev = { id: "evt_5", type: "customer.subscription.updated", data: { object: { id: "sub_1" } } };
    const r = await handleSubscriptionWebhook(req(ev), { db: () => db, fetchImpl });
    expect(r.status).toBe(500);
    expect(events.has("evt_5")).toBe(false);
  });

  test("invoice.payment_failed resyncs to past_due", async () => {
    const { db, ent } = fakeDb();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(stripeSub("past_due"))));
    const ev = { id: "evt_6", type: "invoice.payment_failed", data: { object: { parent: { subscription_details: { subscription: "sub_1" } } } } };
    await handleSubscriptionWebhook(req(ev), { db: () => db, fetchImpl });
    expect(ent.get("u1")?.[1]).toBe("past_due");
  });

  test("unrelated events ignored", async () => {
    const { db } = fakeDb();
    expect(await (await handleSubscriptionWebhook(req({ id: "e", type: "charge.refunded" }), { db: () => db })).text()).toBe("ignored");
  });
});

describe("double subscriptions (guarded webhook)", () => {
  type Row = { status: string; periodEnd: string | null; subId: string | null };
  const ACTIVE = ["active", "trialing", "past_due"];
  /** Fake that mirrors the upsert's WHERE guard in syncSubscription. */
  function guardedDb(initial?: Row) {
    const events = new Set<string>();
    let row: Row | undefined = initial;
    const query = vi.fn(async (q: string, v: unknown[]) => {
      if (q.includes("insert into stripe_subscription_events")) {
        if (events.has(v[0] as string)) return { rows: [] };
        events.add(v[0] as string); return { rows: [{ event_id: v[0] }] };
      }
      if (q.includes("insert into entitlements")) {
        expect(q).toMatch(/where entitlements\.stripe_subscription_id is null/);
        const next: Row = { status: v[1] as string, periodEnd: v[2] as string | null, subId: v[4] as string };
        const storedGrants = row && ACTIVE.includes(row.status) && (!row.periodEnd || new Date(row.periodEnd) > new Date());
        const apply = !row || !row.subId || row.subId === next.subId || ACTIVE.includes(next.status) || !storedGrants;
        if (!apply) return { rows: [] };
        row = next; return { rows: [{ user_id: v[0] }] };
      }
      return { rows: [] };
    });
    return { db: { query }, get row() { return row; } };
  }
  const sub = (id: string, status: string) => ({ ...stripeSub(status), id });
  const future = new Date(1900000000 * 1000).toISOString();

  test("cancelling the OLD subscription keeps Pro while the NEW one is active (Stripe lists it)", async () => {
    const g = guardedDb({ status: "active", periodEnd: future, subId: "sub_new" });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/subscriptions/sub_old")) return new Response(JSON.stringify(sub("sub_old", "canceled")));
      if (url.includes("/subscriptions?")) {
        expect(url).toContain("customer=cus_1");
        return new Response(JSON.stringify({ data: [sub("sub_old", "canceled"), sub("sub_new", "active")] }));
      }
      return new Response("{}", { status: 404 });
    });
    const ev = { id: "evt_old_del", type: "customer.subscription.deleted", data: { object: { id: "sub_old" } } };
    const r = await handleSubscriptionWebhook(req(ev), { db: () => g.db, fetchImpl });
    expect(await r.text()).toBe("synced");
    expect(g.row).toMatchObject({ status: "active", subId: "sub_new" });
  });

  test("an ended non-stored subscription can't overwrite an active stored one (DB guard)", async () => {
    const g = guardedDb({ status: "active", periodEnd: future, subId: "sub_new" });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/subscriptions/sub_old")) return new Response(JSON.stringify(sub("sub_old", "canceled")));
      return new Response(JSON.stringify({ data: [] }));
    });
    const ev = { id: "evt_old_upd", type: "customer.subscription.updated", data: { object: { id: "sub_old" } } };
    const r = await handleSubscriptionWebhook(req(ev), { db: () => g.db, fetchImpl });
    expect(await r.text()).toBe("superseded");
    expect(g.row).toMatchObject({ status: "active", subId: "sub_new" });
  });

  test("cancelling the stored subscription with no other active one revokes", async () => {
    const g = guardedDb({ status: "active", periodEnd: future, subId: "sub_1" });
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("/subscriptions?")
        ? new Response(JSON.stringify({ data: [sub("sub_1", "canceled")] }))
        : new Response(JSON.stringify(sub("sub_1", "canceled"))),
    );
    const ev = { id: "evt_del", type: "customer.subscription.deleted", data: { object: { id: "sub_1" } } };
    expect(await (await handleSubscriptionWebhook(req(ev), { db: () => g.db, fetchImpl })).text()).toBe("synced");
    expect(g.row).toMatchObject({ status: "canceled", subId: "sub_1" });
  });

  test("a revoke still lands if listing subscriptions fails", async () => {
    const g = guardedDb({ status: "active", periodEnd: future, subId: "sub_1" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("/subscriptions?")
        ? new Response("{}", { status: 500 })
        : new Response(JSON.stringify(sub("sub_1", "canceled"))),
    );
    const ev = { id: "evt_del2", type: "customer.subscription.deleted", data: { object: { id: "sub_1" } } };
    expect(await (await handleSubscriptionWebhook(req(ev), { db: () => g.db, fetchImpl })).text()).toBe("synced");
    spy.mockRestore();
    expect(g.row?.status).toBe("canceled");
  });

  test("a newly active subscription replaces an ended stored one", async () => {
    const g = guardedDb({ status: "canceled", periodEnd: future, subId: "sub_old" });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(sub("sub_new", "active"))));
    const ev = { id: "evt_new", type: "customer.subscription.created", data: { object: { id: "sub_new" } } };
    expect(await (await handleSubscriptionWebhook(req(ev), { db: () => g.db, fetchImpl })).text()).toBe("synced");
    expect(g.row).toMatchObject({ status: "active", subId: "sub_new" });
  });
});
