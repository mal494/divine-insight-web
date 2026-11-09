/**
 * End-to-end (in-memory DB) tests for the buyer flow:
 * POST /api/checkout → GET /api/order/:id → POST /api/reading,
 * covering per-env payment links, SKU validation and order access tokens.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

type Row = {
  id: string;
  sku: string;
  status: string;
  credits: number;
  amount_cents: number;
  amount_currency: string;
  access_token_hash: string | null;
};

const db = vi.hoisted(() => ({
  orders: new Map<string, Row>(),
  readings: [] as {
    id: string;
    order_id: string;
    payload: unknown;
    created_at: string;
  }[],
  /** Simulate migrations/0004 not applied: orders.access_token_hash missing. */
  noAccessColumn: false,
}));

vi.mock("~/db", () => ({
  sql:
    () =>
    async (strings: TemplateStringsArray, ...v: unknown[]) => {
      const q = strings.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
      if (q.startsWith("alter") && q.includes("access_token_hash")) {
        throw new Error("runtime DDL for access_token_hash must not happen");
      }
      if (q.startsWith("create") || q.startsWith("alter")) return [];
      if (db.noAccessColumn && q.includes("access_token_hash")) {
        throw Object.assign(
          new Error('column "access_token_hash" does not exist'),
          {
            code: "42703",
          },
        );
      }
      if (q.startsWith("insert into orders")) {
        const [id, sku, credits, amount, currency, , , , hash] = v;
        if (credits === undefined || credits === null)
          throw new Error("credits not null violation");
        db.orders.set(String(id), {
          id: String(id),
          sku: String(sku),
          status: "pending",
          credits: Number(credits),
          amount_cents: Number(amount),
          amount_currency: String(currency),
          access_token_hash: (hash as string | null) ?? null,
        });
        return [];
      }
      if (q.startsWith("select access_token_hash from orders where id =")) {
        const row = db.orders.get(String(v[0]));
        return row ? [{ access_token_hash: row.access_token_hash }] : [];
      }
      if (
        q.startsWith(
          "select id, sku, status, credits, amount_cents, amount_currency from orders",
        )
      ) {
        const row = db.orders.get(String(v[0]));
        return row ? [row] : [];
      }
      if (q.startsWith("with spent as ( update orders")) {
        const [orderId, readingId, , payload] = v;
        const row = db.orders.get(String(orderId));
        if (!row || row.status !== "paid" || row.credits <= 0) {
          return [{ reading_id: null, credits_left: null }];
        }
        row.credits -= 1;
        db.readings.push({
          id: String(readingId),
          order_id: row.id,
          payload: JSON.parse(String(payload)),
          created_at: "2026-11-09T00:00:00Z",
        });
        return [{ reading_id: readingId, credits_left: row.credits }];
      }
      if (q.startsWith("select id, payload, created_at from readings")) {
        return db.readings.filter((r) => r.order_id === String(v[0]));
      }
      throw new Error(`unexpected query: ${q}`);
    },
}));

import { PAYMENT_LINK_ENV } from "~/lib/payment-links";
import { handleCheckout } from "~/routes/api/checkout";
import { handleOrderGet } from "~/routes/api/order.$orderId";
import { handleReadingPost } from "~/routes/api/reading";

const PREVIEW_ENV = {
  VERCEL_ENV: "preview",
  [PAYMENT_LINK_ENV.singleInsight]: "https://buy.stripe.com/test_single",
  [PAYMENT_LINK_ENV.extendedReading]: "https://buy.stripe.com/test_extended",
  [PAYMENT_LINK_ENV.readingBundle]: "https://buy.stripe.com/test_bundle",
  [PAYMENT_LINK_ENV.giftReading]: "https://buy.stripe.com/test_gift",
};

function checkoutRequest(body: unknown): Request {
  return new Request("https://di.example/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function orderRequest(
  id: string,
  token?: string | null,
  include = false,
): Request {
  return new Request(
    `https://di.example/api/order/${id}${include ? "?include=readings" : ""}`,
    {
      headers: token ? { "x-order-token": token } : {},
    },
  );
}

function readingRequest(orderId: string, token?: string | null): Request {
  return new Request("https://di.example/api/reading", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-order-token": token } : {}),
    },
    body: JSON.stringify({
      orderId,
      reading: { cards: ["the-star"], question: "q" },
    }),
  });
}

async function buy(
  sku: string,
  env: Record<string, string | undefined> = PREVIEW_ENV,
) {
  const res = await handleCheckout(checkoutRequest({ sku }), env);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    orderId: string;
    accessToken: string;
    url: string;
  };
}

function markPaidInDb(id: string) {
  const row = db.orders.get(id)!;
  row.status = "paid";
}

beforeEach(() => {
  db.noAccessColumn = false;
  delete process.env.LEGACY_ORDER_ACCESS_UNTIL;
  db.orders.clear();
  db.readings.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/checkout — per-environment Stripe links", () => {
  test("preview uses the TEST-mode link from env and never sends the token to Stripe", async () => {
    const { orderId, accessToken, url } = await buy("extendedReading");
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://buy.stripe.com/test_extended",
    );
    expect(parsed.searchParams.get("client_reference_id")).toBe(orderId);
    expect(url).not.toContain(accessToken);
    expect(db.orders.get(orderId)?.access_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(db.orders.get(orderId)?.access_token_hash).not.toBe(accessToken);
  });

  test("preview without links answers 503 and writes no order", async () => {
    const res = await handleCheckout(
      checkoutRequest({ sku: "singleInsight" }),
      {
        VERCEL_ENV: "preview",
      },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "checkout_unavailable" });
    expect(db.orders.size).toBe(0);
  });

  test("preview with a live link configured answers 503", async () => {
    const res = await handleCheckout(
      checkoutRequest({ sku: "singleInsight" }),
      {
        ...PREVIEW_ENV,
        [PAYMENT_LINK_ENV.singleInsight]:
          "https://buy.stripe.com/aFa5kD8yD0Oyfwr9ctes002",
      },
    );
    expect(res.status).toBe(503);
    expect(db.orders.size).toBe(0);
  });

  test("production with no env keeps the current live link", async () => {
    const { url } = await buy("singleInsight", { VERCEL_ENV: "production" });
    expect(
      url.startsWith("https://buy.stripe.com/aFa5kD8yD0Oyfwr9ctes002?"),
    ).toBe(true);
  });
});

describe("POST /api/checkout — SKU validation", () => {
  test.each([
    "toString",
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "proMonthly",
    7,
    null,
  ])("sku %j is a 400 unknown_sku, not a 503", async (sku) => {
    const res = await handleCheckout(checkoutRequest({ sku }), PREVIEW_ENV);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown_sku" });
    expect(db.orders.size).toBe(0);
  });
});

describe("order access control", () => {
  test("the buyer (token holder) can poll, draw and re-read", async () => {
    const { orderId, accessToken } = await buy("readingBundle");
    let res = await handleOrderGet(orderId, orderRequest(orderId, accessToken));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "pending",
      kind: "extended",
      credits: 3,
    });

    markPaidInDb(orderId);
    res = await handleReadingPost(readingRequest(orderId, accessToken));
    expect(res.status).toBe(200);
    expect((await res.json()).creditsLeft).toBe(2);

    res = await handleOrderGet(
      orderId,
      orderRequest(orderId, accessToken, true),
    );
    const body = (await res.json()) as { readings: unknown[] };
    expect(body.readings).toHaveLength(1);
  });

  test("someone with only the order id cannot read status or readings", async () => {
    const { orderId, accessToken } = await buy("singleInsight");
    markPaidInDb(orderId);
    await handleReadingPost(readingRequest(orderId, accessToken));

    for (const token of [null, "", "x".repeat(43), "not-a-token"]) {
      const res = await handleOrderGet(
        orderId,
        orderRequest(orderId, token, true),
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });

  test("someone with only the order id cannot spend its credits", async () => {
    const { orderId } = await buy("readingBundle");
    markPaidInDb(orderId);
    const other = await buy("singleInsight"); // a valid token for a different order

    for (const token of [null, other.accessToken]) {
      const res = await handleReadingPost(readingRequest(orderId, token));
      expect(res.status).toBe(402);
      expect(await res.json()).toEqual({ error: "not_entitled" });
    }
    expect(db.orders.get(orderId)?.credits).toBe(3);
    expect(db.readings).toHaveLength(0);
  });

  test("a wrong token looks exactly like an unknown order (no existence oracle)", async () => {
    const { orderId } = await buy("singleInsight");
    const wrong = await handleOrderGet(orderId, orderRequest(orderId, null));
    const unknownId = "44444444-4444-4444-8444-444444444444";
    const unknown = await handleOrderGet(
      unknownId,
      orderRequest(unknownId, null),
    );
    expect([wrong.status, await wrong.json()]).toEqual([
      unknown.status,
      await unknown.json(),
    ]);
  });

  test("orders created before access tokens keep working by id (grandfathered)", async () => {
    const legacyId = "55555555-5555-4555-8555-555555555555";
    db.orders.set(legacyId, {
      id: legacyId,
      sku: "singleInsight",
      status: "paid",
      credits: 1,
      amount_cents: 299,
      amount_currency: "usd",
      access_token_hash: null,
    });
    const status = await handleOrderGet(legacyId, orderRequest(legacyId, null));
    expect(status.status).toBe(200);
    const spend = await handleReadingPost(readingRequest(legacyId, null));
    expect(spend.status).toBe(200);
  });

  test("responses are not cacheable and vary on the token", async () => {
    const { orderId, accessToken } = await buy("singleInsight");
    const res = await handleOrderGet(
      orderId,
      orderRequest(orderId, accessToken),
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("vary")).toBe("x-order-token");
  });
});

describe("migration 0004 not applied", () => {
  test("checkout, order status and reading spend all fail closed with 503", async () => {
    const { orderId, accessToken } = await buy("singleInsight");
    markPaidInDb(orderId);
    db.noAccessColumn = true;

    const checkout = await handleCheckout(
      checkoutRequest({ sku: "singleInsight" }),
      PREVIEW_ENV,
    );
    expect(checkout.status).toBe(503);

    for (const token of [accessToken, null]) {
      const status = await handleOrderGet(
        orderId,
        orderRequest(orderId, token, true),
      );
      expect(status.status).toBe(503);
      const spend = await handleReadingPost(readingRequest(orderId, token));
      expect(spend.status).toBe(503);
    }
    expect(db.orders.get(orderId)?.credits).toBe(1);
  });
});

describe("legacy sunset via LEGACY_ORDER_ACCESS_UNTIL", () => {
  test("after the cutoff, id-only access to a pre-token order is refused", async () => {
    const legacyId = "66666666-6666-4666-8666-666666666666";
    db.orders.set(legacyId, {
      id: legacyId,
      sku: "singleInsight",
      status: "paid",
      credits: 1,
      amount_cents: 299,
      amount_currency: "usd",
      access_token_hash: null,
    });
    process.env.LEGACY_ORDER_ACCESS_UNTIL = "2000-01-01T00:00:00Z";
    expect(
      (await handleOrderGet(legacyId, orderRequest(legacyId, null))).status,
    ).toBe(404);
    expect(
      (await handleReadingPost(readingRequest(legacyId, null))).status,
    ).toBe(402);
    expect(db.orders.get(legacyId)?.credits).toBe(1);
  });
});
