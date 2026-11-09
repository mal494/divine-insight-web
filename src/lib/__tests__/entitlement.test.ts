import { describe, expect, test, vi } from "vitest";
import {
  navigateCheckout,
  openCheckoutTab,
  resolveEntitlementFromOrders,
  runCheckout,
} from "../entitlement";

describe("resolveEntitlementFromOrders", () => {
  test("prefers a paid order with remaining credits over spent paid orders", () => {
    const result = resolveEntitlementFromOrders([
      { id: "old", status: "paid", credits: 0 },
      { id: "fresh", status: "paid", credits: 2 },
    ]);

    expect(result).toEqual({
      status: "unlocked",
      credits: 2,
      activeOrderId: "fresh",
      settled: true,
      claimUrl: null,
    });
  });

  test("reports spent when only paid orders with zero credits remain", () => {
    const result = resolveEntitlementFromOrders([{ id: "spent", status: "paid", credits: 0 }]);

    expect(result).toEqual({
      status: "spent",
      credits: 0,
      activeOrderId: "spent",
      settled: true,
      claimUrl: null,
    });
  });

  test("reports awaiting-payment when at least one tracked order is still pending", () => {
    const result = resolveEntitlementFromOrders([{ id: "pending", status: "pending", credits: 1 }]);

    expect(result).toEqual({
      status: "awaiting-payment",
      credits: 0,
      activeOrderId: null,
      settled: false,
      claimUrl: null,
    });
  });

  test("treats non-pending non-paid statuses as locked", () => {
    const result = resolveEntitlementFromOrders([{ id: "voided", status: "void", credits: 1 }]);

    expect(result).toEqual({
      status: "locked",
      credits: 0,
      activeOrderId: null,
      settled: false,
      claimUrl: null,
    });
  });
});

describe("openCheckoutTab", () => {
  test("opens a navigable tab and clears opener", () => {
    const tab = {
      location: { href: "about:blank" },
      close: () => {},
      opener: { id: "parent" },
    };
    const openCalls: Array<[string | undefined, string | undefined, string | undefined]> = [];
    const result = openCheckoutTab((url, target, features) => {
      openCalls.push([url, target, features]);
      return tab;
    });

    expect(result).toEqual({ checkoutTab: tab, popupBlocked: false });
    expect(tab.opener).toBeNull();
    expect(openCalls).toEqual([["", "_blank", undefined]]);
  });

  test("marks popup as blocked when open returns null", () => {
    const result = openCheckoutTab(() => null);

    expect(result).toEqual({ checkoutTab: null, popupBlocked: true });
  });
});

describe("navigateCheckout", () => {
  test("navigates the pre-opened tab when available", () => {
    const tab = {
      location: { href: "about:blank" },
      close: () => {},
      opener: null,
    };
    const assignCalls: string[] = [];

    const result = navigateCheckout({
      checkoutTab: tab,
      popupBlocked: false,
      url: "https://checkout.stripe.com/session",
      assignCurrentTab: (url) => assignCalls.push(url),
    });

    expect(result).toBe("new-tab");
    expect(tab.location.href).toBe("https://checkout.stripe.com/session");
    expect(assignCalls).toEqual([]);
  });

  test("falls back to same-tab navigation only when popup was blocked", () => {
    const assignCalls: string[] = [];

    const result = navigateCheckout({
      checkoutTab: null,
      popupBlocked: true,
      url: "https://checkout.stripe.com/session",
      assignCurrentTab: (url) => assignCalls.push(url),
    });

    expect(result).toBe("same-tab");
    expect(assignCalls).toEqual(["https://checkout.stripe.com/session"]);
  });

  test("does not same-tab navigate when popup was not blocked", () => {
    const assignCalls: string[] = [];

    const result = navigateCheckout({
      checkoutTab: null,
      popupBlocked: false,
      url: "https://checkout.stripe.com/session",
      assignCurrentTab: (url) => assignCalls.push(url),
    });

    expect(result).toBe("none");
    expect(assignCalls).toEqual([]);
  });
});

describe("runCheckout (issue #22: open the tab inside the click gesture)", () => {
  function deps(order: string[], response: Response | Error) {
    const tab = { location: { href: "" }, close: vi.fn(), opener: {} as unknown };
    return {
      tab,
      deps: {
        open: vi.fn(() => {
          order.push("open");
          return tab;
        }),
        fetch: vi.fn(async () => {
          order.push("fetch");
          if (response instanceof Error) throw response;
          return response;
        }),
        assignCurrentTab: vi.fn(),
      },
    };
  }

  test("opens the tab synchronously, before the /api/checkout request starts", async () => {
    const order: string[] = [];
    const { tab, deps: d } = deps(
      order,
      new Response(
        JSON.stringify({ orderId: "o1", accessToken: "t", url: "https://buy.stripe.com/test_x" }),
      ),
    );
    const pending = runCheckout("singleInsight", undefined, d);
    // Still inside the synchronous part of the click handler: the tab must
    // already be open, and nothing may have been awaited yet.
    expect(d.open).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe("open");
    const result = await pending;
    expect(order).toEqual(["open", "fetch"]);
    expect(result).toEqual({ ok: true, orderId: "o1", accessToken: "t" });
    expect(tab.location.href).toBe("https://buy.stripe.com/test_x");
    expect(tab.opener).toBeNull();
    expect(d.assignCurrentTab).not.toHaveBeenCalled();
  });

  test("closes the pre-opened tab when checkout fails", async () => {
    for (const response of [new Response("{}", { status: 503 }), new Error("network")]) {
      const order: string[] = [];
      const { tab, deps: d } = deps(order, response);
      expect(await runCheckout("singleInsight", undefined, d)).toEqual({ ok: false });
      expect(order).toEqual(["open", "fetch"]);
      expect(tab.close).toHaveBeenCalledTimes(1);
    }
  });
});
