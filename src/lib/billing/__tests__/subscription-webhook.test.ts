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
    if (q.includes("insert into entitlements")) { ent.set(v[0] as string, v); return { rows: [] }; }
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
