import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyStripeSignature: vi.fn(),
  markPaid: vi.fn(),
  getGiftDetails: vi.fn(),
  createGiftClaim: vi.fn(),
  reserveGiftEmail: vi.fn(),
  releaseGiftEmail: vi.fn(),
  markGiftEmailSent: vi.fn(),
  giftEmailConfigured: vi.fn(),
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

vi.mock("~/lib/gifts", () => {
  class GiftSchemaMissingError extends Error {}
  return {
    GIFT_EMAIL_MIGRATION: "migrations/0005_gift_claim_email_flags.sql",
    GiftSchemaMissingError,
    getGiftDetails: mocks.getGiftDetails,
    createGiftClaim: mocks.createGiftClaim,
    reserveGiftEmail: mocks.reserveGiftEmail,
    releaseGiftEmail: mocks.releaseGiftEmail,
    markGiftEmailSent: mocks.markGiftEmailSent,
  };
});

/** Stateful stand-ins: a lease per (order, kind) and the sent flag. */
let reserved = new Set<string>();
let sent = new Set<string>();

vi.mock("~/lib/orphan-payments", () => ({
  recordOrphanPayment: vi.fn().mockResolvedValue(true),
}));

vi.mock("~/lib/gift-email", () => ({
  sendGiftEmail: mocks.sendGiftEmail,
  sendGiftBuyerEmail: mocks.sendGiftBuyerEmail,
  claimUrlFor: mocks.claimUrlFor,
  giftEmailConfigured: mocks.giftEmailConfigured,
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
    mocks.sendGiftEmail.mockResolvedValue("sent");
    mocks.sendGiftBuyerEmail.mockResolvedValue("sent");
    mocks.giftEmailConfigured.mockReturnValue(true);
    reserved = new Set();
    sent = new Set();
    mocks.reserveGiftEmail.mockImplementation(async (orderId: string, kind: string) => {
      const key = `${orderId}:${kind}`;
      if (sent.has(key)) return "sent";
      if (reserved.has(key)) return "busy";
      reserved.add(key);
      return "reserved";
    });
    mocks.markGiftEmailSent.mockImplementation(async (orderId: string, kind: string) => {
      reserved.delete(`${orderId}:${kind}`);
      sent.add(`${orderId}:${kind}`);
    });
    mocks.releaseGiftEmail.mockImplementation(async (orderId: string, kind: string) => {
      reserved.delete(`${orderId}:${kind}`);
    });
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
  });

  test("emails go out once even when the token was minted elsewhere first (created:false)", async () => {
    mocks.getGiftDetails.mockResolvedValue({
      orderId: "11111111-1111-4111-8111-111111111111",
      recipientEmail: "recipient@example.com",
      senderName: null,
      note: null,
    });
    mocks.createGiftClaim.mockResolvedValue({ token: "token_123", created: false });
    const event = checkoutEvent("checkout.session.completed");
    (event.data.object as Record<string, unknown>).customer_details = { email: "buyer@example.com" };

    mocks.markPaid.mockResolvedValueOnce("already-paid").mockResolvedValue("duplicate");
    await handleStripeWebhook(requestFor(event));
    await handleStripeWebhook(requestFor(event));
    expect(mocks.sendGiftEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendGiftBuyerEmail).toHaveBeenCalledTimes(1);
  });

  test("a failed send releases the lease AND answers 500; the retry sends it once", async () => {
    mocks.getGiftDetails.mockResolvedValue({
      orderId: "11111111-1111-4111-8111-111111111111",
      recipientEmail: "recipient@example.com",
      senderName: null,
      note: null,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.sendGiftEmail.mockResolvedValueOnce("failed").mockResolvedValue("sent");
    mocks.markPaid.mockResolvedValueOnce("applied").mockResolvedValue("duplicate");
    const first = await handleStripeWebhook(requestFor(checkoutEvent("checkout.session.completed")));
    expect(first.status).toBe(500);
    expect(mocks.releaseGiftEmail).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "recipient",
    );
    expect(mocks.markGiftEmailSent).not.toHaveBeenCalled();
    const retry = await handleStripeWebhook(requestFor(checkoutEvent("checkout.session.completed")));
    expect(retry.status).toBe(200);
    const again = await handleStripeWebhook(requestFor(checkoutEvent("checkout.session.completed")));
    expect(again.status).toBe(200);
    expect(mocks.sendGiftEmail).toHaveBeenCalledTimes(2); // the failure + one success, never more
  });

  test("a permanently rejected send (4xx) is logged and not retried", async () => {
    mocks.getGiftDetails.mockResolvedValue({
      orderId: "11111111-1111-4111-8111-111111111111",
      recipientEmail: "bad@example.com",
      senderName: null,
      note: null,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.sendGiftEmail.mockResolvedValue("rejected");
    const res = await handleStripeWebhook(requestFor(checkoutEvent("checkout.session.completed")));
    expect(res.status).toBe(200);
    expect(mocks.releaseGiftEmail).toHaveBeenCalled();
  });

  test("a lease held by another delivery answers 500 so Stripe comes back", async () => {
    mocks.getGiftDetails.mockResolvedValue({
      orderId: "11111111-1111-4111-8111-111111111111",
      recipientEmail: "recipient@example.com",
      senderName: null,
      note: null,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.reserveGiftEmail.mockResolvedValueOnce("busy");
    const res = await handleStripeWebhook(requestFor(checkoutEvent("checkout.session.completed")));
    expect(res.status).toBe(500);
    expect(mocks.sendGiftEmail).not.toHaveBeenCalled();
  });

  test("email not configured: nothing reserved, 200 (a retry cannot fix config)", async () => {
    mocks.getGiftDetails.mockResolvedValue({
      orderId: "11111111-1111-4111-8111-111111111111",
      recipientEmail: "recipient@example.com",
      senderName: null,
      note: null,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.giftEmailConfigured.mockReturnValue(false);
    const res = await handleStripeWebhook(requestFor(checkoutEvent("checkout.session.completed")));
    expect(res.status).toBe(200);
    expect(mocks.createGiftClaim).toHaveBeenCalledTimes(1);
    expect(mocks.reserveGiftEmail).not.toHaveBeenCalled();
    expect(mocks.sendGiftEmail).not.toHaveBeenCalled();
  });

  test("missing 0005 email-flag columns → 500 so Stripe retries (token already minted)", async () => {
    const { GiftSchemaMissingError } = await import("~/lib/gifts");
    mocks.getGiftDetails.mockResolvedValue({
      orderId: "11111111-1111-4111-8111-111111111111",
      recipientEmail: "recipient@example.com",
      senderName: null,
      note: null,
    });
    mocks.reserveGiftEmail.mockRejectedValue(new GiftSchemaMissingError("x"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handleStripeWebhook(requestFor(checkoutEvent("checkout.session.completed")));
    expect(res.status).toBe(500);
    expect(mocks.createGiftClaim).toHaveBeenCalledTimes(1);
    expect(mocks.sendGiftEmail).not.toHaveBeenCalled();
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
        idempotencyKey: `gift-buyer-${ORDER_ID}`,
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
        idempotencyKey: `gift-recipient-${ORDER_ID}`,
      });
      expect(mocks.sendGiftBuyerEmail).toHaveBeenCalledWith({
        to: "buyer@example.com",
        recipientEmail: "recipient@example.com",
        claimUrl: "https://divine.example/claim/token_123",
        idempotencyKey: `gift-buyer-${ORDER_ID}`,
      });
    });

    test("email failure (e.g. Resend unset) never fails the webhook or the claim", async () => {
      mocks.getGiftDetails.mockResolvedValue({
        orderId: ORDER_ID,
        recipientEmail: null,
        senderName: null,
        note: null,
      });
      mocks.sendGiftBuyerEmail.mockResolvedValue("failed");
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
