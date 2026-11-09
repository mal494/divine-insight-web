/**
 * #20 residual: a crash AFTER markPaid committed must not strand a paid gift.
 * Stripe redelivers the same event; markPaid then answers "duplicate" (or
 * "already-paid" for a sibling event), and the webhook must still finish the
 * idempotent gift steps: mint the one claim token and send each email once,
 * honouring recipient_emailed_at / buyer_emailed_at.
 *
 * Real orders.markPaid, real gifts.ts, real webhook, against an in-memory SQL
 * double that can be told to fail ("crash") at a given step. Only the
 * signature check and the outbound email calls are stubbed. Any DDL throws.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const ORDER = "66666666-6666-4666-8666-666666666666";

type Claim = {
  token: string;
  order_id: string;
  claimed: boolean;
  recipient_emailed_at: Date | null;
  buyer_emailed_at: Date | null;
};

let order: Record<string, unknown>;
let events: Set<string>;
let claims: Claim[];
let crashAt: string | null;

function norm(strings: TemplateStringsArray): string {
  return strings.join(" ? ").replace(/\s+/g, " ").trim().toLowerCase();
}

function step(name: string): void {
  if (crashAt === name) {
    crashAt = null; // crash once, like a cold start dying mid-request
    throw new Error(`simulated crash at ${name}`);
  }
}

async function query(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  const q = norm(strings);
  if (/^(create|alter|drop) /.test(q)) throw new Error(`runtime DDL: ${q}`);
  if (q.startsWith("select id from stripe_events")) {
    return events.has(values[0] as string) ? [{ id: values[0] }] : [];
  }
  if (q.startsWith("insert into stripe_events")) {
    if (events.has(values[0] as string)) return [];
    events.add(values[0] as string);
    return [{ id: values[0] }];
  }
  if (q.startsWith("select") && q.includes("from orders where id")) {
    return values[0] === order.id ? [{ ...order }] : [];
  }
  if (q.startsWith("update orders set status = 'paid'")) {
    if (order.status !== "pending") return [];
    order.status = "paid";
    order.paid_at = new Date();
    step("after-markPaid");
    return [{ id: order.id }];
  }
  if (q.startsWith("select id, recipient_email, sender_name, note from orders")) {
    return values[0] === order.id
      ? [{ id: order.id, recipient_email: order.recipient_email, sender_name: "Sam", note: null }]
      : [];
  }
  if (q.startsWith("with inserted as ( insert into gift_claims")) {
    step("mint");
    const [token, orderId] = values as [string, string];
    const existing = claims.find((c) => c.order_id === orderId);
    if (existing) return [{ token: existing.token, created: false }];
    claims.push({
      token,
      order_id: orderId,
      claimed: false,
      recipient_emailed_at: null,
      buyer_emailed_at: null,
    });
    return [{ token, created: true }];
  }
  const flag = /^update gift_claims set (recipient|buyer)_emailed_at = (now\(\)|null)/.exec(q);
  if (flag) {
    const kind = flag[1] as "recipient" | "buyer";
    const key = `${kind}_emailed_at` as const;
    const c = claims.find((x) => x.order_id === values[0]);
    if (!c) return [];
    if (flag[2] === "null") {
      c[key] = null;
      return [];
    }
    step(`reserve-${kind}`);
    if (c[key]) return [];
    c[key] = new Date();
    return [{ order_id: c.order_id }];
  }
  throw new Error(`Unexpected query in test double: ${q}`);
}

const mail = vi.hoisted(() => ({
  sendGiftEmail: vi.fn(),
  sendGiftBuyerEmail: vi.fn(),
}));

vi.mock("~/db", () => ({ sql: () => query }));
vi.mock("~/lib/stripe-signature", () => ({
  verifyStripeSignature: async () => ({ ok: true }),
}));
vi.mock("~/lib/orphan-payments", () => ({ recordOrphanPayment: vi.fn(async () => true) }));
vi.mock("~/lib/gift-email", async () => {
  const actual = await vi.importActual<typeof import("~/lib/gift-email")>("~/lib/gift-email");
  return { ...actual, ...mail };
});

import { handleStripeWebhook } from "~/routes/api/stripe-webhook";

function delivery(id = "evt_gift_1", type = "checkout.session.completed"): Request {
  return new Request("https://divine.example/api/stripe-webhook", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=x" },
    body: JSON.stringify({
      id,
      type,
      data: {
        object: {
          id: "cs_gift",
          client_reference_id: ORDER,
          payment_intent: "pi_gift",
          payment_status: "paid",
          amount_total: 500,
          currency: "usd",
          customer_details: { email: "buyer@example.com" },
        },
      },
    }),
  });
}

/** Stripe's behaviour: redeliver the same event until it gets a 2xx. */
async function deliverUntil2xx(make: () => Request, max = 5): Promise<Response[]> {
  const out: Response[] = [];
  for (let i = 0; i < max; i++) {
    let res: Response;
    try {
      res = await handleStripeWebhook(make());
    } catch {
      // An uncaught crash surfaces to Stripe as a 5xx / timeout.
      res = new Response("crashed", { status: 502 });
    }
    out.push(res);
    if (res.ok) break;
  }
  return out;
}

beforeEach(() => {
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test");
  order = {
    id: ORDER,
    sku: "giftReading",
    kind: "gift",
    status: "pending",
    credits: 1,
    amount_cents: 500,
    amount_currency: "usd",
    recipient_email: "friend@example.com",
    access_token_hash: null,
    created_at: new Date(),
    paid_at: null,
  };
  events = new Set();
  claims = [];
  crashAt = null;
  mail.sendGiftEmail.mockReset().mockResolvedValue(true);
  mail.sendGiftBuyerEmail.mockReset().mockResolvedValue(true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("gift webhook: crash after payment is recorded, then Stripe retries", () => {
  test.each(["after-markPaid", "mint", "reserve-recipient", "reserve-buyer"])(
    "crash at %s → retry completes the claim link and sends each email exactly once",
    async (where) => {
      crashAt = where;
      const responses = await deliverUntil2xx(() => delivery());

      expect(responses[0].ok).toBe(false); // the crash
      expect(responses.at(-1)!.status).toBe(200);
      expect(order.status).toBe("paid");
      expect(claims).toHaveLength(1);
      expect(claims[0].recipient_emailed_at).toBeInstanceOf(Date);
      expect(claims[0].buyer_emailed_at).toBeInstanceOf(Date);
      expect(mail.sendGiftEmail).toHaveBeenCalledTimes(1);
      expect(mail.sendGiftBuyerEmail).toHaveBeenCalledTimes(1);
      const url = `https://divine.example/claim/${claims[0].token}`;
      expect(mail.sendGiftEmail.mock.calls[0][0].claimUrl).toBe(url);
      expect(mail.sendGiftBuyerEmail.mock.calls[0][0].claimUrl).toBe(url);
    },
  );

  test("the retry is reported by markPaid as duplicate (same event) yet still delivers", async () => {
    crashAt = "mint";
    const responses = await deliverUntil2xx(() => delivery());
    expect(responses.map((r) => r.status)).toEqual([500, 200]);
    expect(await responses[1].text()).toBe("duplicate");
    expect(mail.sendGiftEmail).toHaveBeenCalledTimes(1);
  });

  test("a sibling event (async_payment_succeeded) after a crash finishes delivery as already-paid", async () => {
    crashAt = "reserve-recipient";
    const first = await handleStripeWebhook(delivery("evt_completed"));
    expect(first.status).toBe(500);
    // Order is paid and the claim exists, but no email has gone out yet.
    expect(claims).toHaveLength(1);
    expect(mail.sendGiftEmail).not.toHaveBeenCalled();

    const sibling = await handleStripeWebhook(
      delivery("evt_async", "checkout.session.async_payment_succeeded"),
    );
    expect(sibling.status).toBe(200);
    expect(await sibling.text()).toBe("already-paid");
    expect(mail.sendGiftEmail).toHaveBeenCalledTimes(1);
    expect(mail.sendGiftBuyerEmail).toHaveBeenCalledTimes(1);
  });

  test("emails already sent before the crash are not re-sent on retry", async () => {
    crashAt = "reserve-buyer"; // recipient email already went out
    await deliverUntil2xx(() => delivery());
    expect(mail.sendGiftEmail).toHaveBeenCalledTimes(1);
    expect(mail.sendGiftBuyerEmail).toHaveBeenCalledTimes(1);

    // Further redeliveries are no-ops for email.
    await handleStripeWebhook(delivery());
    await handleStripeWebhook(delivery("evt_other"));
    expect(mail.sendGiftEmail).toHaveBeenCalledTimes(1);
    expect(mail.sendGiftBuyerEmail).toHaveBeenCalledTimes(1);
    expect(claims).toHaveLength(1);
  });

  test("a send that throws releases the flag; the next delivery retries that email only", async () => {
    mail.sendGiftEmail.mockRejectedValueOnce(new Error("resend 503"));
    const first = await handleStripeWebhook(delivery());
    expect(first.status).toBe(200); // email is best-effort; link exists
    expect(claims[0].recipient_emailed_at).toBeNull();
    expect(claims[0].buyer_emailed_at).toBeInstanceOf(Date);

    await handleStripeWebhook(delivery("evt_again"));
    expect(mail.sendGiftEmail).toHaveBeenCalledTimes(2);
    expect(mail.sendGiftBuyerEmail).toHaveBeenCalledTimes(1);
  });
});
