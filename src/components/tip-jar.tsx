/**
 * TipJar — the "Leave a tip" support rail (donation path, retention play).
 *
 * A modest end-of-page rail for engaged free readers: three fixed tip amounts
 * ($3 / $5 / $10), each an <a> that opens the Stripe checkout link for that
 * amount in a new tab. Honor-based like everything else here — payment is
 * never verified, and the copy frames the tip as a gift, never a purchase and
 * never "pay or the site dies" pressure.
 *
 * URLs come from `resolveTipLinks` in ~/lib/payments.ts: production builds
 * use the live tip links; preview/dev builds use TEST-mode links from the
 * VITE_STRIPE_TIP_LINK_* env vars, and the rail hides itself when those are
 * missing — a non-production build never links to live checkout.
 * SSR-safe: resolved at build time, so server and client render the same.
 */
import {
  TIP_10_PRICE,
  TIP_3_PRICE,
  TIP_5_PRICE,
  formatPrice,
  resolveTipLinks,
} from "~/lib/payments";

/** Set from VERCEL_ENV at build time in vite.config.ts. */
const TIP_LINKS = resolveTipLinks(
  import.meta.env.VITE_DEPLOY_ENV as string | undefined,
  import.meta.env as Record<string, string | undefined>,
);

const TIPS = TIP_LINKS
  ? ([
      { label: `Tip $${formatPrice(TIP_3_PRICE)}`, href: TIP_LINKS.tip3 },
      { label: `Tip $${formatPrice(TIP_5_PRICE)}`, href: TIP_LINKS.tip5 },
      { label: `Tip $${formatPrice(TIP_10_PRICE)}`, href: TIP_LINKS.tip10 },
    ] as const)
  : null;

export function TipJar() {
  if (!TIPS) return null;
  return (
    <section
      aria-label="Leave a tip"
      className="animate-fade-up scroll-mt-24 pb-16 sm:scroll-mt-28 sm:pb-24"
    >
      <div className="mx-auto max-w-2xl rounded-2xl border border-gold-500/25 bg-night-900/70 p-6 text-center shadow-[0_25px_70px_rgba(0,0,0,0.35)] backdrop-blur-sm sm:p-10">
        <p className="text-[10px] tracking-[0.45em] text-gold-400 uppercase">
          ✦ Leave a tip ✦
        </p>
        <h2 className="mt-3 font-display text-2xl font-medium tracking-[0.08em] text-cream-50 sm:text-3xl">
          A small thanks for the free deck
        </h2>
        <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-cream-100/60">
          If the cards have given you a moment of clarity, a small tip keeps
          the free readings flowing for the next person — and we&rsquo;d love
          to see you tomorrow for a new card.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          {TIPS.map((tip) => (
            <a
              key={tip.label}
              href={tip.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-gold-500/50 px-6 py-2.5 text-xs font-medium tracking-[0.14em] text-gold-300 uppercase transition hover:border-gold-400/80 hover:bg-gold-500/10 hover:text-gold-200 active:scale-[0.98] sm:px-7 sm:py-3 sm:text-sm"
            >
              <span aria-hidden className="text-gold-400">
                ✦
              </span>
              <span>{tip.label}</span>
            </a>
          ))}
        </div>
        <p className="mx-auto mt-5 max-w-md text-xs leading-relaxed text-cream-100/45 italic">
          Payments are handled securely through Stripe in a new tab; nothing is
          verified — a tip is a gift, not a purchase.
        </p>
      </div>
    </section>
  );
}