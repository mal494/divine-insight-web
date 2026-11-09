/**
 * POST /api/pro/checkout logic (testable). Signed-in only.
 *
 * Refuses to start a second subscription: if the user already has Pro
 * (active / trialing / past_due within the period, per hasPro) it returns
 * 409 { error: "already_subscribed", manage: "/api/pro/portal" } instead of
 * creating another Stripe Checkout Session, so a Pro user can't be double
 * billed from the site.
 *
 * Kill switch: PRO_CHECKOUT_ENABLED (server env, default OFF; only the exact
 * string "true" enables it). While off, a signed-in request gets 503
 * { error: "checkout_paused" } right after the 401 check, before ANY DB read
 * or Stripe call. Even when on, the route refuses with 503
 * "checkout_unavailable" (again before any DB/Stripe work) unless
 * STRIPE_SECRET_KEY, STRIPE_PRO_PRICE_ID and STRIPE_PRO_WEBHOOK_SECRET are all
 * set: never create a Stripe customer, or sell what the webhook can't grant.
 */
import { hasPro } from "~/lib/auth/entitlements";
import { getAuthPool } from "~/lib/auth/db";
import { createProCheckoutSession, type Queryable } from "./pro";
import { json, originOf, userFromRequest } from "./session-user";

export type ProCheckoutEnv = Record<string, string | undefined>;

/** Server kill switch for Pro checkout. Default off; only "true" enables it. */
export function proCheckoutEnabled(env: ProCheckoutEnv = process.env): boolean {
  return env.PRO_CHECKOUT_ENABLED === "true";
}

export const PRO_CHECKOUT_REQUIRED_ENV = [
  "STRIPE_SECRET_KEY",
  "STRIPE_PRO_PRICE_ID",
  "STRIPE_PRO_WEBHOOK_SECRET",
] as const;

/** Names (never values) of the Pro Stripe settings that are missing or blank. */
export function missingProCheckoutEnv(env: ProCheckoutEnv = process.env): string[] {
  return PRO_CHECKOUT_REQUIRED_ENV.filter((name) => !env[name]?.trim());
}

export type CheckoutDeps = {
  getUser: (request: Request) => Promise<{ id: string; email: string } | null>;
  checkPro: (userId: string) => Promise<boolean>;
  createSession: (args: { userId: string; email: string; origin: string; db: Queryable }) => Promise<string>;
  db: () => Queryable;
  /** Server env (defaults to process.env); injectable for tests. */
  env?: ProCheckoutEnv;
};

const defaultDeps: CheckoutDeps = {
  getUser: userFromRequest,
  checkPro: (userId) => hasPro(userId),
  createSession: (args) => createProCheckoutSession(args),
  db: getAuthPool,
};

export async function handleProCheckout(request: Request, deps: CheckoutDeps = defaultDeps): Promise<Response> {
  let user: { id: string; email: string } | null;
  try {
    user = await deps.getUser(request);
  } catch (err) {
    console.error("session lookup failed", err);
    return json({ error: "session_unavailable" }, 503);
  }
  if (!user) return json({ error: "sign_in_required" }, 401);

  // Paused unless PRO_CHECKOUT_ENABLED=true. Before any DB read or Stripe call.
  const env = deps.env ?? process.env;
  if (!proCheckoutEnabled(env)) return json({ error: "checkout_paused" }, 503);
  const missing = missingProCheckoutEnv(env);
  if (missing.length > 0) {
    console.error(`pro checkout misconfigured: missing ${missing.join(", ")}`);
    return json({ error: "checkout_unavailable" }, 503);
  }

  try {
    if (await deps.checkPro(user.id)) {
      return json({ error: "already_subscribed", manage: "/api/pro/portal" }, 409);
    }
    const url = await deps.createSession({ userId: user.id, email: user.email, origin: originOf(request), db: deps.db() });
    return json({ url });
  } catch (err) {
    console.error("pro checkout failed", err);
    return json({ error: "checkout_unavailable" }, 503);
  }
}
