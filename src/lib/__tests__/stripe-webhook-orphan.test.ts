/**
 * A paid Stripe session we cannot fulfil (Payment Link opened directly, so no
 * client_reference_id; or an unknown order / price mismatch) must never be
 * silently dropped — especially a Gift Reading, which then has no recipient
 * and no claim link. It is recorded for support (manual reissue/refund).
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const m = vi.hoisted(() => ({
  verifyStripeSignature: vi.fn(),
  markPaid: vi.fn(),
  getGiftDetails: vi.fn(),
  createGiftClaim: vi.fn(),
  sendGiftEmail: vi.fn(),
  claimUrlFor: vi.fn(),
  rows: new Map<string, unknown[]>(),
  failDb: false,
}));

vi.mock("~/lib/stripe-signature", () => ({
  verifyStripeSignature: m.verifyStripeSignature,
}));
vi.mock("~/lib/orders", () => ({ markPaid: m.markPaid }));
vi.mock("~/lib/gifts", () => ({
  getGiftDetails: m.getGiftDetails,
  createGiftClaim: m.createGiftClaim,
}));
vi.mock("~/lib/gift-email", () => ({
  sendGiftEmail: m.sendGiftEmail,
  claimUrlFor: m.claimUrlFor,
}));
// The real orphan-payments module over an in-memory table.
vi.mock("~/db", () => ({
  sql:
    () =>
    async (strings: TemplateStringsArray, ...v: unknown[]) => {
      if (m.failDb) throw new Error("db down");
      const q = strings.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
      if (q.startsWith("create table")) return [];
      if (q.startsWith("insert into orphan_payments")) {
        const id = String(v[0]);
        if (m.rows.has(id)) return [];
        m.rows.set(id, v);
        return [{ stripe_session_id: id }];
      }
      throw new Error(`unexpected query: ${q}`);
    },
}));

import { handleStripeWebhook } from "~/routes/api/stripe-webhook";

function directGiftLinkEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_direct_gift",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_direct_gift",
        // No client_reference_id: bought straight from the Payment Link.
        payment_link: "plink_gift",
        payment_intent: "pi_gift",
        payment_status: "paid",
        amount_total: 500,
        currency: "usd",
        customer_details: { email: "buyer@example.com" },
        ...overrides,
      },
    },
  };
}

function req(event: unknown) {
  return new Request("https://di.example/api/stripe-webhook", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=x" },
    body: JSON.stringify(event),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.rows.clear();
  m.failDb = false;
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  m.verifyStripeSignature.mockResolvedValue({ ok: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("paid sessions that cannot be fulfilled", () => {
  test("a gift bought directly through the Payment Link is recorded for support, not dropped", async () => {
    const res = await handleStripeWebhook(req(directGiftLinkEvent()));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("no order reference");
    const row = m.rows.get("cs_direct_gift")!;
    expect(row).toEqual([
      "cs_direct_gift",
      "evt_direct_gift",
      "no-order-reference",
      null,
      "plink_gift",
      "pi_gift",
      500,
      "usd",
      "buyer@example.com",
    ]);
    // Nothing is fulfilled or minted without an order.
    expect(m.markPaid).not.toHaveBeenCalled();
    expect(m.createGiftClaim).not.toHaveBeenCalled();
    expect(m.sendGiftEmail).not.toHaveBeenCalled();
  });

  test("redelivery is idempotent (one row per session)", async () => {
    await handleStripeWebhook(req(directGiftLinkEvent()));
    const again = await handleStripeWebhook(req(directGiftLinkEvent()));
    expect(again.status).toBe(200);
    expect(m.rows.size).toBe(1);
  });

  test("an unpaid direct session (delayed method) is not recorded yet", async () => {
    const res = await handleStripeWebhook(
      req(directGiftLinkEvent({ payment_status: "unpaid" })),
    );
    expect(res.status).toBe(200);
    expect(m.rows.size).toBe(0);
  });

  test("if the record cannot be written, answer 500 so Stripe retries", async () => {
    m.failDb = true;
    const res = await handleStripeWebhook(req(directGiftLinkEvent()));
    expect(res.status).toBe(500);
  });

  test.each(["unknown-order", "amount-mismatch", "currency-mismatch"] as const)(
    "a refused fulfilment (%s) is recorded too",
    async (result) => {
      m.markPaid.mockResolvedValue(result);
      const event = directGiftLinkEvent({
        client_reference_id: "11111111-1111-4111-8111-111111111111",
      });
      const res = await handleStripeWebhook(req(event));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(result);
      const row = m.rows.get("cs_direct_gift")!;
      expect(row[2]).toBe(result);
      expect(row[3]).toBe("11111111-1111-4111-8111-111111111111");
    },
  );

  test("a normal fulfilled order records nothing", async () => {
    m.markPaid.mockResolvedValue("applied");
    m.getGiftDetails.mockResolvedValue(null);
    const event = directGiftLinkEvent({
      client_reference_id: "11111111-1111-4111-8111-111111111111",
    });
    const res = await handleStripeWebhook(req(event));
    expect(await res.text()).toBe("applied");
    expect(m.rows.size).toBe(0);
  });
});
