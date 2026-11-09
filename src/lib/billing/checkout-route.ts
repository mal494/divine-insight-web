/**
 * POST /api/pro/checkout logic (testable). Signed-in only.
 *
 * Refuses to start a second subscription: if the user already has Pro
 * (active / trialing / past_due within the period, per hasPro) it returns
 * 409 { error: "already_subscribed", manage: "/api/pro/portal" } instead of
 * creating another Stripe Checkout Session, so a Pro user can't be double
 * billed from the site.
 */
import { hasPro } from "~/lib/auth/entitlements";
import { getAuthPool } from "~/lib/auth/db";
import { createProCheckoutSession, type Queryable } from "./pro";
import { json, originOf, userFromRequest } from "./session-user";

export type CheckoutDeps = {
  getUser: (request: Request) => Promise<{ id: string; email: string } | null>;
  checkPro: (userId: string) => Promise<boolean>;
  createSession: (args: { userId: string; email: string; origin: string; db: Queryable }) => Promise<string>;
  db: () => Queryable;
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
