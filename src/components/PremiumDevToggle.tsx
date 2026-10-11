/**
 * Floating QA control to flip mocked Pro status without Stripe.
 * Renders only in Vite dev (`import.meta.env.DEV`).
 */
import { useSubscription } from "~/context/SubscriptionContext";

export function PremiumDevToggle() {
  const { isPremium, loading, togglePremium } = useSubscription();

  if (!import.meta.env.DEV) return null;

  return (
    <button
      type="button"
      onClick={togglePremium}
      disabled={loading}
      title="Toggle mocked Divine Insight Pro status"
      className="fixed right-4 bottom-4 z-50 cursor-pointer border border-gold-500/40 bg-night-900/90 px-3 py-2 text-[10px] tracking-[0.18em] text-gold-200 uppercase shadow-lg backdrop-blur-sm transition hover:border-gold-400/70 hover:bg-night-800/95 disabled:opacity-50"
    >
      Pro: {loading ? "…" : isPremium ? "On" : "Off"}
    </button>
  );
}
