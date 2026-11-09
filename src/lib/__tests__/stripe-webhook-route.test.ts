import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyStripeSignature: vi.fn(),
  markPaid: vi.fn(),
  getGiftDetails: vi.fn(),
  createGiftClaim: vi.fn(),
  sendGiftEmail: vi.fn(),
  sendGiftBuyerEmail: vi.fn(),
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

vi.mock("~/lib/orphan-payments", () => ({
  recordOrphanPayment: vi.fn().mockResolvedValue(true),
}));

vi.mock("~/lib/gift-email", () => ({
  sendGiftEmail: mocks.sendGiftEmail,
  sendGiftBuyerEmail: mocks.sendGiftBuyerEmail,
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
    mocks.createGiftClaim.mockResolvedValue({ token: "token_123", created: true });
    mocks.sendGiftEmail.mockResolvedValue(true);
    mocks.sendGiftBuyerEmail.mockResolvedValue(true);
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
    // Non-gift order: nothing to mint, nothing to send.
    expect(mocks.createGiftClaim).not.toHaveBeenCalled();
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
    // Minting is idempotent: only the first successful call creates the row.
    mocks.createGiftClaim
      .mockResolvedValueOnce({ token: "token_123", created: true })
      .mockResolvedValue({ token: "token_123", created: false });

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

    // Every successful outcome re-asserts the claim token (idempotently);
    // the emails go out exactly once, from the call that created it.
    expect(mocks.getGiftDetails).toHaveBeenCalledTimes(3);
    expect(mocks.createGiftClaim).toHaveBeenCalledTimes(3);
    expect(mocks.sendGiftEmail).toHaveBeenCalledTimes(1);
    expect(mocks.claimUrlFor).toHaveBeenCalledTimes(1);
  });

  describe("paid gift delivery", () => {
    const ORDER_ID = "11111111-1111-4111-8111-111111111111";

    function giftEvent(customerEmail: string | null = "buyer@example.com") {
      const event = checkoutEvent("checkout.session.completed");
      (event.data.object as Record<string, unknown>).amount_total = 500;
      (event.data.object as Record<string, unknown>).customer_details = {
        email: customerEmail,
      };
      return event;
    }

    test("a paid gift with NO recipient email still gets a claim token, and the buyer gets the link", async () => {
      mocks.getGiftDetails.mockResolvedValue({
        orderId: ORDER_ID,
        recipientEmail: null,
        senderName: "A. Sender",
        note: null,
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const response = await handleStripeWebhook(requestFor(giftEvent()));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("applied");

      expect(mocks.createGiftClaim).toHaveBeenCalledWith(ORDER_ID);
      expect(mocks.sendGiftEmail).not.toHaveBeenCalled();
      expect(mocks.sendGiftBuyerEmail).toHaveBeenCalledWith({
        to: "buyer@example.com",
        recipientEmail: null,
        claimUrl: "https://divine.example/claim/token_123",
      });

      // Logged for support, without the raw token.
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain("no recipient email");
      expect(logged).toContain(ORDER_ID);
      expect(logged).not.toContain("token_123");
      warn.mockRestore();
    });

    test("a paid gift WITH a recipient email is delivered as before, and the buyer also gets the link", async () => {
      mocks.getGiftDetails.mockResolvedValue({
        orderId: ORDER_ID,
        recipientEmail: "recipient@example.com",
        senderName: "A. Sender",
        note: "For your journey",
      });

      const response = await handleStripeWebhook(requestFor(giftEvent()));
      expect(await response.text()).toBe("applied");
      expect(mocks.sendGiftEmail).toHaveBeenCalledWith({
        to: "recipient@example.com",
        senderName: "A. Sender",
        note: "For your journey",
        claimUrl: "https://divine.example/claim/token_123",
      });
      expect(mocks.sendGiftBuyerEmail).toHaveBeenCalledWith({
        to: "buyer@example.com",
        recipientEmail: "recipient@example.com",
        claimUrl: "https://divine.example/claim/token_123",
      });
    });

    test("email failure (e.g. Resend unset) never fails the webhook or the claim", async () => {
      mocks.getGiftDetails.mockResolvedValue({
        orderId: ORDER_ID,
        recipientEmail: null,
        senderName: null,
        note: null,
      });
      mocks.sendGiftBuyerEmail.mockResolvedValue(false);
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const response = await handleStripeWebhook(requestFor(giftEvent(null)));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("applied");
      expect(mocks.createGiftClaim).toHaveBeenCalledTimes(1);
      expect(mocks.sendGiftBuyerEmail).not.toHaveBeenCalled();
    });

    test("a mint failure answers 500 so Stripe retries, and the retry mints the token", async () => {
      mocks.getGiftDetails.mockResolvedValue({
        orderId: ORDER_ID,
        recipientEmail: null,
        senderName: null,
        note: null,
      });
      mocks.markPaid.mockResolvedValueOnce("applied").mockResolvedValueOnce("duplicate");
      mocks.createGiftClaim
        .mockRejectedValueOnce(new Error("db down"))
        .mockResolvedValueOnce({ token: "token_123", created: true });
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const first = await handleStripeWebhook(requestFor(giftEvent()));
      expect(first.status).toBe(500);

      const retry = await handleStripeWebhook(requestFor(giftEvent()));
      expect(retry.status).toBe(200);
      expect(await retry.text()).toBe("duplicate");
      expect(mocks.sendGiftBuyerEmail).toHaveBeenCalledTimes(1);
    });
  });
});
