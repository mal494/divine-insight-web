import { AuthIndicator } from "~/components/auth-indicator";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AllCardsModal } from "~/components/all-cards-modal";
import { CardFace } from "~/components/card-face";
import { DailyCard } from "~/components/daily-card";
import { ExtendedReading } from "~/components/extended-reading";
import { GiftReading } from "~/components/gift-reading";
import { Journal } from "~/components/Journal";
import { PremiumGate } from "~/components/PremiumGate";
import { Pricing } from "~/components/pricing";
import { ReadingPanel } from "~/components/reading-panel";
import { SingleInsight } from "~/components/single-insight";
import { TipJar } from "~/components/tip-jar";
import { useSubscription } from "~/context/SubscriptionContext";
import { DECK, type TarotCard } from "~/data/deck";
import {
  EXTENDED_READING_PRICE,
  SINGLE_INSIGHT_PRICE,
  formatPrice,
} from "~/lib/payments";
import { shuffle } from "~/lib/random";
import { synthesizeReading } from "~/lib/synthesis";

export const Route = createFileRoute("/")({
  component: Home,
});

const POSITIONS = [
  { label: "Past", hint: "the thread behind you" },
  { label: "Present", hint: "where your energy flows now" },
  { label: "Future", hint: "what is gently emerging" },
] as const;

type View = "draw" | "extended" | "journal" | "gallery";

const FIRST_REVEAL_DELAY_MS = 450;
const REVEAL_STAGGER_MS = 700;
const FLIP_DONE_MS = 500;

type Phase = "idle" | "drawing" | "done";

/** Deterministic PRNG so the starfield renders identically on server & client (no hydration mismatch). */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STAR_SEED = 42;

function Starfield() {
  const stars = useMemo(() => {
    const rand = mulberry32(STAR_SEED);
    return Array.from({ length: 46 }, () => ({
      top: rand() * 100,
      left: rand() * 100,
      size: rand() * 1.6 + 1,
      delay: rand() * 6,
      duration: rand() * 5 + 4,
    }));
  }, []);
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 overflow-hidden"
    >
      {stars.map((s, i) => (
        <span
          key={i}
          className="animate-twinkle absolute rounded-full bg-cream-100"
          style={{
            top: `${s.top}%`,
            left: `${s.left}%`,
            width: `${s.size}px`,
            height: `${s.size}px`,
            animationDelay: `${s.delay}s`,
            animationDuration: `${s.duration}s`,
          }}
        />
      ))}
    </div>
  );
}

/**
 * The revealed face of a card — lives in ~/components/card-face.tsx (shared
 * with the Extended and Gift readings). The card slot below wraps it with the
 * position label, the flip scene, and the free reading's card detail.
 */

function CardSlot({
  position,
  card,
  revealed,
}: {
  position: (typeof POSITIONS)[number];
  card: TarotCard | null;
  revealed: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center text-center">
      <p className="font-display text-sm tracking-[0.3em] text-gold-300 uppercase sm:text-lg">
        {position.label}
      </p>
      <p className="mt-1 text-[10px] text-cream-100/40 italic sm:text-xs">
        {position.hint}
      </p>

      <div className="card-scene mt-4 aspect-[3/5] w-full max-w-[8rem] sm:mt-6 sm:max-w-[12.5rem]">
        <div className={`card-inner ${revealed ? "is-revealed" : ""}`}>
          {/* Card back */}
          <div aria-hidden className="card-face card-back" />
          {/* Card face (revealed) */}
          <CardFace card={card} />
        </div>
      </div>

      <div className="mt-3 flex min-h-[13.5rem] w-full max-w-[15rem] items-start justify-center sm:mt-5 sm:min-h-[15rem] sm:max-w-[19rem]">
        {revealed && card ? (
          <div className="min-w-0 w-full animate-fade-in">
            <p className="font-display text-base text-gold-300 sm:text-xl">
              {card.name}
            </p>
            <p className="mt-1 text-[9px] leading-relaxed tracking-[0.12em] text-gold-400/80 uppercase sm:mt-1.5 sm:text-[10px]">
              {card.keywords.join(" · ")} · {card.element} · {card.astrology}
            </p>
            <p className="mt-1.5 w-full min-w-0">
              <span className="inline-flex w-auto items-baseline gap-1.5 rounded-full border border-gold-500/30 bg-gold-500/10 px-2.5 py-1 text-[9px] leading-snug tracking-[0.14em] text-gold-200 uppercase sm:text-[10px]">
                <span aria-hidden className="text-gold-400">
                  ✦
                </span>
                <span>
                  <span className="font-semibold text-gold-100">
                    {card.numerology.value}
                  </span>
                  {" · "}
                  {card.numerology.note}
                </span>
              </span>
            </p>
            <p className="mt-2 text-[11px] leading-relaxed text-cream-100/75 sm:mt-2.5 sm:text-sm">
              {card.meaning}
            </p>
          </div>
        ) : (
          <p className="pt-1 text-[11px] text-cream-100/25 italic sm:text-xs">
            The card waits in shadow
          </p>
        )}
      </div>
    </div>
  );
}

function Home() {
  const { isPremium } = useSubscription();
  const [cards, setCards] = useState<TarotCard[]>([]);
  const [revealed, setRevealed] = useState<boolean[]>([false, false, false]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [question, setQuestion] = useState("");
  /** The question captured at draw time — the reading never changes after the cards turn. */
  const [drawnQuestion, setDrawnQuestion] = useState<string | undefined>(
    undefined,
  );
  const [view, setView] = useState<View>("draw");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const galleryOpen = view === "gallery";
  const openGallery = useCallback(() => setView("gallery"), []);
  const closeGallery = useCallback(() => setView("draw"), []);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    if (!isPremium && view === "journal") {
      setView("draw");
    }
  }, [isPremium, view]);

  function startReading() {
    timers.current.forEach(clearTimeout);
    timers.current = [];

    const trimmed = question.trim();
    setDrawnQuestion(trimmed.length > 0 ? trimmed : undefined);
    setCards(shuffle(DECK).slice(0, 3));
    setRevealed([false, false, false]);
    setPhase("drawing");

    [0, 1, 2].forEach((i) => {
      timers.current.push(
        setTimeout(
          () =>
            setRevealed((prev) => prev.map((r, idx) => (idx === i ? true : r))),
          FIRST_REVEAL_DELAY_MS + i * REVEAL_STAGGER_MS,
        ),
      );
    });
    // Flip #3 lands at 1850ms; mark the reading done after the card settles.
    timers.current.push(
      setTimeout(
        () => setPhase("done"),
        FIRST_REVEAL_DELAY_MS + 2 * REVEAL_STAGGER_MS + FLIP_DONE_MS,
      ),
    );

    document
      .getElementById("reading")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const drawing = phase === "drawing";
  const ctaLabel = drawing
    ? "Drawing your cards…"
    : phase === "done"
      ? "Draw again"
      : "Draw your cards";

  const tabBase =
    "inline-flex cursor-pointer items-center rounded-full border px-3.5 py-1.5 text-[10px] uppercase tracking-[0.16em] transition sm:text-[11px]";
  const tabCls = (active: boolean) =>
    `${tabBase} ${
      active
        ? "border-gold-400/50 bg-gold-500/15 text-gold-200"
        : "border-transparent text-cream-100/55 hover:text-cream-50"
    }`;

  /**
   * Synthesized reading — derived purely from the drawn cards and the question
   * captured at draw time, so it recomputes cleanly on "Draw again" (and stays
   * out of the initial SSR render, where no cards are drawn yet).
   */
  const summary = useMemo(
    () => (cards.length === 3 ? synthesizeReading(cards, drawnQuestion) : null),
    [cards, drawnQuestion],
  );

  return (
    <>
      <Starfield />
      <div className="relative z-10 flex min-h-dvh flex-col">
        <header className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-3 gap-y-3 px-5 pt-6 sm:px-8 sm:pt-9">
          <a href="#top" className="flex items-center gap-2.5 sm:gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-full border border-gold-500/60 bg-night-800/60 text-sm text-gold-300 shadow-[0_0_18px_rgba(198,160,85,0.25)] sm:h-9 sm:w-9 sm:text-base">
              ✦
            </span>
            <span className="font-display text-lg tracking-[0.18em] text-cream-50 sm:text-2xl">
              Divine Insight
            </span>
          </a>
          <div className="flex w-full items-center justify-center gap-5 sm:w-auto sm:gap-7">
            <nav
              aria-label="Readings and gallery"
              className="flex items-center gap-1 rounded-full border border-white/[0.08] bg-night-900/60 p-1"
            >
              <button
                type="button"
                onClick={() => setView("draw")}
                aria-current={view === "draw" ? "page" : undefined}
                className={tabCls(view === "draw")}
              >
                Draw
              </button>
              <button
                type="button"
                onClick={() => setView("extended")}
                aria-current={view === "extended" ? "page" : undefined}
                className={tabCls(view === "extended")}
              >
                Extended
              </button>
              {isPremium && (
                <button
                  type="button"
                  onClick={() => setView("journal")}
                  aria-current={view === "journal" ? "page" : undefined}
                  className={tabCls(view === "journal")}
                >
                  Journal
                </button>
              )}
              <button
                type="button"
                onClick={openGallery}
                aria-current={view === "gallery" ? "true" : undefined}
                className={tabCls(view === "gallery")}
              >
                All Cards
              </button>
            </nav>
            <span className="hidden text-[10px] tracking-[0.35em] text-cream-100/40 uppercase lg:inline">
              The 78-Card Deck · Readings from $2.99
            </span>
            <AuthIndicator />
          </div>
        </header>

        <main id="top" className="mx-auto w-full max-w-6xl flex-1 px-5 sm:px-8">
          {view === "extended" ? (
            /*
             * Extended stays on the verified one-time SKU / Bundle entitlement
             * (useEntitlement inside ExtendedReading). Do not wrap it in
             * PremiumGate — that would block customers who already paid $9.99
             * (or a Bundle) and would also hide the existing Stripe unlock CTA.
             * Pro subscription gates the three-card spread and Journal instead.
             */
            <ExtendedReading />
          ) : view === "journal" && isPremium ? (
            <PremiumGate>
              <Journal />
            </PremiumGate>
          ) : (
            <>
              {/* Hero — full-bleed artwork, indigo scrim, copy on the center-left */}
              <section className="relative flex min-h-[38rem] items-center overflow-hidden pt-16 pb-20 sm:min-h-[44rem] sm:pt-20 sm:pb-24">
                <div aria-hidden className="hero-bg" />
                <div className="relative max-w-xl text-left">
                  <p className="animate-fade-up text-[10px] tracking-[0.45em] text-gold-400 uppercase sm:text-xs">
                    ✦ Tarot reflections ✦
                  </p>
                  <h1
                    className="animate-fade-up mt-6 bg-gradient-to-b from-cream-50 via-cream-100 to-gold-300 bg-clip-text font-display text-6xl font-medium tracking-[0.06em] text-transparent sm:text-7xl md:text-8xl"
                    style={{ animationDelay: "0.1s" }}
                  >
                    Divine Insight
                  </h1>
                  <p
                    className="animate-fade-up mt-6 text-lg font-light text-cream-100/80 sm:text-xl"
                    style={{ animationDelay: "0.2s" }}
                  >
                    A moment of clarity, drawn just for you.
                  </p>
                  <p
                    className="animate-fade-up mt-4 max-w-md text-sm leading-relaxed text-cream-100/60"
                    style={{ animationDelay: "0.25s" }}
                  >
                    Draw from the full seventy-eight — the twenty-two major
                    arcana and all four suits of everyday life. Return whenever
                    you want a moment of reflection.
                  </p>
                  {isPremium ? (
                    <div
                      className="animate-fade-up mt-10 flex flex-col items-start gap-3"
                      style={{ animationDelay: "0.35s" }}
                    >
                      <label className="w-full max-w-xs sm:max-w-sm">
                        <span className="sr-only">
                          What's on your mind? (optional)
                        </span>
                        <input
                          type="text"
                          value={question}
                          onChange={(e) => setQuestion(e.target.value)}
                          placeholder="What's on your mind? (optional)"
                          autoComplete="off"
                          className="w-full rounded-full border border-gold-500/30 bg-night-900/75 px-5 py-3 text-sm text-cream-100 placeholder:text-cream-100/35 transition focus:border-gold-400/70 focus:ring-2 focus:ring-gold-500/25 focus:outline-none"
                        />
                      </label>
                      <button
                        type="button"
                        onClick={startReading}
                        disabled={drawing}
                        className="group inline-flex cursor-pointer items-center gap-3 rounded-full bg-gradient-to-b from-gold-300 via-gold-400 to-gold-500 px-9 py-4 text-sm font-medium tracking-[0.14em] text-night-950 uppercase shadow-[0_10px_40px_rgba(198,160,85,0.35)] transition hover:shadow-[0_12px_55px_rgba(198,160,85,0.55)] hover:brightness-105 active:scale-[0.98] disabled:cursor-wait disabled:opacity-60 sm:text-base"
                      >
                        <span>{ctaLabel}</span>
                        <span
                          aria-hidden
                          className="text-base transition-transform group-hover:rotate-45 sm:text-lg"
                        >
                          ✦
                        </span>
                      </button>
                    </div>
                  ) : (
                    <div
                      className="animate-fade-up mt-10 flex flex-col items-start gap-3 sm:flex-row sm:items-center"
                      style={{ animationDelay: "0.35s" }}
                    >
                      <a
                        href="#daily-card"
                        className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-gold-500/50 px-6 py-2.5 text-xs tracking-[0.14em] text-gold-300 uppercase transition hover:border-gold-400/80 hover:bg-gold-500/10 hover:text-gold-200 active:scale-[0.98]"
                      >
                        <span>See today&rsquo;s free card</span>
                        <span aria-hidden>✦</span>
                      </a>
                      <a
                        href="#paid-readings"
                        className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-gold-500/50 px-6 py-2.5 text-xs tracking-[0.14em] text-gold-300 uppercase transition hover:border-gold-400/80 hover:bg-gold-500/10 hover:text-gold-200 active:scale-[0.98]"
                      >
                        <span>Browse paid readings</span>
                        <span aria-hidden>✦</span>
                      </a>
                    </div>
                  )}
                </div>
              </section>

              {/* Card of the Day — free daily retention strip (always ungated) */}
              <DailyCard />

              {/* Three-card Past · Present · Future — Pro-gated */}
              <PremiumGate>
                <section
                  id="reading"
                  className="scroll-mt-24 pb-16 sm:scroll-mt-28 sm:pb-24"
                >
                  <div className="animate-fade-up text-center">
                    <p className="text-[10px] tracking-[0.45em] text-gold-400 uppercase sm:text-xs">
                      The reading
                    </p>
                    <h2 className="mt-4 font-display text-4xl font-medium tracking-[0.08em] text-cream-50 sm:text-5xl">
                      Past · Present · Future
                    </h2>
                    <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-cream-100/55">
                      Hold a question or intention in your mind, then draw. Three
                      cards from the full deck turn to greet you in turn.
                    </p>
                  </div>

                  <div
                    aria-live="polite"
                    className="animate-fade-up mt-10 grid grid-cols-3 items-start gap-3 sm:mt-14 sm:gap-8 lg:gap-14"
                    style={{ animationDelay: "0.15s" }}
                  >
                    {POSITIONS.map((pos, i) => (
                      <CardSlot
                        key={pos.label}
                        position={pos}
                        card={cards[i] ?? null}
                        revealed={revealed[i]}
                      />
                    ))}
                  </div>

                  {phase === "done" && summary && (
                    <ReadingPanel
                      summary={summary}
                      kicker="Woven from your three cards"
                      title="Your reading"
                    />
                  )}

                  {phase === "done" && summary && (
                    <div className="animate-fade-up mx-auto mt-8 max-w-2xl rounded-2xl border border-gold-500/20 bg-night-900/40 px-6 py-5 text-center backdrop-blur-sm sm:px-8">
                      <p className="text-[10px] tracking-[0.45em] text-gold-400/90 uppercase">
                        This was a glimpse
                      </p>
                      <h3 className="mt-2 font-display text-2xl font-medium tracking-[0.08em] text-cream-50 sm:text-3xl">
                        Go deeper
                      </h3>
                      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-cream-100/60">
                        Your three cards opened a door — a focused or five-card
                        reading walks further through it.
                      </p>
                      <div className="mt-4 flex flex-col items-center justify-center gap-3 sm:flex-row">
                        <button
                          type="button"
                          onClick={() =>
                            document
                              .getElementById("single-insight")
                              ?.scrollIntoView({
                                behavior: "smooth",
                                block: "start",
                              })
                          }
                          className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-gold-500/50 px-6 py-2.5 text-xs tracking-[0.14em] text-gold-300 uppercase transition hover:border-gold-400/80 hover:bg-gold-500/10 hover:text-gold-200 active:scale-[0.98]"
                        >
                          Single Insight · ${formatPrice(SINGLE_INSIGHT_PRICE)}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            document
                              .getElementById("extended-reading")
                              ?.scrollIntoView({
                                behavior: "smooth",
                                block: "start",
                              })
                          }
                          className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-gold-500/50 px-6 py-2.5 text-xs tracking-[0.14em] text-gold-300 uppercase transition hover:border-gold-400/80 hover:bg-gold-500/10 hover:text-gold-200 active:scale-[0.98]"
                        >
                          Extended Reading · $
                          {formatPrice(EXTENDED_READING_PRICE)}
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="mt-10 flex min-h-[5rem] flex-col items-center gap-3 sm:mt-14">
                    {phase === "done" && (
                      <button
                        type="button"
                        onClick={startReading}
                        className="inline-flex cursor-pointer items-center gap-2.5 rounded-full border border-gold-500/50 px-8 py-3.5 text-sm tracking-[0.14em] text-gold-300 uppercase transition hover:border-gold-400/80 hover:bg-gold-500/10 hover:text-gold-200 active:scale-[0.98]"
                      >
                        <span>Draw again</span>
                        <span aria-hidden>✦</span>
                      </button>
                    )}
                    {phase === "done" && (
                      <p className="text-xs text-cream-100/40">
                        A fresh shuffle, a new lens — the deck holds all
                        seventy-eight cards.
                      </p>
                    )}
                  </div>
                </section>
              </PremiumGate>

              {/* Paid reading ladder — Single · Extended · Bundle · Gift */}
              <Pricing />

              {/* Single insight — one-card paid reading */}
              <SingleInsight />

              {/* Gift — one-card paid reading */}
              <GiftReading />

              {/* Tip jar — end-of-page support rail for engaged free readers */}
              <TipJar />
            </>
          )}
        </main>

        <footer className="border-t border-white/[0.06] py-8">
          <div className="mx-auto flex max-w-6xl flex-col items-center gap-3 px-5 text-center sm:px-8">
            <p className="max-w-2xl text-xs leading-relaxed text-cream-100/45">
              Divine Insight readings are offered as a space for reflection and
              entertainment. They are not professional, medical, financial, or
              legal advice, and no reading can predict the future.
            </p>
            <p className="text-[10px] tracking-[0.3em] text-cream-100/30 uppercase">
              © 2026 Divine Insight · Drawn from the full 78-card deck
            </p>
          </div>
        </footer>
      </div>
      <AllCardsModal open={galleryOpen} onClose={closeGallery} />
    </>
  );
}
