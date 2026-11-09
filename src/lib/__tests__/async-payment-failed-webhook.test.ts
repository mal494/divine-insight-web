import { beforeEach, describe, expect, test, vi } from "vitest";

const m = vi.hoisted(() => ({
  verifyStripeSignature: vi.fn(),
  markPaid: vi.fn(),
  markPaymentFailed: vi.fn(),
  getGiftDetails: vi.fn(),
  createGiftClaim: vi.fn(),
  sendGiftEmail: vi.fn(),
  claimUrlFor: vi.fn(),
  recordOrphanPayment: vi.fn(),
}));

vi.mock("~/lib/stripe-signature", () => ({
  verifyStripeSignature: m.verifyStripeSignature,
}));
vi.mock("~/lib/orders", () => ({
  markPaid: m.markPaid,
  markPaymentFailed: m.markPaymentFailed,
}));
vi.mock("~/lib/gifts", () => ({
  getGiftDetails: m.getGiftDetails,
  createGiftClaim: m.createGiftClaim,
}));
vi.mock("~/lib/gift-email", () => ({
  sendGiftEmail: m.sendGiftEmail,
  claimUrlFor: m.claimUrlFor,
}));
vi.mock("~/lib/orphan-payments", () => ({
  recordOrphanPayment: m.recordOrphanPayment,
}));

import { handleStripeWebhook } from "~/routes/api/stripe-webhook";

const ORDER = "11111111-1111-4111-8111-111111111111";

function req(object: Record<string, unknown>, id = "evt_failed") {
  return new Request("https://di.example/api/stripe-webhook", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=x" },
    body: JSON.stringify({
      id,
      type: "checkout.session.async_payment_failed",
      data: { object },
    }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  m.verifyStripeSignature.mockResolvedValue({ ok: true });
  m.markPaymentFailed.mockResolvedValue("failed");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("checkout.session.async_payment_failed", () => {
  test("marks the order failed and never fulfils, mints or emails", async () => {
    const res = await handleStripeWebhook(
      req({
        id: "cs_1",
        client_reference_id: ORDER,
        payment_status: "unpaid",
        amount_total: 500,
        currency: "usd",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("payment-failed:failed");
    expect(m.markPaymentFailed).toHaveBeenCalledWith({
      eventId: "evt_failed",
      orderId: ORDER,
      sessionId: "cs_1",
    });
    expect(m.markPaid).not.toHaveBeenCalled();
    expect(m.getGiftDetails).not.toHaveBeenCalled();
    expect(m.createGiftClaim).not.toHaveBeenCalled();
    expect(m.sendGiftEmail).not.toHaveBeenCalled();
    expect(m.recordOrphanPayment).not.toHaveBeenCalled();
  });

  test("a redelivered event is a 2xx no-op", async () => {
    m.markPaymentFailed.mockResolvedValue("duplicate");
    const res = await handleStripeWebhook(
      req({ id: "cs_1", client_reference_id: ORDER }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("payment-failed:duplicate");
  });

  test("an already-paid or unknown order is left alone, still 2xx", async () => {
    for (const r of ["not-pending", "unknown-order"]) {
      m.markPaymentFailed.mockResolvedValue(r);
      const res = await handleStripeWebhook(
        req({ id: "cs_1", client_reference_id: ORDER }),
      );
      expect(res.status).toBe(200);
    }
    expect(m.markPaid).not.toHaveBeenCalled();
  });

  test("no client_reference_id: 2xx, nothing recorded (no money moved)", async () => {
    const res = await handleStripeWebhook(
      req({ id: "cs_2", payment_status: "unpaid" }),
    );
    expect(res.status).toBe(200);
    expect(m.markPaymentFailed).not.toHaveBeenCalled();
    expect(m.recordOrphanPayment).not.toHaveBeenCalled();
  });
});
