/**
 * SubscriptionContext — client-side premium status for Divine Insight Pro.
 *
 * Pro is hidden in production, so premium status is only overridable in local
 * dev builds (via PremiumDevToggle). In production this context always settles
 * to `isPremium=false`, regardless of localStorage contents.
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

const STORAGE_KEY = "di.subscription.isPremium";
const DEV_PREMIUM_TOGGLE_ENABLED = import.meta.env.DEV;

type SubscriptionContextValue = {
  /** Whether the visitor has an active Divine Insight Pro subscription. */
  isPremium: boolean;
  /** True while the (mocked) verification is in flight. */
  loading: boolean;
  /** Override premium for testing / after a successful checkout return. */
  setIsPremium: (value: boolean) => void;
  /** Flip premium on/off — handy for QA without a Stripe round-trip. */
  togglePremium: () => void;
};

const SubscriptionContext = createContext<SubscriptionContextValue | null>(
  null,
);

/**
 * Mock backend verification. Swap this for a real entitlement fetch later
 * (e.g. GET /api/subscription → { active: boolean }).
 */
async function verifyPremiumStatus(): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, 120));
  if (!DEV_PREMIUM_TOGGLE_ENABLED || typeof window === "undefined")
    return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function SubscriptionProvider({ children }: { children: ReactNode }) {
  const [isPremium, setIsPremiumState] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    verifyPremiumStatus().then((active) => {
      if (!cancelled) {
        setIsPremiumState(active);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setIsPremium = useCallback((value: boolean) => {
    if (!DEV_PREMIUM_TOGGLE_ENABLED) {
      setIsPremiumState(false);
      return;
    }
    setIsPremiumState(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, value ? "true" : "false");
    } catch {
      /* private mode — in-memory state still works for the session */
    }
  }, []);

  const togglePremium = useCallback(() => {
    if (!DEV_PREMIUM_TOGGLE_ENABLED) return;
    setIsPremiumState((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "true" : "false");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ isPremium, loading, setIsPremium, togglePremium }),
    [isPremium, loading, setIsPremium, togglePremium],
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
