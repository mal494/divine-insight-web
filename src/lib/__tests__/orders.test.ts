import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Sku } from "../orders";

type StoredOrder = {
  id: string;
  sku: Sku;
  status: "pending" | "paid" | "void";
  credits: number;
  amountCents: number;
  paymentIntent: string | null;
  sessionId: string | null;
};

type FakeState = {
  orders: Map<string, StoredOrder>;
  appliedEvents: Set<string>;
};

let state: FakeState = freshState();

function freshState(): FakeState {
  return { orders: new Map(), appliedEvents: new Set() };
}

function normalizeSql(strings: TemplateStringsArray): string {
  return strings.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
}

async function query(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  const sql = normalizeSql(strings);

  if (sql.startsWith("create table") || sql.startsWith("create index")) return [];

  if (sql.startsWith("insert into stripe_events")) {
    const eventId = String(values[0]);
    if (state.appliedEvents.has(eventId)) return [];
    state.appliedEvents.add(eventId);
    return [{ id: eventId }];
  }

  if (sql.startsWith("select id, sku, status, credits from orders where id =")) {
    const id = String(values[0]);
    const order = state.orders.get(id);
    if (!order) return [];
    return [
      {
        id: order.id,
        sku: order.sku,
        status: order.status,
        credits: order.credits,
      },
    ];
  }

  if (sql.startsWith("update orders set status = 'paid'")) {
    const [paymentIntent, sessionId, orderId] = values as [
      string | null,
      string | null,
      string,
    ];
    const order = state.orders.get(orderId);
    if (order && order.status === "pending") {
      order.status = "paid";
      order.paymentIntent = paymentIntent;
      order.sessionId = sessionId;
    }
    return [];
  }

  throw new Error(`Unexpected query in test double: ${sql}`);
}

vi.mock("~/db", () => ({
  sql: () => query,
}));
import { markPaid, SKUS } from "../orders";

function seedOrder(args: {
  id: string;
  sku: Sku;
  status?: "pending" | "paid" | "void";
}): void {
  const spec = SKUS[args.sku];
  state.orders.set(args.id, {
    id: args.id,
    sku: args.sku,
    status: args.status ?? "pending",
    credits: spec.credits,
    amountCents: spec.amountCents,
    paymentIntent: null,
    sessionId: null,
  });
}

describe("markPaid", () => {
  beforeEach(() => {
    state = freshState();
  });

  test("is idempotent for duplicate webhook deliveries", async () => {
    const orderId = "11111111-1111-4111-8111-111111111111";
    seedOrder({ id: orderId, sku: "extendedReading" });

    const first = await markPaid({
      eventId: "evt_checkout_completed_1",
      orderId,
      paymentIntent: "pi_1",
      sessionId: "cs_1",
      amountCents: SKUS.extendedReading.amountCents,
    });
    const second = await markPaid({
      eventId: "evt_checkout_completed_1",
      orderId,
      paymentIntent: "pi_2",
      sessionId: "cs_2",
      amountCents: SKUS.extendedReading.amountCents,
    });

    expect(first).toBe("applied");
    expect(second).toBe("duplicate");
    const updated = state.orders.get(orderId);
    expect(updated?.status).toBe("paid");
    expect(updated?.paymentIntent).toBe("pi_1");
    expect(updated?.sessionId).toBe("cs_1");
  });

  test("rejects fulfilment when charged amount disagrees with server-side SKU price", async () => {
    const orderId = "22222222-2222-4222-8222-222222222222";
    seedOrder({ id: orderId, sku: "singleInsight" });

    const result = await markPaid({
      eventId: "evt_checkout_completed_2",
      orderId,
      paymentIntent: "pi_2",
      sessionId: "cs_2",
      amountCents: SKUS.singleInsight.amountCents + 1,
    });

    expect(result).toBe("amount-mismatch");
    expect(state.orders.get(orderId)?.status).toBe("pending");
  });

  test("returns unknown-order when webhook references an order id we never issued", async () => {
    const result = await markPaid({
      eventId: "evt_checkout_completed_3",
      orderId: "33333333-3333-4333-8333-333333333333",
      paymentIntent: "pi_3",
      sessionId: "cs_3",
      amountCents: 999,
    });

    expect(result).toBe("unknown-order");
  });
});
