import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOrder: vi.fn(),
  listReadings: vi.fn(),
  ensureClaimForPaidGift: vi.fn(),
}));

vi.mock("~/lib/orders", () => ({
  getOrder: mocks.getOrder,
  listReadings: mocks.listReadings,
}));
vi.mock("~/lib/gifts", () => ({
  ensureClaimForPaidGift: mocks.ensureClaimForPaidGift,
}));

import { ClaimLinkPanel } from "~/components/gift-reading";
import { buyerText } from "~/lib/gift-email";
import { resolveEntitlementFromOrders } from "~/lib/entitlement";
import { handleOrder } from "~/routes/api/order.$orderId";

const ORDER_ID = "33333333-3333-4333-8333-333333333333";
const req = () => new Request(`https://divine.example/api/order/${ORDER_ID}`);

function giftOrder(status: "paid" | "pending", credits = 1) {
  return { id: ORDER_ID, sku: "giftReading", status, credits, kind: "gift" };
}

describe("buyer's view of a paid gift", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.PUBLIC_SITE_URL;
  });

  test("a paid gift with no recipient email returns the claim link (minting it if missing)", async () => {
    mocks.getOrder.mockResolvedValue(giftOrder("paid"));
    mocks.ensureClaimForPaidGift.mockResolvedValue({
      token: "a".repeat(32),
      created: true,
      gift: { orderId: ORDER_ID, recipientEmail: null, senderName: null, note: null },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await handleOrder(ORDER_ID, req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      status: "paid",
      kind: "gift",
      credits: 1,
      claimUrl: `https://divine.example/claim/${"a".repeat(32)}`,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("a".repeat(32));
    warn.mockRestore();
  });

  test("a paid gift WITH a recipient email also shows the buyer the link", async () => {
    mocks.getOrder.mockResolvedValue(giftOrder("paid", 0));
    mocks.ensureClaimForPaidGift.mockResolvedValue({
      token: "b".repeat(32),
      created: false,
      gift: { orderId: ORDER_ID, recipientEmail: "r@example.com", senderName: null, note: null },
    });
    const body = (await (await handleOrder(ORDER_ID, req())).json()) as Record<string, unknown>;
    expect(body.claimUrl).toBe(`https://divine.example/claim/${"b".repeat(32)}`);
  });

  test("unpaid gifts and non-gift orders never expose a claim link", async () => {
    mocks.getOrder.mockResolvedValue(giftOrder("pending"));
    let body = (await (await handleOrder(ORDER_ID, req())).json()) as Record<string, unknown>;
    expect(body.claimUrl).toBeUndefined();
    expect(mocks.ensureClaimForPaidGift).not.toHaveBeenCalled();

    mocks.getOrder.mockResolvedValue({ ...giftOrder("paid"), sku: "singleInsight", kind: "single" });
    body = (await (await handleOrder(ORDER_ID, req())).json()) as Record<string, unknown>;
    expect(body).toEqual({ status: "paid", kind: "single", credits: 1 });
  });

  test("a claim lookup failure still answers the order status", async () => {
    mocks.getOrder.mockResolvedValue(giftOrder("paid"));
    mocks.ensureClaimForPaidGift.mockRejectedValue(new Error("db blip"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handleOrder(ORDER_ID, req());
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).status).toBe("paid");
  });

  test("the entitlement carries the claim link to the gift UI, which shows the share copy", () => {
    const url = `https://divine.example/claim/${"c".repeat(32)}`;
    const resolved = resolveEntitlementFromOrders([
      { id: ORDER_ID, status: "paid", credits: 1, claimUrl: url },
    ]);
    expect(resolved.claimUrl).toBe(url);
    expect(resolveEntitlementFromOrders([]).claimUrl).toBeNull();

    const html = renderToStaticMarkup(createElement(ClaimLinkPanel, { url }));
    expect(html).toContain("Share this link with the person you&#x27;re gifting");
    expect(html).toContain(url);
  });

  test("the buyer receipt email text carries the link and the share copy", () => {
    const url = "https://divine.example/claim/x";
    expect(buyerText(null, url)).toContain("Share this link with the person you're gifting:");
    expect(buyerText(null, url)).toContain(url);
    expect(buyerText("r@example.com", url)).toContain("r@example.com");
  });
});
