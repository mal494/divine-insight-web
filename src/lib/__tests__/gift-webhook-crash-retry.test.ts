/**
 * #20 residual: a crash AFTER markPaid committed must not strand a paid gift.
 * Stripe redelivers the same event; markPaid then answers "duplicate" (or
 * "already-paid" for a sibling event), and the webhook must still finish the
 * idempotent gift steps: mint the one claim token and send each email once,
 * honouring recipient_emailed_at / buyer_emailed_at.
 *
 * Gift emails are at-least-once until recorded: a send lease
 * (*_email_lease_until) that expires if the process dies, *_emailed_at set
 * only after Resend accepted the email, and non-2xx on a failed send so
 * Stripe retries. Once recorded, an email is never sent again.
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
  recipient_email_lease_until: number | null;
  buyer_email_lease_until: number | null;
};

let order: Record<string, unknown>;
let events: Set<string>;
let claims: Claim[];
let crashAt: string | null;
/** Fake DB clock (ms) for lease expiry. */
let clock: number;

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
      recipient_email_lease_until: null,
      buyer_email_lease_until: null,
    });
    return [{ token, created: true }];
  }
  const lease = /^update gift_claims set (recipient|buyer)_email_lease_until = now\(\) \+ make_interval/.exec(q);
  if (lease) {
    const kind = lease[1] as "recipient" | "buyer";
    step(`reserve-${kind}`);
    const [secs, orderId] = values as [number, string];
    const c = claims.find((x) => x.order_id === orderId);
    if (!c || c[`${kind}_emailed_at`]) return [];
    const until = c[`${kind}_email_lease_until`];
    if (until && until > clock) return [];
    c[`${kind}_email_lease_until`] = clock + Number(secs) * 1000;
    step(`after-reserve-${kind}`); // committed, then the process dies
    return [{ order_id: orderId }];
  }
  const sentQ = /^select (recipient|buyer)_emailed_at is not null as sent from gift_claims/.exec(q);
  if (sentQ) {
    const c = claims.find((x) => x.order_id === values[0]);
    return c ? [{ sent: Boolean(c[`${sentQ[1] as "recipient" | "buyer"}_emailed_at`]) }] : [];
  }
  const mark = /^update gift_claims set (recipient|buyer)_emailed_at = now\(\), \w+ = null/.exec(q);
  if (mark) {
    const kind = mark[1] as "recipient" | "buyer";
    step(`mark-${kind}`);
    const c = claims.find((x) => x.order_id === values[0]);
    if (c) {
      c[`${kind}_emailed_at`] = new Date();
      c[`${kind}_email_lease_until`] = null;
    }
    return [];
  }
  const release = /^update gift_claims set (recipient|buyer)_email_lease_until = null/.exec(q);
  if (release) {
    const kind = release[1] as "recipient" | "buyer";
    const c = claims.find((x) => x.order_id === values[0]);
    if (c && !c[`${kind}_emailed_at`]) c[`${kind}_email_lease_until`] = null;
    return [];
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

import { GIFT_EMAIL_LEASE_SECONDS } from "~/lib/gifts";
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
  vi.stubEnv("GIFT_TOKEN_SECRET", "test-gift-token-secret-0123456789abcdef");
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
  clock = 1_000_000;
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("GIFT_FROM_EMAIL", "gifts@example.com");
  mail.sendGiftEmail.mockReset().mockResolvedValue("sent");
  mail.sendGiftBuyerEmail.mockReset().mockResolvedValue("sent");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("gift webhook: crash after payment is recorded, then Stripe retries", () => {
  test.each([
    "after-markPaid",
    "mint",
    "reserve-recipient",
    "reserve-buyer",
  ])(
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
      // Both emails carry the same, single claim link.
      const url = mail.sendGiftEmail.mock.calls[0][0].claimUrl as string;
      expect(url).toMatch(/^https:\/\/divine\.example\/claim\/[A-Za-z0-9_-]+$/);
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

  test("a failed send releases the lease and answers 500; the retry sends that email only", async () => {
    mail.sendGiftEmail.mockRejectedValueOnce(new Error("resend 503"));
    const first = await handleStripeWebhook(delivery());
    expect(first.status).toBe(500); // Stripe will retry
    expect(claims[0].recipient_emailed_at).toBeNull();
    expect(claims[0].recipient_email_lease_until).toBeNull(); // released at once
    expect(claims[0].buyer_emailed_at).toBeInstanceOf(Date);

    const retry = await handleStripeWebhook(delivery());
    expect(retry.status).toBe(200);
    expect(mail.sendGiftEmail).toHaveBeenCalledTimes(2);
    expect(mail.sendGiftBuyerEmail).toHaveBeenCalledTimes(1);
    expect(claims[0].recipient_emailed_at).toBeInstanceOf(Date);
  });

  test("a 'failed' result (Resend 5xx/429) is retried the same way", async () => {
    mail.sendGiftBuyerEmail.mockResolvedValueOnce("failed");
    const responses = await deliverUntil2xx(() => delivery());
    expect(responses.map((r) => r.status)).toEqual([500, 200]);
    expect(mail.sendGiftEmail).toHaveBeenCalledTimes(1);
    expect(mail.sendGiftBuyerEmail).toHaveBeenCalledTimes(2);
  });

  test("crash AFTER the reservation, before sending: the email is not lost", async () => {
    crashAt = "after-reserve-recipient";
    const first = await handleStripeWebhook(delivery());
    expect(first.status).toBe(500);
    expect(claims[0].recipient_email_lease_until).not.toBeNull(); // orphaned lease
    expect(claims[0].recipient_emailed_at).toBeNull(); // never marked sent
    expect(mail.sendGiftEmail).not.toHaveBeenCalled();

    // A retry inside the lease window does not double-send; it asks Stripe to come back.
    const early = await handleStripeWebhook(delivery());
    expect(early.status).toBe(500);
    expect(mail.sendGiftEmail).not.toHaveBeenCalled();

    // Lease expired: the next retry sends it, exactly once.
    clock += GIFT_EMAIL_LEASE_SECONDS * 1000 + 1;
    const late = await handleStripeWebhook(delivery());
    expect(late.status).toBe(200);
    expect(mail.sendGiftEmail).toHaveBeenCalledTimes(1);
    expect(mail.sendGiftBuyerEmail).toHaveBeenCalledTimes(1);
    expect(claims[0].recipient_emailed_at).toBeInstanceOf(Date);

    await handleStripeWebhook(delivery("evt_later"));
    expect(mail.sendGiftEmail).toHaveBeenCalledTimes(1);
  });

  test("crash after Resend accepted but before it was recorded: resent with the SAME idempotency key", async () => {
    crashAt = "mark-recipient";
    expect((await handleStripeWebhook(delivery())).status).toBe(500);
    clock += GIFT_EMAIL_LEASE_SECONDS * 1000 + 1;
    expect((await handleStripeWebhook(delivery())).status).toBe(200);
    const keys = mail.sendGiftEmail.mock.calls.map((c) => c[0].idempotencyKey);
    expect(keys).toEqual([`gift-recipient-${ORDER}`, `gift-recipient-${ORDER}`]);
    // Resend de-duplicates on that key; we record it and never send again.
    await handleStripeWebhook(delivery("evt_more"));
    expect(mail.sendGiftEmail).toHaveBeenCalledTimes(2);
  });

  test("email not configured: claim minted, nothing reserved, 200", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const res = await handleStripeWebhook(delivery());
    expect(res.status).toBe(200);
    expect(claims).toHaveLength(1);
    expect(claims[0].recipient_email_lease_until).toBeNull();
    expect(mail.sendGiftEmail).not.toHaveBeenCalled();
  });
});
