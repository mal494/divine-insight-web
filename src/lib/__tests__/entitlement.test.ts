import { describe, expect, test } from "vitest";
import { resolveEntitlementFromOrders } from "../entitlement";

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
    });
  });

  test("reports spent when only paid orders with zero credits remain", () => {
    const result = resolveEntitlementFromOrders([{ id: "spent", status: "paid", credits: 0 }]);

    expect(result).toEqual({
      status: "spent",
      credits: 0,
      activeOrderId: "spent",
      settled: true,
    });
  });

  test("reports awaiting-payment when at least one tracked order is still pending", () => {
    const result = resolveEntitlementFromOrders([{ id: "pending", status: "pending", credits: 1 }]);

    expect(result).toEqual({
      status: "awaiting-payment",
      credits: 0,
      activeOrderId: null,
      settled: false,
    });
  });

  test("treats non-pending non-paid statuses as locked", () => {
    const result = resolveEntitlementFromOrders([{ id: "voided", status: "void", credits: 1 }]);

    expect(result).toEqual({
      status: "locked",
      credits: 0,
      activeOrderId: null,
      settled: false,
    });
  });
});
