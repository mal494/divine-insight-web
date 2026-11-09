/**
 * payment-links.ts — server-only: which Stripe Payment Link each paid SKU opens.
 *
 * Before this module the four links were hardcoded LIVE-mode URLs shipped to
 * every environment, so a Vercel Preview sent testers to real checkout. Now:
 *
 *   - Production (VERCEL_ENV=production): STRIPE_PAYMENT_LINK_<SKU> if set,
 *     which must be a live-mode https://buy.stripe.com/… link; otherwise the
 *     current live link below (so production keeps working with no config).
 *   - Everything else (preview, development, local, tests): the env var MUST be
 *     set to a TEST-mode link (https://buy.stripe.com/test_…). Unset or
 *     live-mode is a configuration error and checkout answers 503 — it never
 *     falls back to a live link.
 *
 * Env vars (one per SKU):
 *   STRIPE_PAYMENT_LINK_SINGLE_INSIGHT    $2.99  USD, 1 credit
 *   STRIPE_PAYMENT_LINK_EXTENDED_READING  $9.99  USD, 1 credit
 *   STRIPE_PAYMENT_LINK_READING_BUNDLE    $19.99 USD, 3 credits
 *   STRIPE_PAYMENT_LINK_GIFT_READING      $5.00  USD, 1 credit
 * Each link's price must equal SKUS in ~/lib/orders or the webhook refuses to
 * fulfil (amount-mismatch).
 */
import {
  isStripePaymentLink,
  isTestModePaymentLink,
  type Sku,
} from "~/lib/payments";

export const PAYMENT_LINK_ENV: Record<Sku, string> = {
  singleInsight: "STRIPE_PAYMENT_LINK_SINGLE_INSIGHT",
  extendedReading: "STRIPE_PAYMENT_LINK_EXTENDED_READING",
  readingBundle: "STRIPE_PAYMENT_LINK_READING_BUNDLE",
  giftReading: "STRIPE_PAYMENT_LINK_GIFT_READING",
};

/** The live-mode links production used before env configuration existed. */
export const LIVE_PAYMENT_LINK_DEFAULTS: Record<Sku, string> = {
  singleInsight: "https://buy.stripe.com/aFa5kD8yD0Oyfwr9ctes002",
  extendedReading: "https://buy.stripe.com/eVq14neX1ap8ac7bkBes000",
  readingBundle: "https://buy.stripe.com/5kQ00j6qvap85VRagxes003",
  giftReading: "https://buy.stripe.com/eVqeVdcOTap80Bx60hes001",
};

export class PaymentLinkConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentLinkConfigError";
  }
}

type Env = Record<string, string | undefined>;

export function isProductionDeploy(env: Env = process.env): boolean {
  return env.VERCEL_ENV === "production";
}

/** Resolve the Stripe link for a SKU, or throw PaymentLinkConfigError. */
export function resolvePaymentLink(sku: Sku, env: Env = process.env): string {
  const name = PAYMENT_LINK_ENV[sku];
  const raw = env[name]?.trim();

  if (isProductionDeploy(env)) {
    if (!raw) return LIVE_PAYMENT_LINK_DEFAULTS[sku];
    if (!isStripePaymentLink(raw)) {
      throw new PaymentLinkConfigError(
        `${name} is not a https://buy.stripe.com/ link`,
      );
    }
    if (isTestModePaymentLink(raw)) {
      throw new PaymentLinkConfigError(
        `${name} is a TEST-mode link but VERCEL_ENV=production; production needs a live link`,
      );
    }
    return raw;
  }

  const where = env.VERCEL_ENV ?? "development";
  if (!raw) {
    throw new PaymentLinkConfigError(
      `${name} is not set. ${where} never uses live Stripe links; set it to a TEST-mode Payment Link (https://buy.stripe.com/test_…)`,
    );
  }
  if (!isTestModePaymentLink(raw)) {
    throw new PaymentLinkConfigError(
      `${name} must be a TEST-mode Payment Link (https://buy.stripe.com/test_…) outside production (VERCEL_ENV=${where})`,
    );
  }
  return raw;
}
