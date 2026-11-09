/**
 * payments.ts — the single source of truth for Divine Insight's paid readings.
 *
 * The paid lineup is a four-SKU ladder:
 *   - Single Insight ($2.99)      — one question, one card, a line to carry (entry rung)
 *   - Extended Reading ($9.99)    — the signature five-card reading
 *   - Reading Bundle ($19.99)     — three Extended Readings, $6.66 each (per-unit value)
 *   - Gift Reading ($5.00)        — a single card, read and sent with your name
 *
 * Fulfilment is verified server-side. The browser never opens one of these
 * links directly: it POSTs a SKU key to /api/checkout, which records a pending
 * order and appends that order's id to the link as `client_reference_id`.
 * Stripe's webhook then marks the order paid, and the draw unlocks off the
 * order — not off a click. See PAYMENTS.md, and `useEntitlement` in
 * ~/lib/entitlement for the client half.
 *
 * Prices here are display copy. The amounts the server actually trusts live in
 * `SKUS` in ~/lib/orders and are checked against what Stripe charged; keep the
 * two in step if a price ever moves.
 *
 * Which Stripe link each SKU opens is environment-specific and resolved on the
 * server only — see ~/lib/payment-links (env vars STRIPE_PAYMENT_LINK_*).
 * Preview and development builds never fall back to a live-mode link.
 */

/** The four paid SKUs, keyed exactly as the server's price table keys them. */
export type Sku =
  "singleInsight" | "extendedReading" | "readingBundle" | "giftReading";

/**
 * Optional tips (donation path) — fixed USD amounts. These stay honor-based on
 * purpose: a tip unlocks nothing, so there is no entitlement to verify. The
 * button opens Stripe in a new tab and the copy frames the tip as a gift,
 * never a purchase and never "pay or the site dies" pressure.
 *
 * These are the LIVE-mode tip links. They are used only by production builds
 * (see `resolveTipLinks`); preview/dev builds need test-mode links in the
 * VITE_STRIPE_TIP_LINK_* env vars or the tip rail is hidden.
 */
export const LIVE_TIP_LINKS = {
  /** Leave a Tip — USD 3.00. */
  tip3: "https://buy.stripe.com/aFadR93ejcxg2JF3S9es006",
  /** Leave a Tip — USD 5.00. */
  tip5: "https://buy.stripe.com/bJe7sLeX11SC0BxewNes004",
  /** Leave a Tip — USD 10.00. */
  tip10: "https://buy.stripe.com/00w9ATdSXfJsckf9ctes005",
} as const;

export type TipKey = keyof typeof LIVE_TIP_LINKS;

/** Build-time env var names for per-environment tip links. */
export const TIP_LINK_ENV: Record<TipKey, string> = {
  tip3: "VITE_STRIPE_TIP_LINK_3",
  tip5: "VITE_STRIPE_TIP_LINK_5",
  tip10: "VITE_STRIPE_TIP_LINK_10",
};

/** A Stripe-hosted Payment Link (buy.stripe.com). */
export function isStripePaymentLink(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "buy.stripe.com" &&
      url.pathname.length > 1
    );
  } catch {
    return false;
  }
}

/** Test-mode Payment Links live under https://buy.stripe.com/test_… */
export function isTestModePaymentLink(value: string): boolean {
  return (
    isStripePaymentLink(value) && new URL(value).pathname.startsWith("/test_")
  );
}

/**
 * Tip links for this build. Production keeps the live links unless an env
 * override (also live) is set. Every other environment only ever gets
 * test-mode links from env; if any is missing or live-mode, it returns null
 * and the tip rail hides itself rather than open a real charge.
 */
export function resolveTipLinks(
  deployEnv: string | undefined,
  env: Record<string, string | undefined>,
): Record<TipKey, string> | null {
  const production = deployEnv === "production";
  const out = {} as Record<TipKey, string>;
  for (const key of Object.keys(LIVE_TIP_LINKS) as TipKey[]) {
    const raw = env[TIP_LINK_ENV[key]]?.trim();
    if (production) {
      if (!raw) {
        out[key] = LIVE_TIP_LINKS[key];
      } else if (isStripePaymentLink(raw) && !isTestModePaymentLink(raw)) {
        out[key] = raw;
      } else {
        return null;
      }
    } else {
      if (!raw || !isTestModePaymentLink(raw)) return null;
      out[key] = raw;
    }
  }
  return out;
}

/** Display prices (USD) for the unlock CTAs. */
export const SINGLE_INSIGHT_PRICE = 2.99;
export const EXTENDED_READING_PRICE = 9.99;
export const READING_BUNDLE_PRICE = 19.99;
export const GIFT_READING_PRICE = 5.0;

/** Display prices (USD) for the tip rail. */
export const TIP_3_PRICE = 3.0;
export const TIP_5_PRICE = 5.0;
export const TIP_10_PRICE = 10.0;

/** "9.99" / "5.00" — for on-page price display. */
export function formatPrice(price: number): string {
  return price.toFixed(2);
}
