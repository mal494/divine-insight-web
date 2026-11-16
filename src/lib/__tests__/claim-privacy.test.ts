import { describe, expect, test } from "vitest";
import { shouldLoadAnalytics } from "~/components/analytics";
import { claimPrivacyHeaders, isClaimPath, redactClaimPath } from "~/lib/claim-privacy";
import { Route as ClaimPageRoute } from "~/routes/claim.$token";

const TOKEN = "a".repeat(32);

describe("claim URL privacy", () => {
  test("claim page and API get Referrer-Policy: no-referrer; other paths do not", () => {
    expect(claimPrivacyHeaders(`/claim/${TOKEN}`)).toEqual({ "Referrer-Policy": "no-referrer" });
    expect(claimPrivacyHeaders(`/api/claim/${TOKEN}`)).toEqual({ "Referrer-Policy": "no-referrer" });
    expect(claimPrivacyHeaders("/")).toEqual({});
    expect(claimPrivacyHeaders("/claimed-offer")).toEqual({});
    expect(isClaimPath("/api/order/x")).toBe(false);
  });

  test("the claim page also sets a no-referrer meta tag", () => {
    const head = (ClaimPageRoute.options as unknown as { head: () => { meta: unknown[] } }).head();
    expect(head.meta).toContainEqual({ name: "referrer", content: "no-referrer" });
  });

  test("analytics never loads on a claim page", () => {
    expect(shouldLoadAnalytics(`/claim/${TOKEN}`, true)).toBe(false);
    expect(shouldLoadAnalytics("/", true)).toBe(true);
    expect(shouldLoadAnalytics("/", false)).toBe(false);
  });

  test("redactClaimPath hides the token in log lines", () => {
    expect(redactClaimPath(`/claim/${TOKEN}`)).toBe("/claim/[redacted]");
    expect(redactClaimPath(`/api/claim/${TOKEN}`)).toBe("/api/claim/[redacted]");
    expect(redactClaimPath("/api/order/1")).toBe("/api/order/1");
  });
});
