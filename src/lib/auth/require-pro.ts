/**
 * Server-side Pro enforcement for API routes.
 *
 * Every Pro-only server operation must call `requirePro(request)` (or wrap its
 * handler in `withPro`) before doing any work:
 *
 *   - no session          -> 401 { error: "sign_in_required" }
 *   - signed in, not Pro  -> 403 { error: "pro_required" }
 *   - entitlement lookup fails -> 503 { error: "entitlement_unavailable" }
 *     (fail closed: a DB outage never grants Pro)
 *
 * The client-side SubscriptionContext / PremiumGate only decide what to *show*;
 * this guard is what actually decides access.
 *
 * Do NOT use this on the free three-card spread or on paid one-time readings
 * (/api/reading, /api/order/*, /api/checkout, /api/claim/*). Those are
 * entitled by orders, not by the subscription.
 */
import { hasPro } from "./entitlements";
import { userFromRequest } from "~/lib/billing/session-user";

export type ProUser = { id: string; email: string };

export type ProGuardDeps = {
  getUser: (request: Request) => Promise<ProUser | null>;
  checkPro: (userId: string) => Promise<boolean>;
};

export type ProGuardResult =
  | { ok: true; user: ProUser }
  | { ok: false; response: Response };

const defaultDeps: ProGuardDeps = {
  getUser: userFromRequest,
  checkPro: (userId) => hasPro(userId),
};

export function guardJson(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function requirePro(
  request: Request,
  deps: ProGuardDeps = defaultDeps,
): Promise<ProGuardResult> {
  const user = await deps.getUser(request);
  if (!user) return { ok: false, response: guardJson({ error: "sign_in_required" }, 401) };

  let pro: boolean;
  try {
    pro = await deps.checkPro(user.id);
  } catch (err) {
    console.error("pro entitlement check failed", err);
    return { ok: false, response: guardJson({ error: "entitlement_unavailable" }, 503) };
  }
  if (!pro) return { ok: false, response: guardJson({ error: "pro_required" }, 403) };
  return { ok: true, user };
}

/** Wrap a route handler so it only runs for signed-in Pro users. */
export function withPro<Ctx extends { request: Request }>(
  handler: (ctx: Ctx & { user: ProUser }) => Promise<Response> | Response,
  deps: ProGuardDeps = defaultDeps,
): (ctx: Ctx) => Promise<Response> {
  return async (ctx) => {
    const guard = await requirePro(ctx.request, deps);
    if (!guard.ok) return guard.response;
    return handler({ ...ctx, user: guard.user });
  };
}
