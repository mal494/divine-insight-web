/**
 * Kill switch for paid checkout (readings, bundle, gift). Tips are separate
 * and unaffected.
 *
 * Paid purchases are fulfilled only by the Stripe webhook. Until production
 * has a live webhook endpoint + secret (and the gift email config), a buyer
 * would pay and receive nothing, so paid checkout is OFF unless explicitly
 * enabled:
 *
 *   - Browser (buttons): VITE_PAID_CHECKOUT_ENABLED=true at BUILD time
 *     (Vite inlines it; changing it needs a rebuild/redeploy).
 *   - Server (/api/checkout): PAID_CHECKOUT_ENABLED=true at runtime.
 *
 * Any other value, or unset, means paused. Set both to re-enable.
 */
export function paidCheckoutEnabled(): boolean {
  return import.meta.env.VITE_PAID_CHECKOUT_ENABLED === "true";
}

export function serverPaidCheckoutEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.PAID_CHECKOUT_ENABLED === "true";
}

export const PURCHASES_PAUSED_COPY = "Purchases are paused, back soon.";
