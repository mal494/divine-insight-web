/**
 * stripe-checkout.ts — Divine Insight Pro Checkout scaffold.
 *
 * Loads Stripe.js with a placeholder publishable key and points at a
 * placeholder Price ID for the $5/month Pro subscription. Wire this to a
 * server-created Checkout Session before going live — never create Sessions
 * with the publishable key alone.
 */
import { loadStripe, type Stripe } from "@stripe/stripe-js";

/** Replace with your Stripe publishable key (pk_test_… / pk_live_…). */
export const STRIPE_PUBLISHABLE_KEY =
  "pk_test_placeholder_divine_insight_pro";

/** Replace with the Stripe Price ID for Divine Insight Pro ($5/month). */
export const PRO_PRICE_ID = "price_placeholder_divine_insight_pro_monthly";

let stripePromise: Promise<Stripe | null> | null = null;

export function getStripe(): Promise<Stripe | null> {
  if (!stripePromise) {
    stripePromise = loadStripe(STRIPE_PUBLISHABLE_KEY);
  }
  return stripePromise;
}

/**
 * Begin the Pro subscription checkout redirect.
 *
 * Scaffold only: once `/api/checkout` (or a dedicated Pro endpoint) returns a
 * Checkout Session id, call `stripe.redirectToCheckout({ sessionId })`.
 */
export async function redirectToProCheckout(): Promise<void> {
  const stripe = await getStripe();
  if (!stripe) {
    throw new Error("Stripe.js failed to load");
  }

  // Placeholder — real flow:
  //   const { sessionId } = await fetch('/api/checkout', {
  //     method: 'POST',
  //     body: JSON.stringify({ sku: 'divineInsightPro', priceId: PRO_PRICE_ID }),
  //   }).then((r) => r.json());
  //   await stripe.redirectToCheckout({ sessionId });
  console.info(
    "[Divine Insight Pro] Checkout scaffold ready",
    { publishableKey: STRIPE_PUBLISHABLE_KEY, priceId: PRO_PRICE_ID },
  );

  if (typeof window !== "undefined") {
    window.alert(
      "Stripe Checkout is scaffolded.\n\n" +
        `Price: ${PRO_PRICE_ID}\n` +
        "Connect a Checkout Session endpoint to complete the redirect.",
    );
  }
}
