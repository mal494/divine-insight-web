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

type StoredReading = {
  id: string;
  orderId: string;
  payload: unknown;
};

type FakeState = {
  orders: Map<string, StoredOrder>;
  readings: Map<string, StoredReading>;
  appliedEvents: Set<string>;
  failNextReadingInsert: boolean;
};

let state: FakeState = freshState();

function freshState(): FakeState {
  return {
    orders: new Map(),
    readings: new Map(),
    appliedEvents: new Set(),
    failNextReadingInsert: false,
  };
}

function normalizeSql(strings: TemplateStringsArray): string {
  return strings.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
}

async function query(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  const sql = normalizeSql(strings);

  if (sql.startsWith("create table") || sql.startsWith("create index")) return [];

  if (sql.startsWith("select id from stripe_events where id =")) {
    const eventId = String(values[0]);
    return state.appliedEvents.has(eventId) ? [{ id: eventId }] : [];
  }

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
      return [{ id: orderId }];
    }
    return [];
  }

  if (sql.startsWith("with spent as ( update orders")) {
    const [orderIdRaw, readingIdRaw, readingOrderIdRaw, payloadRaw] = values;
    const orderId = String(orderIdRaw);
    const readingId = String(readingIdRaw);
    const readingOrderId = String(readingOrderIdRaw);
    const order = state.orders.get(orderId);

    if (
      !order ||
      order.status !== "paid" ||
      order.credits <= 0 ||
      order.id !== readingOrderId
    ) {
      return [{ reading_id: null, credits_left: null }];
    }

    if (state.failNextReadingInsert) {
      state.failNextReadingInsert = false;
      throw new Error("simulated reading insert failure");
    }

    order.credits -= 1;
    state.readings.set(readingId, {
      id: readingId,
      orderId: readingOrderId,
      payload: JSON.parse(String(payloadRaw)),
    });
    return [{ reading_id: readingId, credits_left: order.credits }];
  }

  throw new Error(`Unexpected query in test double: ${sql}`);
}

vi.mock("~/db", () => ({
  sql: () => query,
}));
import { markPaid, saveReading, SKUS } from "../orders";

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

  test("does not claim an event id before fulfilment succeeds", async () => {
    const orderId = "12121212-1212-4212-8212-121212121212";
    seedOrder({ id: orderId, sku: "singleInsight" });

    const mismatch = await markPaid({
      eventId: "evt_checkout_completed_retryable",
      orderId,
      paymentIntent: "pi_bad",
      sessionId: "cs_bad",
      amountCents: SKUS.singleInsight.amountCents + 50,
    });
    const retry = await markPaid({
      eventId: "evt_checkout_completed_retryable",
      orderId,
      paymentIntent: "pi_good",
      sessionId: "cs_good",
      amountCents: SKUS.singleInsight.amountCents,
    });

    expect(mismatch).toBe("amount-mismatch");
    expect(retry).toBe("applied");
    expect(state.orders.get(orderId)?.status).toBe("paid");
  });

  test("can still fulfil a pending order even if the event id was claimed earlier", async () => {
    const orderId = "23232323-2323-4232-8232-232323232323";
    const eventId = "evt_stale_claim_from_old_bug";
    seedOrder({ id: orderId, sku: "extendedReading" });
    state.appliedEvents.add(eventId);

    const result = await markPaid({
      eventId,
      orderId,
      paymentIntent: "pi_stale",
      sessionId: "cs_stale",
      amountCents: SKUS.extendedReading.amountCents,
    });

    expect(result).toBe("duplicate");
    expect(state.orders.get(orderId)?.status).toBe("paid");
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

describe("saveReading", () => {
  beforeEach(() => {
    state = freshState();
  });

  test("spends one credit and stores the reading when the order is paid", async () => {
    const orderId = "44444444-4444-4444-8444-444444444444";
    seedOrder({ id: orderId, sku: "readingBundle", status: "paid" });

    const spent = await saveReading(orderId, { summary: "first draw" });

    expect(spent?.creditsLeft).toBe(SKUS.readingBundle.credits - 1);
    expect(state.orders.get(orderId)?.credits).toBe(SKUS.readingBundle.credits - 1);
    expect(state.readings.size).toBe(1);
  });

  test("keeps credits unchanged when reading insert fails", async () => {
    const orderId = "55555555-5555-4555-8555-555555555555";
    seedOrder({ id: orderId, sku: "extendedReading", status: "paid" });
    state.failNextReadingInsert = true;

    await expect(saveReading(orderId, { summary: "should rollback" })).rejects.toThrow(
      "simulated reading insert failure",
    );
    expect(state.orders.get(orderId)?.credits).toBe(SKUS.extendedReading.credits);
    expect(state.readings.size).toBe(0);
  });
});
