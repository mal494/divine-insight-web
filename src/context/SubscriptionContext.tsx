/**
 * SubscriptionContext — client-side premium status for Divine Insight Pro.
 *
 * Real entitlements: when the Pro UI flag is on (VITE_PRO_UI_ENABLED=true at
 * build time, default off — see src/lib/pro/flags.ts) the provider asks
 * GET /api/pro/status, which answers from hasPro() on the server. With the
 * flag off (production today) it never calls the endpoint and Pro stays
 * hidden.
 *
 * DEV builds keep the PremiumDevToggle override (localStorage key
 * `di.subscription.isPremium`) for QA without Stripe or a session.
 *
 * This context only decides what the UI shows. Access to Pro server
 * operations is enforced by requirePro() in the API routes.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { isProUiEnabled } from "~/lib/pro/flags";
import {
  DEV_OVERRIDE_STORAGE_KEY,
  readStorageOverride,
  resolvePremiumStatus,
} from "~/lib/pro/resolve-status";

const DEV_PREMIUM_OVERRIDE_ENABLED = import.meta.env.DEV;

type SubscriptionContextValue = {
  /** Whether the visitor should see Divine Insight Pro UI. */
  isPremium: boolean;
  /** True while the status check is in flight. */
  loading: boolean;
  /** Whether the Pro UI flag is on for this build. */
  proUiEnabled: boolean;
  /** Re-check status (e.g. after sign-in or returning from checkout). */
  refresh: () => Promise<void>;
  /** DEV only: force premium on/off for QA. No-op in production builds. */
  setIsPremium: (value: boolean) => void;
  /** DEV only: flip the premium override. No-op in production builds. */
  togglePremium: () => void;
};

const SubscriptionContext = createContext<SubscriptionContextValue | null>(
  null,
);

function browserStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function writeDevOverride(value: boolean) {
  try {
    browserStorage()?.setItem(DEV_OVERRIDE_STORAGE_KEY, value ? "true" : "false");
  } catch {
    /* private mode — in-memory state still works for the session */
  }
}

export function SubscriptionProvider({ children }: { children: ReactNode }) {
  const [isPremium, setIsPremiumState] = useState(false);
  const [loading, setLoading] = useState(true);
  const proUiEnabled = isProUiEnabled();

  const resolve = useCallback(
    () =>
      resolvePremiumStatus({
        proUiEnabled,
        devOverrideEnabled: DEV_PREMIUM_OVERRIDE_ENABLED,
        readDevOverride: () => readStorageOverride(browserStorage()),
        fetchImpl:
          typeof window === "undefined" ? undefined : window.fetch.bind(window),
      }),
    [proUiEnabled],
  );

  useEffect(() => {
    let cancelled = false;
    resolve().then((active) => {
      if (!cancelled) {
        setIsPremiumState(active);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [resolve]);

  const refresh = useCallback(async () => {
    setLoading(true);
    const active = await resolve();
    setIsPremiumState(active);
    setLoading(false);
  }, [resolve]);

  const setIsPremium = useCallback((value: boolean) => {
    if (!DEV_PREMIUM_OVERRIDE_ENABLED) return;
    setIsPremiumState(value);
    writeDevOverride(value);
  }, []);

  const togglePremium = useCallback(() => {
    if (!DEV_PREMIUM_OVERRIDE_ENABLED) return;
    setIsPremiumState((prev) => {
      const next = !prev;
      writeDevOverride(next);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({
      isPremium,
      loading,
      proUiEnabled,
      refresh,
      setIsPremium,
      togglePremium,
    }),
    [isPremium, loading, proUiEnabled, refresh, setIsPremium, togglePremium],
  );

  return (
    <SubscriptionContext.Provider value={value}>
      {children}
    </SubscriptionContext.Provider>
  );
}

export function useSubscription(): SubscriptionContextValue {
  const ctx = useContext(SubscriptionContext);
  if (!ctx) {
    throw new Error(
      "useSubscription must be used within a SubscriptionProvider",
    );
  }
  return ctx;
}
