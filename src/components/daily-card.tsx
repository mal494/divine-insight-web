/**
 * DailyCard — the free "Card of the Day" strip (retention).
 *
 * The card is chosen deterministically from the UTC calendar date: a seeded
 * PRNG derived from the YYYY-MM-DD string picks one Major Arcana card, so
 * every visitor sees the same card on the same day and the server and client
 * always render the identical card. `new Date()` here only reads the UTC
 * date (safe for hydration); there is no Math.random() or Date.now() in
 * render. The strip is free — no payment link.
 */
import { useMemo } from "react";
import { MAJOR_ARCANA } from "~/data/deck";

/** FNV-1a — a stable, dependency-free string hash for the date seed. */
function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic PRNG (mulberry32) so the selection is stable server/client. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ticket of the day — same for every visitor, stable across renders. */
function cardForUtcDate(utcDate: string) {
  const rand = mulberry32(hashString(utcDate));
  const index = Math.floor(rand() * MAJOR_ARCANA.length);
  return MAJOR_ARCANA[index];
}

/** Condense the card's reflective meaning to its first sentence. */
function firstSentence(meaning: string): string {
  const end = meaning.indexOf(". ");
  return end === -1 ? meaning : meaning.slice(0, end + 1);
}

export function DailyCard() {
  const utcDate = useMemo(
    () => new Date().toISOString().slice(0, 10), // "2026-09-12" in UTC
    [],
  );
  const card = useMemo(() => cardForUtcDate(utcDate), [utcDate]);
  const line = useMemo(() => firstSentence(card.meaning), [card]);

  return (
    <section
      id="daily-card"
      aria-label="Card of the Day"
      className="animate-fade-up scroll-mt-24 pb-12 sm:pb-14"
    >
      <div className="flex flex-col items-start gap-5 rounded-2xl border border-gold-500/25 bg-night-900/60 p-6 shadow-[0_25px_70px_rgba(0,0,0,0.3)] backdrop-blur-sm sm:flex-row sm:items-center sm:justify-between sm:gap-8 sm:p-7">
        <div className="min-w-0">
          <p className="text-[10px] tracking-[0.45em] text-gold-400 uppercase sm:text-xs">
            ✦ Card of the Day
          </p>
          <p className="mt-2 font-display text-3xl font-medium tracking-[0.06em] text-gold-200 sm:text-4xl">
            {card.name}
          </p>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-cream-100/70">
            {line}
          </p>
          <p className="mt-2.5 text-[10px] tracking-[0.3em] text-cream-100/40 uppercase">
            A new card every day at midnight UTC
          </p>
        </div>
        <a
          href="#paid-readings"
          className="inline-flex shrink-0 cursor-pointer items-center gap-2.5 rounded-full border border-gold-500/50 px-7 py-3 text-xs tracking-[0.14em] text-gold-300 uppercase transition hover:border-gold-400/80 hover:bg-gold-500/10 hover:text-gold-200 active:scale-[0.98] sm:text-sm"
        >
          <span>Explore paid readings</span>
          <span aria-hidden>✦</span>
        </a>
      </div>
    </section>
  );
}