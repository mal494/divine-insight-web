/**
 * GET /api/pro/status logic, kept out of the route file so it is unit-testable.
 *
 *   signed out -> 401 { signedIn: false, pro: false }
 *   signed in  -> 200 { signedIn: true, pro: <hasPro(user.id)> }
 *   lookup error -> 503 { error: "entitlement_unavailable", pro: false }
 *
 * This reports the truth from the entitlements table. Whether the Pro UI is
 * shown at all is a separate client build flag (VITE_PRO_UI_ENABLED, see
 * src/lib/pro/flags.ts), which defaults to off.
 */
import { hasPro } from "~/lib/auth/entitlements";
import { guardJson, type ProGuardDeps } from "~/lib/auth/require-pro";
import { userFromRequest } from "~/lib/billing/session-user";

export type ProStatusBody = { signedIn: boolean; pro: boolean };

const defaultDeps: ProGuardDeps = {
  getUser: userFromRequest,
  checkPro: (userId) => hasPro(userId),
};

export async function handleProStatus(
  request: Request,
  deps: ProGuardDeps = defaultDeps,
): Promise<Response> {
  const user = await deps.getUser(request);
  if (!user) return guardJson({ signedIn: false, pro: false } satisfies ProStatusBody, 401);
  try {
    const pro = await deps.checkPro(user.id);
    return guardJson({ signedIn: true, pro } satisfies ProStatusBody, 200);
  } catch (err) {
    console.error("pro status lookup failed", err);
    return guardJson({ error: "entitlement_unavailable", pro: false }, 503);
  }
}
