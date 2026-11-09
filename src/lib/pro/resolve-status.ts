/**
 * Pure premium-status resolution used by SubscriptionContext.
 *
 * Order:
 *   1. DEV builds only: an explicit localStorage override
 *      (`di.subscription.isPremium` = "true" | "false", set by PremiumDevToggle)
 *      wins, so QA can preview Pro without Stripe or a session.
 *   2. Flag off (VITE_PRO_UI_ENABLED !== "true") -> false, no network call.
 *   3. Flag on -> GET /api/pro/status; Pro only on 200 with `pro === true`.
 *      Signed out (401), errors and malformed bodies all resolve to false.
 */
export const DEV_OVERRIDE_STORAGE_KEY = "di.subscription.isPremium";
export const PRO_STATUS_PATH = "/api/pro/status";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ResolveDeps = {
  proUiEnabled: boolean;
  devOverrideEnabled: boolean;
  readDevOverride: () => boolean | null;
  fetchImpl?: FetchLike;
};

export function readStorageOverride(storage: Pick<Storage, "getItem"> | undefined): boolean | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(DEV_OVERRIDE_STORAGE_KEY);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return null;
  } catch {
    return null;
  }
}

export async function fetchProStatus(fetchImpl: FetchLike | undefined): Promise<boolean> {
  if (!fetchImpl) return false;
  try {
    const res = await fetchImpl(PRO_STATUS_PATH, {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { pro?: unknown } | null;
    return body?.pro === true;
  } catch {
    return false;
  }
}

export async function resolvePremiumStatus(deps: ResolveDeps): Promise<boolean> {
  if (deps.devOverrideEnabled) {
    const override = deps.readDevOverride();
    if (override !== null) return override;
  }
  if (!deps.proUiEnabled) return false;
  return fetchProStatus(deps.fetchImpl);
}
