import { createHash, createHmac } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const DAY = 24 * 60 * 60 * 1000;

type Order = {
  id: string;
  sku: string;
  status: string;
  credits: number;
  recipient_email: string | null;
  sender_name: string | null;
  note: string | null;
  paid_at: Date | null;
};
type Claim = {
  token: string;
  order_id: string;
  claimed: boolean;
  claimed_at: Date | null;
  created_at: Date;
};

let orders: Map<string, Order>;
let claims: Claim[];
let readings: { order_id: string; payload: unknown }[];

function norm(strings: TemplateStringsArray): string {
  return strings.join(" ? ").replace(/\s+/g, " ").trim().toLowerCase();
}

async function query(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  const q = norm(strings);
  if (q.startsWith("create ") || q.startsWith("with ranked as")) return [];

  if (q.startsWith("select id, recipient_email, sender_name, note from orders")) {
    const o = orders.get(String(values[0]));
    return o && o.sku === "giftReading" ? [o] : [];
  }
  if (q.startsWith("select c.token from orders o left join gift_claims")) {
    const o = orders.get(String(values[0]));
    if (!o || o.status !== "paid") return [];
    return [{ token: claims.find((c) => c.order_id === o.id)?.token ?? null }];
  }
  if (q.startsWith("with inserted as ( insert into gift_claims")) {
    const [stored, orderId] = values as [string, string];
    const existing = claims.find((c) => c.order_id === orderId);
    if (existing) return [{ token: existing.token, created: false }];
    claims.push({ token: stored, order_id: orderId, claimed: false, claimed_at: null, created_at: new Date() });
    return [{ token: stored, created: true }];
  }
  if (q.startsWith("select c.token as stored_token")) {
    const [hashed, raw] = values as [string, string];
    const match =
      claims.find((c) => c.token === hashed) ?? claims.find((c) => c.token === raw);
    if (!match) return [];
    const o = orders.get(match.order_id)!;
    if (o.status !== "paid") return [];
    return [
      {
        stored_token: match.token,
        order_id: match.order_id,
        claimed: match.claimed,
        paid_at: o.paid_at,
        claim_created_at: match.created_at,
        sender_name: o.sender_name,
        note: o.note,
      },
    ];
  }
  if (q.startsWith("select payload from readings")) {
    const r = readings.filter((x) => x.order_id === values[0]).at(-1);
    return r ? [{ payload: r.payload }] : [];
  }
  if (q.startsWith("with burned as ( update gift_claims c")) {
    const [stored, ttl, ttl2, readingId, payload] = values as [
      string,
      number | null,
      number | null,
      string,
      string,
    ];
    expect(ttl2).toBe(ttl);
    const c = claims.find((x) => x.token === stored && !x.claimed);
    const o = c ? orders.get(c.order_id) : undefined;
    const from = o?.paid_at ?? c?.created_at;
    const inWindow = ttl === null || (from && from.getTime() + ttl * DAY > Date.now());
    if (!c || !o || o.status !== "paid" || !inWindow) return [{ order_id: null, reading_id: null }];
    c.claimed = true;
    c.claimed_at = new Date();
    o.credits = Math.max(o.credits - 1, 0);
    readings.push({ order_id: c.order_id, payload: JSON.parse(payload) });
    return [{ order_id: c.order_id, reading_id: readingId }];
  }
  throw new Error(`Unexpected query in test double: ${q}`);
}

vi.mock("~/db", () => ({ sql: () => query }));
vi.mock("~/lib/orders", () => ({}));

import {
  claimGift,
  createGiftClaim,
  deriveToken,
  getClaimForPaidGift,
  getClaim,
  GiftTokenSecretMissingError,
  giftTokenTtlDays,
  hashToken,
} from "~/lib/gifts";
import { EXPIRED_BODY, EXPIRED_TITLE, ExpiredGift } from "~/routes/claim.$token";

const ORDER = "44444444-4444-4444-8444-444444444444";
const SECRET = "test-secret-not-real";

function seed(overrides: Partial<Order> = {}): Order {
  const o: Order = {
    id: ORDER,
    sku: "giftReading",
    status: "paid",
    credits: 1,
    recipient_email: null,
    sender_name: "A. Sender",
    note: "for you",
    paid_at: new Date(),
    ...overrides,
  };
  orders.set(o.id, o);
  return o;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

beforeEach(() => {
  orders = new Map();
  claims = [];
  readings = [];
  process.env.GIFT_TOKEN_SECRET = SECRET;
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.GIFT_TOKEN_TTL_DAYS;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GIFT_TOKEN_SECRET;
  delete process.env.GIFT_TOKEN_TTL_DAYS;
});

describe("hashed claim tokens", () => {
  test("stores only the SHA-256 of the link token, and looks it up by hash", async () => {
    seed();
    const { token, created } = await createGiftClaim(ORDER);
    expect(created).toBe(true);
    expect(token).toMatch(/^[0-9a-f]{32}$/);

    expect(claims).toHaveLength(1);
    expect(claims[0].token).toBe(sha256(token!));
    expect(claims[0].token).not.toContain(token!);

    const view = await getClaim(token!);
    expect(view).toMatchObject({ senderName: "A. Sender", claimed: false, expired: false });
    // The stored hash itself is not a usable link.
    expect(await getClaim(claims[0].token)).toBeNull();
  });

  test("hashToken matches Postgres encode(sha256(convert_to(token,'UTF8')),'hex')", async () => {
    expect(await hashToken("abc")).toBe(sha256("abc"));
  });

  test("the token is derived with the server secret, so the buyer view can re-show it", async () => {
    seed();
    const first = await createGiftClaim(ORDER);
    const again = await getClaimForPaidGift(ORDER);
    expect(again).toMatchObject({ token: first.token });
    expect(await createGiftClaim(ORDER)).toEqual({ token: first.token, created: false });
    expect(first.token).toBe(
      createHmac("sha256", SECRET).update(`gift-claim:v1:${ORDER}`).digest("hex").slice(0, 32),
    );
    // A different secret yields a different token: not guessable from the order id.
    expect(await deriveToken(ORDER, { GIFT_TOKEN_SECRET: "other" })).not.toBe(first.token);
  });

  test("falls back to BETTER_AUTH_SECRET", async () => {
    expect(await deriveToken(ORDER, { BETTER_AUTH_SECRET: "x" })).toMatch(/^[0-9a-f]{32}$/);
    expect(await deriveToken(ORDER, {})).toBeNull();
  });

  test("with no secret at all, minting FAILS CLOSED and stores nothing", async () => {
    delete process.env.GIFT_TOKEN_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    seed();
    await expect(createGiftClaim(ORDER)).rejects.toBeInstanceOf(GiftTokenSecretMissingError);
    expect(claims).toHaveLength(0);
    expect(JSON.stringify(err.mock.calls)).toContain("NOT minted");
  });

  test("legacy plaintext tokens already in production keep working end to end", async () => {
    seed();
    const legacy = "0123456789abcdef0123456789abcdef";
    claims.push({ token: legacy, order_id: ORDER, claimed: false, claimed_at: null, created_at: new Date() });

    expect((await getClaim(legacy))?.claimed).toBe(false);
    // The buyer view still shows the legacy link.
    expect((await getClaimForPaidGift(ORDER))?.token).toBe(legacy);
    expect(await claimGift(legacy, { card: "the-star" })).toEqual({ ok: true });
    expect(await getClaim(legacy)).toMatchObject({ claimed: true, reading: { card: "the-star" } });
  });

  test("a legacy token rehashed by the backfill still opens", async () => {
    seed();
    const legacy = "fedcba9876543210fedcba9876543210";
    claims.push({ token: sha256(legacy), order_id: ORDER, claimed: false, claimed_at: null, created_at: new Date() });
    expect((await getClaim(legacy))?.claimed).toBe(false);
  });

  test("single use is still enforced", async () => {
    seed();
    const { token } = await createGiftClaim(ORDER);
    expect(await claimGift(token!, { card: "the-sun" })).toEqual({ ok: true });
    expect(await claimGift(token!, { card: "the-moon" })).toEqual({
      ok: false,
      reason: "already_claimed",
    });
    expect(readings).toHaveLength(1);
    expect(orders.get(ORDER)!.credits).toBe(0);
    // Re-opening shows the same card as a keepsake.
    expect(await getClaim(token!)).toMatchObject({ claimed: true, reading: { card: "the-sun" } });
  });

  test("unknown and malformed tokens are not found", async () => {
    seed();
    await createGiftClaim(ORDER);
    expect(await getClaim("f".repeat(32))).toBeNull();
    expect(await getClaim("not-a-token")).toBeNull();
    expect(await claimGift("f".repeat(32), {})).toEqual({ ok: false, reason: "not_found" });
  });

  test("tokens for unpaid orders do not open", async () => {
    seed({ status: "pending" });
    const { token } = await createGiftClaim(ORDER);
    expect(await getClaim(token!)).toBeNull();
    expect(await getClaimForPaidGift(ORDER)).toBeNull();
  });
});

describe("buyer view is read-only", () => {
  test("getClaimForPaidGift never mints; a paid gift without a token returns token null", async () => {
    seed();
    expect(await getClaimForPaidGift(ORDER)).toMatchObject({ token: null });
    expect(claims).toHaveLength(0);
  });
});

describe("configurable expiry (GIFT_TOKEN_TTL_DAYS)", () => {
  test("unset, empty, zero, negative or junk means NO time-based expiry", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const v of [undefined, "", "  ", "0", "-5", "abc", "Infinity"]) {
      expect(giftTokenTtlDays({ GIFT_TOKEN_TTL_DAYS: v })).toBeNull();
    }
    seed({ paid_at: new Date(Date.now() - 10 * 365 * DAY) });
    const { token } = await createGiftClaim(ORDER);
    expect(await getClaim(token!)).toMatchObject({ expired: false });
    expect(await claimGift(token!, { card: "x" })).toEqual({ ok: true });
  });

  test("when set, an unclaimed link expires that many days after purchase", async () => {
    process.env.GIFT_TOKEN_TTL_DAYS = "365";
    seed({ paid_at: new Date(Date.now() - 366 * DAY) });
    const { token } = await createGiftClaim(ORDER);
    expect(await getClaim(token!)).toMatchObject({ expired: true, reading: null });
    expect(await claimGift(token!, { card: "x" })).toEqual({ ok: false, reason: "expired" });
    expect(claims[0].claimed).toBe(false);
    expect(readings).toHaveLength(0);
  });

  test("when set, a link inside the window still works", async () => {
    process.env.GIFT_TOKEN_TTL_DAYS = "365";
    seed({ paid_at: new Date(Date.now() - 364 * DAY) });
    const { token } = await createGiftClaim(ORDER);
    expect(await getClaim(token!)).toMatchObject({ expired: false });
    expect(await claimGift(token!, { card: "x" })).toEqual({ ok: true });
  });

  test("the burn UPDATE itself enforces the window (GET/POST cannot disagree)", async () => {
    seed({ paid_at: new Date(Date.now() - 100 * DAY) });
    const { token } = await createGiftClaim(ORDER);
    // The pre-check sees no TTL; the TTL "appears" between pre-check and burn.
    const real = process.env;
    let reads = 0;
    process.env = new Proxy(real, {
      get(target, key) {
        if (key === "GIFT_TOKEN_TTL_DAYS") return reads++ === 0 ? undefined : "30";
        return Reflect.get(target, key);
      },
    });
    try {
      expect(await claimGift(token!, { card: "x" })).toEqual({ ok: false, reason: "expired" });
    } finally {
      process.env = real;
    }
    expect(claims[0].claimed).toBe(false);
    expect(readings).toHaveLength(0);
  });

  test("a claimed gift never expires (the keepsake link keeps working)", async () => {
    seed({ paid_at: new Date(Date.now() - 400 * DAY) });
    const { token } = await createGiftClaim(ORDER);
    await claimGift(token!, { card: "the-world" });
    process.env.GIFT_TOKEN_TTL_DAYS = "30";
    expect(await getClaim(token!)).toMatchObject({
      claimed: true,
      expired: false,
      reading: { card: "the-world" },
    });
  });

  test("the expired page uses the friendly copy and offers support when configured", () => {
    expect(EXPIRED_TITLE).toBe("This gift link has expired");
    const html = renderToStaticMarkup(createElement(ExpiredGift, { supportEmail: "help@example.com" }));
    expect(html).toContain("This gift link has expired");
    expect(html).toContain("contact support");
    expect(html).toContain("mailto:help@example.com");
    expect(EXPIRED_BODY).toMatch(/contact support/i);
    const bare = renderToStaticMarkup(createElement(ExpiredGift, { supportEmail: null }));
    expect(bare).not.toContain("mailto:");
  });
});
