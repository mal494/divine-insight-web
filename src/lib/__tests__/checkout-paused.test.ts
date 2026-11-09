/** /api/checkout refuses paid SKUs with 503 checkout_paused unless PAID_CHECKOUT_ENABLED=true. */
import { beforeEach, describe, expect, test, vi } from "vitest";

const createOrder = vi.hoisted(() => vi.fn(async () => "11111111-1111-4111-8111-111111111111"));
vi.mock("~/lib/orders", async () => {
  const actual = await vi.importActual<typeof import("~/lib/orders")>("~/lib/orders");
  return { ...actual, createOrder };
});

import { handleCheckout } from "~/routes/api/checkout";
import { serverPaidCheckoutEnabled } from "~/lib/paid-checkout";

const req = (body: unknown) =>
  new Request("https://divine.example/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => createOrder.mockClear());

describe("/api/checkout pause", () => {
  test.each(["singleInsight", "extendedReading", "readingBundle", "giftReading"])(
    "%s → 503 checkout_paused and no order row when the flag is unset",
    async (sku) => {
      const res = await handleCheckout(req({ sku, recipientEmail: "a@b.co" }), {});
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "checkout_paused" });
      expect(createOrder).not.toHaveBeenCalled();
    },
  );

  test("any value other than exactly 'true' stays paused", async () => {
    for (const v of ["1", "TRUE", "yes", "false", ""]) {
      const res = await handleCheckout(req({ sku: "extendedReading" }), { PAID_CHECKOUT_ENABLED: v });
      expect(res.status).toBe(503);
    }
    expect(createOrder).not.toHaveBeenCalled();
  });

  test("PAID_CHECKOUT_ENABLED=true restores checkout", async () => {
    const res = await handleCheckout(req({ sku: "extendedReading" }), { PAID_CHECKOUT_ENABLED: "true" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orderId: string; url: string };
    expect(body.url).toMatch(/^https:\/\/buy\.stripe\.com\/.+client_reference_id=11111111-/);
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  test("bad input is still rejected first (400), paused or not", async () => {
    expect((await handleCheckout(req({ sku: "tip5" }), {})).status).toBe(400);
    expect((await handleCheckout(req({ sku: "nope" }), {})).status).toBe(400);
  });

  test("defaults to process.env", () => {
    vi.stubEnv("PAID_CHECKOUT_ENABLED", "");
    expect(serverPaidCheckoutEnabled()).toBe(false);
    vi.stubEnv("PAID_CHECKOUT_ENABLED", "true");
    expect(serverPaidCheckoutEnabled()).toBe(true);
    vi.unstubAllEnvs();
  });
});
