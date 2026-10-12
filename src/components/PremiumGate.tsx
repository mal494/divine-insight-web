/**
 * PremiumGate — freemium wrapper for Pro-only surfaces.
 *
 * Premium members see children as usual. Free visitors still see the content
 * beneath a heavy blur (so the product feels tangible) with pointer-events
 * disabled. Pro checkout is intentionally hidden for now, so this gate has no
 * upgrade CTA.
 */
import { AnimatePresence, motion } from "framer-motion";
import { type ReactNode } from "react";
import { useSubscription } from "~/context/SubscriptionContext";

type PremiumGateProps = {
  children: ReactNode;
  /** Optional override for the modal pitch line. */
  pitch?: string;
};

const DEFAULT_PITCH =
  "Divine Insight Pro is currently unavailable while we reshape the offering.";

export function PremiumGate({
  children,
  pitch = DEFAULT_PITCH,
}: PremiumGateProps) {
  const { isPremium, loading } = useSubscription();

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
              Pro is paused
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
            <p className="mt-6 text-xs leading-relaxed text-cream-100/50 italic">
              No purchase is available at this time.
            </p>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
