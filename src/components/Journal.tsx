/**
 * Journal — Pro reading log preview.
 *
 * Full persistence already lives on orders (`/api/order/<id>?include=readings`);
 * this surface is the visitor-facing journal shell. Free visitors see it only
 * through PremiumGate.
 */
const SAMPLE_ENTRIES = [
  {
    title: "Past · Present · Future",
    date: "A quiet Tuesday",
    note: "Three cards on clarity — the present held more weight than the path behind.",
  },
  {
    title: "Celtic Cross",
    date: "Last new moon",
    note: "Foundation and outcome agreed: something soft is asking to be named.",
  },
  {
    title: "Vector score · 4 / 5",
    date: "This week",
    note: "Alignment ran high across the draw — keep the question close.",
  },
] as const;

export function Journal() {
  return (
    <section
      aria-label="Reading journal"
      className="animate-fade-up scroll-mt-24 pt-10 pb-20 sm:pt-14 sm:pb-28"
    >
      <div className="text-center">
        <p className="text-[10px] tracking-[0.45em] text-gold-400 uppercase sm:text-xs">
          Your archive
        </p>
        <h2 className="mt-4 font-display text-4xl font-medium tracking-[0.08em] text-cream-50 sm:text-5xl">
          Journal
        </h2>
        <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-cream-100/55">
          Every Pro reading lands here — a quiet ledger of questions, spreads,
          and the threads you chose to keep.
        </p>
      </div>

      <ul className="mx-auto mt-12 max-w-2xl space-y-5">
        {SAMPLE_ENTRIES.map((entry) => (
          <li
            key={entry.title}
            className="border border-gold-500/20 bg-night-900/50 px-6 py-5 text-left backdrop-blur-sm sm:px-8 sm:py-6"
          >
            <p className="text-[10px] tracking-[0.35em] text-gold-400/80 uppercase">
              {entry.date}
            </p>
            <p className="mt-2 font-display text-2xl tracking-[0.06em] text-cream-50">
              {entry.title}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-cream-100/65">
              {entry.note}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
