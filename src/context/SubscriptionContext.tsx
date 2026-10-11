/**
 * SubscriptionContext — client-side premium status for Divine Insight Pro.
 *
 * Backend verification is mocked for now: `isPremium` can be toggled for local
 * testing. When a real subscription check lands, replace `verifyPremiumStatus`
 * with a server call and keep this context as the single source of truth for UI.
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
  if (typeof window === "undefined") return false;
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
    setIsPremiumState(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, value ? "true" : "false");
    } catch {
      /* private mode — in-memory state still works for the session */
    }
  }, []);

  const togglePremium = useCallback(() => {
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
