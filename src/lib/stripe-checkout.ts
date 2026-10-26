/**
 * stripe-checkout.ts — client helpers for the Divine Insight Pro subscription.
 *
 * The server creates the Checkout / Portal sessions (POST /api/pro/checkout,
 * POST /api/pro/portal) using STRIPE_SECRET_KEY and STRIPE_PRO_PRICE_ID; the
 * browser only follows the returned URL. Pro is granted solely by the
 * subscription webhook, never by the redirect.
 */
async function go(path: string): Promise<void> {
  const res = await fetch(path, { method: "POST" });
  const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (res.status === 401 && typeof window !== "undefined") {
    window.location.href = "/signin";
    return;
  }
  if (!res.ok || !body.url) throw new Error(body.error ?? `request failed (${res.status})`);
  if (typeof window !== "undefined") window.location.href = body.url;
}

export function redirectToProCheckout(): Promise<void> {
  return go("/api/pro/checkout");
}

export function redirectToBillingPortal(): Promise<void> {
  return go("/api/pro/portal");
}
