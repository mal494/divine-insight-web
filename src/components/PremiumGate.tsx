/**
 * PremiumGate — freemium wrapper for Pro-only surfaces.
 *
 * Premium members see children as usual. Free visitors still see the content
 * beneath a heavy blur (so the product feels tangible) with pointer-events
 * disabled, and an upgrade modal pitched at Divine Insight Pro ($5/month).
 */
import { AnimatePresence, motion } from "framer-motion";
import { useState, type ReactNode } from "react";
import { useSubscription } from "~/context/SubscriptionContext";
import { redirectToProCheckout } from "~/lib/stripe-checkout";

type PremiumGateProps = {
  children: ReactNode;
  /** Optional override for the modal pitch line. */
  pitch?: string;
};

const DEFAULT_PITCH =
  "Divine Insight Pro: Unlock the Celtic Cross, Advanced 1-to-5 Vector Scoring, and Journal tracking for $5/month.";

export function PremiumGate({
  children,
  pitch = DEFAULT_PITCH,
}: PremiumGateProps) {
  const { isPremium, loading } = useSubscription();
  const [busy, setBusy] = useState(false);

  if (loading) {
    return (
      <div className="relative min-h-[12rem]" aria-busy="true">
        <div className="pointer-events-none select-none opacity-40 blur-md">
          {children}
        </div>
      </div>
    );
  }

  if (isPremium) {
    return <>{children}</>;
  }

  async function handleUpgrade() {
    setBusy(true);
    try {
      await redirectToProCheckout();
    } catch (err) {
      console.error("[PremiumGate] checkout failed", err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative isolate">
      <div
        aria-hidden
        className="pointer-events-none select-none blur-xl saturate-50 contrast-75"
      >
        {children}
      </div>

      <div className="absolute inset-0 z-20 flex items-center justify-center bg-night-950/55 px-4 py-10 backdrop-blur-[2px]">
        <AnimatePresence>
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="pro-upgrade-title"
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="w-full max-w-md border border-gold-500/35 bg-night-900/95 px-7 py-8 text-center shadow-[0_30px_80px_rgba(0,0,0,0.55)] backdrop-blur-md sm:px-9 sm:py-10"
          >
            <p className="text-[10px] tracking-[0.45em] text-gold-400 uppercase">
              ✦ Divine Insight Pro ✦
            </p>
            <h2
              id="pro-upgrade-title"
              className="mt-4 font-display text-3xl font-medium tracking-[0.06em] text-cream-50 sm:text-4xl"
            >
              Go deeper
            </h2>
            <p className="mx-auto mt-4 max-w-sm text-sm leading-relaxed text-cream-100/70">
              {pitch}
            </p>
            <ul className="mx-auto mt-5 max-w-xs space-y-2 text-left text-xs leading-relaxed text-cream-100/55">
              <li className="flex gap-2">
                <span className="text-gold-400" aria-hidden>
                  ✦
                </span>
                <span>Celtic Cross ten-position spread</span>
              </li>
              <li className="flex gap-2">
                <span className="text-gold-400" aria-hidden>
                  ✦
                </span>
                <span>Advanced 1-to-5 vector scoring</span>
              </li>
              <li className="flex gap-2">
                <span className="text-gold-400" aria-hidden>
                  ✦
                </span>
                <span>Journal tracking across your readings</span>
              </li>
            </ul>
            <button
              type="button"
              onClick={handleUpgrade}
              disabled={busy}
              className="mt-7 inline-flex cursor-pointer items-center gap-2.5 rounded-full bg-gradient-to-b from-gold-300 via-gold-400 to-gold-500 px-8 py-3.5 text-xs font-medium tracking-[0.14em] text-night-950 uppercase shadow-[0_10px_40px_rgba(198,160,85,0.35)] transition hover:shadow-[0_12px_55px_rgba(198,160,85,0.55)] hover:brightness-105 active:scale-[0.98] disabled:cursor-wait disabled:opacity-60 sm:text-sm"
            >
              <span>{busy ? "Opening Stripe…" : "Upgrade with Stripe"}</span>
              <span aria-hidden>✦</span>
            </button>
            <p className="mt-3 text-[10px] tracking-[0.2em] text-cream-100/35 uppercase">
              $5 / month · Cancel anytime
            </p>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
