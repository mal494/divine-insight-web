import { describe, expect, test } from "vitest";
import { SKUS, isSku } from "~/lib/orders";

describe("isSku", () => {
  test("accepts exactly the four own SKU keys", () => {
    for (const sku of Object.keys(SKUS)) expect(isSku(sku)).toBe(true);
  });

  test.each([
    "toString",
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "valueOf",
    "isPrototypeOf",
    "proMonthly",
    "",
    "SingleInsight",
  ])("rejects %j", (value) => {
    expect(isSku(value)).toBe(false);
  });

  test("rejects non-strings", () => {
    for (const value of [undefined, null, 1, {}, ["singleInsight"]]) {
      expect(isSku(value)).toBe(false);
    }
  });
});
