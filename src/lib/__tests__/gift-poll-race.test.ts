/**
 * Regression for QA's #32 blocker: the buyer page polls /api/order/:id every
 * 3s. If a poll landed after markPaid but before the webhook minted the claim
 * token, the poll used to mint it, the webhook then saw "already created" and
 * skipped BOTH the recipient email and the buyer receipt. The order route is
 * now read-only, so the webhook always mints and always sends exactly once.
 *
 * Uses the real gifts.ts, order route and webhook against an in-memory SQL
 * double; only markPaid / signature / email sending are stubbed.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const ORDER = "55555555-5555-4555-8555-555555555555";

type Row = {
  token: string;
  order_id: string;
  claimed: boolean;
  recipient_emailed_at?: Date | null;
  buyer_emailed_at?: Date | null;
  recipient_email_lease_until?: number | null;
  buyer_email_lease_until?: number | null;
};
let order: {
  id: string;
  sku: string;
  status: string;
  credits: number;
  recipient_email: string | null;
};
let claims: Row[];
let readings: { order_id: string; payload: unknown }[];
let inserts: number;

function norm(strings: TemplateStringsArray): string {
  return strings.join(" ? ").replace(/\s+/g, " ").trim().toLowerCase();
}

async function query(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  const q = norm(strings);
  if (q.startsWith("create ") || q.startsWith("with ranked as")) return [];
  if (q.startsWith("select id, recipient_email, sender_name, note from orders")) {
    return values[0] === order.id && order.sku === "giftReading"
      ? [{ id: order.id, recipient_email: order.recipient_email, sender_name: "Sam", note: null }]
      : [];
  }
  if (q.startsWith("select c.token from orders o left join gift_claims")) {
    if (values[0] !== order.id || order.status !== "paid") return [];
    return [{ token: claims.find((c) => c.order_id === order.id)?.token ?? null }];
  }
  if (q.startsWith("with inserted as ( insert into gift_claims")) {
    inserts += 1;
    const [token, orderId] = values as [string, string];
    const existing = claims.find((c) => c.order_id === orderId);
    if (existing) return [{ token: existing.token, created: false }];
    claims.push({ token, order_id: orderId, claimed: false });
    return [{ token, created: true }];
  }
  if (q.startsWith("with burned as ( update gift_claims")) {
    const [token, readingId, payload] = values as [string, string, string];
    const c = claims.find((x) => x.token === token && !x.claimed);
    if (!c) return [{ order_id: null, reading_id: null }];
    c.claimed = true;
    if (order.status === "paid") order.credits = Math.max(order.credits - 1, 0);
    readings.push({ order_id: c.order_id, payload: JSON.parse(payload) });
    return [{ order_id: c.order_id, reading_id: readingId }];
  }
  const lease = /^update gift_claims set (recipient|buyer)_email_lease_until = now\(\) \+ make_interval/.exec(q);
  if (lease) {
    const kind = lease[1] as "recipient" | "buyer";
        const [secs, orderId] = values as [number, string];
    const c = claims.find((x) => x.order_id === orderId);
    if (!c || c[`${kind}_emailed_at`] || (c as Record<string, unknown>)[`${kind}_email_failed_at`]) return [];
    const until = c[`${kind}_email_lease_until`];
    if (until && until > Date.now()) return [];
    c[`${kind}_email_lease_until`] = Date.now() + Number(secs) * 1000;
    return [{ order_id: orderId, lease: String(c[`${kind}_email_lease_until`]) }];
  }
  const sentQ = /^select (recipient|buyer)_emailed_at is not null as sent(?:, \w+ is not null as failed)? from gift_claims/.exec(q);
  if (sentQ) {
    const c = claims.find((x) => x.order_id === values[0]);
    const k = sentQ[1] as "recipient" | "buyer";
    return c
      ? [{ sent: Boolean(c[`${k}_emailed_at`]), failed: Boolean((c as Record<string, unknown>)[`${k}_email_failed_at`]) }]
      : [];
  }
  const mark = /^update gift_claims set (recipient|buyer)_emailed_at = now\(\), \w+ = null/.exec(q);
  if (mark) {
    const kind = mark[1] as "recipient" | "buyer";
    const c = claims.find((x) => x.order_id === values[0]);
    if (c) {
      c[`${kind}_emailed_at`] = new Date();
      c[`${kind}_email_lease_until`] = null;
    }
    return [];
  }
  const failQ = /^update gift_claims set (recipient|buyer)_email_failed_at = now\(\)(, \w+ = null)? where/.exec(q);
  if (failQ) {
    const kind = failQ[1] as "recipient" | "buyer";
    const c = claims.find((x) => x.order_id === values[0]) as Record<string, unknown> | undefined;
    if (!c || c[`${kind}_emailed_at`]) return [];
    if (failQ[2]) {
      // permanent rejection, holder only (lease fencing token = values[1])
      if (String(c[`${kind}_email_lease_until`]) !== String(values[1])) return [];
      c[`${kind}_email_failed_at`] = new Date();
      c[`${kind}_email_lease_until`] = null;
      return [{ order_id: values[0] }];
    }
    if (c[`${kind}_email_failed_at`]) return [];
    const [, maxAttempts, giveUpSecs] = values as [string, number, number];
    const paidAt = ((order as unknown as Record<string, unknown>).paid_at as Date | undefined)?.getTime() ?? Date.now();
    const tooOld = paidAt < Date.now() - Number(giveUpSecs) * 1000;
    if (Number(c[`${kind}_email_attempts`] ?? 0) >= Number(maxAttempts) || tooOld) {
      c[`${kind}_email_failed_at`] = new Date();
      return [{ order_id: values[0] }];
    }
    return [];
  }
  const release = /^update gift_claims set (recipient|buyer)_email_lease_until = null/.exec(q);
  if (release) {
    const kind = release[1] as "recipient" | "buyer";
    const c = claims.find((x) => x.order_id === values[0]);
    if (!c || c[`${kind}_emailed_at`]) return [];
    // holder only: the lease fencing token is the last parameter
    if (String(c[`${kind}_email_lease_until`]) !== String(values[values.length - 1])) return [];
    c[`${kind}_email_lease_until`] = null;
    if (q.includes("_email_attempts = ")) {
      const r = c as Record<string, unknown>;
      r[`${kind}_email_attempts`] = Number(r[`${kind}_email_attempts`] ?? 0) + 1;
    }
    return [{ order_id: values[0] }];
  }
  if (q.startsWith("select 1 from gift_claims where token")) {
    return claims.some((c) => c.token === values[0]) ? [{}] : [];
  }
  throw new Error(`Unexpected query in test double: ${q}`);
}

const mocks = vi.hoisted(() => ({
  markPaid: vi.fn(),
  sendGiftEmail: vi.fn(),
  sendGiftBuyerEmail: vi.fn(),
}));

const access = vi.hoisted(() => ({ checkOrderAccess: vi.fn() }));
vi.mock("~/lib/order-access", () => ({
  checkOrderAccess: access.checkOrderAccess,
  orderTokenFrom: (r: Request) => r.headers.get("x-order-token"),
}));

vi.mock("~/db", () => ({ sql: () => query }));
vi.mock("~/lib/stripe-signature", () => ({
  verifyStripeSignature: async () => ({ ok: true }),
}));
vi.mock("~/lib/orders", () => ({
  markPaid: mocks.markPaid,
  listReadings: async () => [],
  getOrder: async (id: string) =>
    id === order.id
      ? { id, sku: order.sku, status: order.status, credits: order.credits, kind: "gift" }
      : null,
}));
vi.mock("~/lib/gift-email", async () => {
  const actual = await vi.importActual<typeof import("~/lib/gift-email")>("~/lib/gift-email");
  return {
    ...actual,
    sendGiftEmail: mocks.sendGiftEmail,
    sendGiftBuyerEmail: mocks.sendGiftBuyerEmail,
  };
});

import { claimGift } from "~/lib/gifts";
import { handleOrderGet } from "~/routes/api/order.$orderId";
import { handleStripeWebhook } from "~/routes/api/stripe-webhook";

function webhook(): Request {
  return new Request("https://divine.example/api/stripe-webhook", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=x" },
    body: JSON.stringify({
      id: "evt_gift",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_gift",
          client_reference_id: ORDER,
          payment_status: "paid",
          amount_total: 500,
          currency: "usd",
          customer_details: { email: "buyer@example.com" },
        },
      },
    }),
  });
}
const poll = () => handleOrderGet(ORDER, new Request(`https://divine.example/api/order/${ORDER}`));

beforeEach(() => {
  vi.resetAllMocks();
  access.checkOrderAccess.mockResolvedValue("granted");
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  delete process.env.PUBLIC_SITE_URL;
  order = { id: ORDER, sku: "giftReading", status: "pending", credits: 1, recipient_email: "friend@example.com" };
  claims = [];
  readings = [];
  inserts = 0;
  mocks.sendGiftEmail.mockResolvedValue("sent");
  mocks.sendGiftBuyerEmail.mockResolvedValue("sent");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("GIFT_FROM_EMAIL", "gifts@example.com");
});

describe("poll-before-webhook race", () => {
  test("a poll between markPaid and the webhook mints nothing, and the webhook still sends both emails once", async () => {
    // markPaid has committed (status paid), but the webhook has not minted yet.
    order.status = "paid";
    const early = (await (await poll()).json()) as Record<string, unknown>;
    expect(early.status).toBe("paid");
    expect(early.claimUrl).toBeUndefined();
    expect(claims).toHaveLength(0);

    // The webhook (Stripe retry: markPaid answers already-paid) mints and emails.
    mocks.markPaid.mockResolvedValue("already-paid");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await handleStripeWebhook(webhook())).status).toBe(200);
    expect(claims).toHaveLength(1);
    const url = `https://divine.example/claim/${claims[0].token}`;
    expect(mocks.sendGiftEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendGiftEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "friend@example.com", claimUrl: url }),
    );
    expect(mocks.sendGiftBuyerEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendGiftBuyerEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "buyer@example.com", claimUrl: url }),
    );

    // Later polls show the same link and still mint nothing.
    for (let i = 0; i < 3; i++) {
      expect(((await (await poll()).json()) as Record<string, unknown>).claimUrl).toBe(url);
    }
    expect(inserts).toBe(1);

    // A duplicate delivery re-asserts the token but does not email again.
    mocks.markPaid.mockResolvedValue("duplicate");
    await handleStripeWebhook(webhook());
    expect(mocks.sendGiftEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendGiftBuyerEmail).toHaveBeenCalledTimes(1);
  });

  test("no-recipient gift: poll first, then webhook — buyer still gets the receipt with the link", async () => {
    order.recipient_email = null;
    order.status = "paid";
    await poll();
    mocks.markPaid.mockResolvedValue("applied");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await handleStripeWebhook(webhook());
    expect(mocks.sendGiftEmail).not.toHaveBeenCalled();
    expect(mocks.sendGiftBuyerEmail).toHaveBeenCalledTimes(1);
    expect(((await (await poll()).json()) as Record<string, unknown>).claimUrl).toContain("/claim/");
  });
});

describe("token minted outside the webhook first", () => {
  test("a pre-existing token (e.g. backfill) still gets both emails exactly once", async () => {
    order.status = "paid";
    claims.push({ token: "9".repeat(32), order_id: ORDER, claimed: false });
    mocks.markPaid.mockResolvedValue("already-paid");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await handleStripeWebhook(webhook());
    mocks.markPaid.mockResolvedValue("duplicate");
    await handleStripeWebhook(webhook());
    expect(mocks.sendGiftEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendGiftBuyerEmail).toHaveBeenCalledTimes(1);
    expect(claims[0].recipient_emailed_at).toBeInstanceOf(Date);
    expect(claims[0].buyer_emailed_at).toBeInstanceOf(Date);
  });
});

describe("atomic claim", () => {
  test("burn, credit and reading happen in one statement; a second claim gets nothing", async () => {
    order.status = "paid";
    mocks.markPaid.mockResolvedValue("applied");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await handleStripeWebhook(webhook());
    const token = claims[0].token;

    expect(await claimGift(token, { card: "the-star" })).toEqual({ ok: true });
    expect(await claimGift(token, { card: "the-moon" })).toEqual({ ok: false, reason: "already_claimed" });
    expect(readings).toEqual([{ order_id: ORDER, payload: { card: "the-star" } }]);
    expect(order.credits).toBe(0);
    expect(await claimGift("0".repeat(32), {})).toEqual({ ok: false, reason: "not_found" });
  });
});
