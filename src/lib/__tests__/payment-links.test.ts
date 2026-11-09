import { describe, expect, test } from "vitest";
import {
  LIVE_PAYMENT_LINK_DEFAULTS,
  PAYMENT_LINK_ENV,
  PaymentLinkConfigError,
  resolvePaymentLink,
} from "~/lib/payment-links";
import {
  LIVE_TIP_LINKS,
  isTestModePaymentLink,
  resolveTipLinks,
} from "~/lib/payments";
import { SKUS, type Sku } from "~/lib/orders";

const SKU_KEYS = Object.keys(SKUS) as Sku[];
const TEST_LINK = "https://buy.stripe.com/test_abc123";
const LIVE_LINK = "https://buy.stripe.com/abc123";

describe("resolvePaymentLink", () => {
  test("every SKU has an env var name and a live default", () => {
    expect(Object.keys(PAYMENT_LINK_ENV).sort()).toEqual([...SKU_KEYS].sort());
    for (const sku of SKU_KEYS) {
      expect(PAYMENT_LINK_ENV[sku]).toMatch(/^STRIPE_PAYMENT_LINK_[A-Z_]+$/);
      expect(isTestModePaymentLink(LIVE_PAYMENT_LINK_DEFAULTS[sku])).toBe(
        false,
      );
    }
  });

  test("production with no env keeps today's live links", () => {
    for (const sku of SKU_KEYS) {
      expect(resolvePaymentLink(sku, { VERCEL_ENV: "production" })).toBe(
        LIVE_PAYMENT_LINK_DEFAULTS[sku],
      );
    }
  });

  test("production honours a live-mode env override", () => {
    const env = {
      VERCEL_ENV: "production",
      [PAYMENT_LINK_ENV.singleInsight]: LIVE_LINK,
    };
    expect(resolvePaymentLink("singleInsight", env)).toBe(LIVE_LINK);
  });

  test("PAYMENT_LINKS_MODE=live is refused unless VERCEL_ENV=production", () => {
    for (const vercelEnv of ["preview", "development", undefined]) {
      for (const sku of SKU_KEYS) {
        const env = {
          ...(vercelEnv ? { VERCEL_ENV: vercelEnv } : {}),
          PAYMENT_LINKS_MODE: "live",
          // even with a valid test link configured, the override is refused
          [PAYMENT_LINK_ENV[sku]]: TEST_LINK,
        };
        expect(() => resolvePaymentLink(sku, env)).toThrow(
          /PAYMENT_LINKS_MODE=live is refused/,
        );
      }
    }
    // In production it changes nothing: live links as before.
    expect(
      resolvePaymentLink("singleInsight", {
        VERCEL_ENV: "production",
        PAYMENT_LINKS_MODE: "live",
      }),
    ).toBe(LIVE_PAYMENT_LINK_DEFAULTS.singleInsight);
  });

  test("production refuses a test-mode or non-Stripe link", () => {
    for (const bad of [TEST_LINK, "https://evil.example/pay", "not a url"]) {
      const env = {
        VERCEL_ENV: "production",
        [PAYMENT_LINK_ENV.giftReading]: bad,
      };
      expect(() => resolvePaymentLink("giftReading", env)).toThrow(
        PaymentLinkConfigError,
      );
    }
  });

  test.each([["preview"], ["development"], [undefined]])(
    "VERCEL_ENV=%s never falls back to a live link",
    (vercelEnv) => {
      for (const sku of SKU_KEYS) {
        const env = vercelEnv ? { VERCEL_ENV: vercelEnv } : {};
        expect(() => resolvePaymentLink(sku, env)).toThrow(/is not set/);
        expect(() =>
          resolvePaymentLink(sku, {
            ...env,
            [PAYMENT_LINK_ENV[sku]]: LIVE_LINK,
          }),
        ).toThrow(/TEST-mode/);
        expect(() =>
          resolvePaymentLink(sku, {
            ...env,
            [PAYMENT_LINK_ENV[sku]]: LIVE_PAYMENT_LINK_DEFAULTS[sku],
          }),
        ).toThrow(PaymentLinkConfigError);
        expect(
          resolvePaymentLink(sku, {
            ...env,
            [PAYMENT_LINK_ENV[sku]]: ` ${TEST_LINK} `,
          }),
        ).toBe(TEST_LINK);
      }
    },
  );

  test("a lookalike host with a test_ path is not a test link", () => {
    const env = {
      VERCEL_ENV: "preview",
      [PAYMENT_LINK_ENV.singleInsight]:
        "https://buy.stripe.com.evil.example/test_x",
    };
    expect(() => resolvePaymentLink("singleInsight", env)).toThrow(
      PaymentLinkConfigError,
    );
    const http = {
      VERCEL_ENV: "preview",
      [PAYMENT_LINK_ENV.singleInsight]: "http://buy.stripe.com/test_x",
    };
    expect(() => resolvePaymentLink("singleInsight", http)).toThrow(
      PaymentLinkConfigError,
    );
  });
});

describe("resolveTipLinks", () => {
  // Stand-in for the production-only live map (absent from non-prod builds).
  const LIVE = {
    tip3: "https://buy.stripe.com/live3",
    tip5: "https://buy.stripe.com/live5",
    tip10: "https://buy.stripe.com/live10",
  };
  const testEnv = {
    VITE_STRIPE_TIP_LINK_3: "https://buy.stripe.com/test_t3",
    VITE_STRIPE_TIP_LINK_5: "https://buy.stripe.com/test_t5",
    VITE_STRIPE_TIP_LINK_10: "https://buy.stripe.com/test_t10",
  };

  test("a non-production build carries no live tip links at all", () => {
    expect(LIVE_TIP_LINKS).toBeNull();
    expect(resolveTipLinks("production", {})).toBeNull();
  });

  test("production keeps the live tip links by default", () => {
    expect(resolveTipLinks("production", {}, LIVE)).toEqual(LIVE);
  });

  test("production refuses test-mode tip links (hides the rail)", () => {
    expect(resolveTipLinks("production", testEnv, LIVE)).toBeNull();
  });

  test.each([["preview"], ["development"], [""], [undefined]])(
    "%s build hides tips without test links and never returns live ones",
    (deployEnv) => {
      expect(resolveTipLinks(deployEnv, {}, LIVE)).toBeNull();
      expect(
        resolveTipLinks(
          deployEnv,
          { ...testEnv, VITE_STRIPE_TIP_LINK_5: LIVE.tip5 },
          LIVE,
        ),
      ).toBeNull();
      expect(resolveTipLinks(deployEnv, testEnv, LIVE)).toEqual({
        tip3: testEnv.VITE_STRIPE_TIP_LINK_3,
        tip5: testEnv.VITE_STRIPE_TIP_LINK_5,
        tip10: testEnv.VITE_STRIPE_TIP_LINK_10,
      });
    },
  );
});
