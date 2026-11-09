/**
 * Issue #23 residual: checkout.session.async_payment_failed.
 * A delayed payment that fails must never grant credits or create a gift
 * link; the pending order is marked failed, idempotently, and Stripe gets 2xx.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const m = vi.hoisted(() => ({
  orders: new Map<
    string,
    { status: string; credits: number; session: string | null }
  >(),
  events: new Set<string>(),
}));

vi.mock("~/db", () => ({
  sql:
    () =>
    async (strings: TemplateStringsArray, ...v: unknown[]) => {
      const q = strings.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
      if (/^(create|alter|drop)\b/.test(q))
        throw new Error(`runtime DDL: ${q}`);
      if (q.startsWith("insert into stripe_events")) {
        const id = String(v[0]);
        if (m.events.has(id)) return [];
        m.events.add(id);
        return [{ id }];
      }
      if (q.startsWith("update orders set status = 'failed'")) {
        const [session, id] = v as [string | null, string];
        const o = m.orders.get(id);
        if (!o || o.status !== "pending") return [];
        o.status = "failed";
        o.session ??= session;
        return [{ id }];
      }
      if (
        q.startsWith(
          "select id, sku, status, credits, amount_cents, amount_currency from orders",
        )
      ) {
        const o = m.orders.get(String(v[0]));
        return o
          ? [
              {
                id: v[0],
                sku: "singleInsight",
                status: o.status,
                credits: o.credits,
                amount_cents: 299,
                amount_currency: "usd",
              },
            ]
          : [];
      }
      throw new Error(`unexpected query: ${q}`);
    },
}));

import { markPaymentFailed } from "~/lib/orders";

const PENDING = "11111111-1111-4111-8111-111111111111";
const PAID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  m.orders.clear();
  m.events.clear();
  m.orders.set(PENDING, { status: "pending", credits: 1, session: null });
  m.orders.set(PAID, { status: "paid", credits: 1, session: "cs_paid" });
});

describe("markPaymentFailed", () => {
  test("moves a pending order to failed without granting anything", async () => {
    expect(
      await markPaymentFailed({
        eventId: "evt_1",
        orderId: PENDING,
        sessionId: "cs_1",
      }),
    ).toBe("failed");
    expect(m.orders.get(PENDING)).toEqual({
      status: "failed",
      credits: 1,
      session: "cs_1",
    });
  });

  test("is idempotent on the event id", async () => {
    await markPaymentFailed({
      eventId: "evt_1",
      orderId: PENDING,
      sessionId: "cs_1",
    });
    expect(
      await markPaymentFailed({
        eventId: "evt_1",
        orderId: PENDING,
        sessionId: "cs_1",
      }),
    ).toBe("duplicate");
    // a different event id for the same order is also a no-op
    expect(
      await markPaymentFailed({
        eventId: "evt_2",
        orderId: PENDING,
        sessionId: "cs_1",
      }),
    ).toBe("not-pending");
    expect(m.orders.get(PENDING)?.status).toBe("failed");
  });

  test("never touches a paid order", async () => {
    expect(
      await markPaymentFailed({
        eventId: "evt_3",
        orderId: PAID,
        sessionId: "cs_x",
      }),
    ).toBe("not-pending");
    expect(m.orders.get(PAID)).toEqual({
      status: "paid",
      credits: 1,
      session: "cs_paid",
    });
  });

  test("unknown or malformed order ids", async () => {
    expect(
      await markPaymentFailed({
        eventId: "evt_4",
        orderId: "33333333-3333-4333-8333-333333333333",
        sessionId: null,
      }),
    ).toBe("unknown-order");
    expect(
      await markPaymentFailed({
        eventId: "evt_5",
        orderId: "nope",
        sessionId: null,
      }),
    ).toBe("unknown-order");
  });
});
