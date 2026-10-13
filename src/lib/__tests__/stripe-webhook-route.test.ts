import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyStripeSignature: vi.fn(),
  markPaid: vi.fn(),
  getGiftDetails: vi.fn(),
  createGiftClaim: vi.fn(),
  sendGiftEmail: vi.fn(),
  claimUrlFor: vi.fn(),
}));

vi.mock("~/lib/stripe-signature", () => ({
  verifyStripeSignature: mocks.verifyStripeSignature,
}));

vi.mock("~/lib/orders", () => ({
  markPaid: mocks.markPaid,
}));

vi.mock("~/lib/gifts", () => ({
  getGiftDetails: mocks.getGiftDetails,
  createGiftClaim: mocks.createGiftClaim,
}));

vi.mock("~/lib/gift-email", () => ({
  sendGiftEmail: mocks.sendGiftEmail,
  claimUrlFor: mocks.claimUrlFor,
}));

import { handleStripeWebhook } from "~/routes/api/stripe-webhook";

function requestFor(event: unknown): Request {
  return new Request("https://divine.example/api/stripe-webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": "t=1700000000,v1=signature",
    },
    body: JSON.stringify(event),
  });
}

function checkoutEvent(
  type: "checkout.session.completed" | "checkout.session.async_payment_succeeded",
) {
  return {
    id: `evt_${type.replace(/\./g, "_")}`,
    type,
    data: {
      object: {
        id: "cs_123",
        client_reference_id: "11111111-1111-4111-8111-111111111111",
        payment_intent: "pi_123",
        payment_status: "paid",
        amount_total: 999,
        currency: "usd",
      },
    },
  };
}

describe("handleStripeWebhook", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    mocks.verifyStripeSignature.mockResolvedValue({ ok: true });
    mocks.markPaid.mockResolvedValue("applied");
    mocks.getGiftDetails.mockResolvedValue(null);
    mocks.createGiftClaim.mockResolvedValue("token_123");
    mocks.sendGiftEmail.mockResolvedValue(true);
    mocks.claimUrlFor.mockReturnValue("https://divine.example/claim/token_123");
  });

  test("accepts both checkout.session.completed and checkout.session.async_payment_succeeded", async () => {
    for (const type of [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
    ] as const) {
      const response = await handleStripeWebhook(requestFor(checkoutEvent(type)));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("applied");
    }

    expect(mocks.markPaid).toHaveBeenCalledTimes(2);
    expect(mocks.markPaid).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        amountCents: 999,
        currency: "usd",
      }),
    );
    expect(mocks.markPaid).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        amountCents: 999,
        currency: "usd",
      }),
    );
  });

  test("rejects malformed signatures before fulfilment", async () => {
    mocks.verifyStripeSignature.mockResolvedValue({ ok: false, reason: "mismatch" });
    const response = await handleStripeWebhook(requestFor(checkoutEvent("checkout.session.completed")));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("invalid signature");
    expect(mocks.markPaid).not.toHaveBeenCalled();
  });

  test("fails closed unless payment_status is exactly paid", async () => {
    const event = checkoutEvent("checkout.session.completed");
    delete (event.data.object as Record<string, unknown>).payment_status;

    const response = await handleStripeWebhook(requestFor(event));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("not paid");
    expect(mocks.markPaid).not.toHaveBeenCalled();
  });

  test("fails closed when amount_total is missing or invalid", async () => {
    const missing = checkoutEvent("checkout.session.completed");
    delete (missing.data.object as Record<string, unknown>).amount_total;
    const missingRes = await handleStripeWebhook(requestFor(missing));
    expect(missingRes.status).toBe(200);
    expect(await missingRes.text()).toBe("invalid amount");

    const invalid = checkoutEvent("checkout.session.completed");
    (invalid.data.object as { amount_total: unknown }).amount_total = "999";
    const invalidRes = await handleStripeWebhook(requestFor(invalid));
    expect(invalidRes.status).toBe(200);
    expect(await invalidRes.text()).toBe("invalid amount");

    expect(mocks.markPaid).not.toHaveBeenCalled();
  });

  test("fails closed when currency is missing or invalid", async () => {
    const missing = checkoutEvent("checkout.session.completed");
    delete (missing.data.object as Record<string, unknown>).currency;
    const missingRes = await handleStripeWebhook(requestFor(missing));
    expect(missingRes.status).toBe(200);
    expect(await missingRes.text()).toBe("invalid currency");

    const invalid = checkoutEvent("checkout.session.completed");
    invalid.data.object.currency = "   ";
    const invalidRes = await handleStripeWebhook(requestFor(invalid));
    expect(invalidRes.status).toBe(200);
    expect(await invalidRes.text()).toBe("invalid currency");

    expect(mocks.markPaid).not.toHaveBeenCalled();
  });

  test("treats duplicate deliveries as no-ops", async () => {
    mocks.markPaid.mockResolvedValue("duplicate");
    const response = await handleStripeWebhook(requestFor(checkoutEvent("checkout.session.completed")));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("duplicate");
    expect(mocks.getGiftDetails).not.toHaveBeenCalled();
    expect(mocks.sendGiftEmail).not.toHaveBeenCalled();
  });

  test("allows retries and out-of-order events without rerunning gift side effects", async () => {
    mocks.markPaid
      .mockResolvedValueOnce("amount-mismatch")
      .mockResolvedValueOnce("applied")
      .mockResolvedValueOnce("already-paid")
      .mockResolvedValueOnce("duplicate");
    mocks.getGiftDetails.mockResolvedValue({
      orderId: "11111111-1111-4111-8111-111111111111",
      recipientEmail: "recipient@example.com",
      senderName: "A. Sender",
      note: "For your journey",
    });

    const first = await handleStripeWebhook(requestFor(checkoutEvent("checkout.session.completed")));
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("amount-mismatch");

    const retry = await handleStripeWebhook(
      requestFor(checkoutEvent("checkout.session.async_payment_succeeded")),
    );
    expect(retry.status).toBe(200);
    expect(await retry.text()).toBe("applied");

    const outOfOrder = await handleStripeWebhook(
      requestFor(checkoutEvent("checkout.session.completed")),
    );
    expect(outOfOrder.status).toBe(200);
    expect(await outOfOrder.text()).toBe("already-paid");

    const duplicate = await handleStripeWebhook(
      requestFor(checkoutEvent("checkout.session.completed")),
    );
    expect(duplicate.status).toBe(200);
    expect(await duplicate.text()).toBe("duplicate");

    expect(mocks.getGiftDetails).toHaveBeenCalledTimes(1);
    expect(mocks.createGiftClaim).toHaveBeenCalledTimes(1);
    expect(mocks.sendGiftEmail).toHaveBeenCalledTimes(1);
    expect(mocks.claimUrlFor).toHaveBeenCalledTimes(1);
  });
});
