/**
 * SingleInsight — the paid single-card reading ($2.99), the entry rung.
 *
 * The SKU existed before this component did: the pricing ladder sold "one
 * question, one card, a line to carry" and then dropped the buyer back onto
 * the free three-card draw, so the cheapest paid tier delivered nothing of its
 * own. This is that reading — one card against the visitor's question, read in
 * full, with the line to carry.
 *
 * Gated on a verified purchase through `useEntitlement`, like the rest of the
 * paid ladder: the server only calls an order paid once Stripe's webhook has
 * confirmed it.
 *
 * SSR-safe: the card starts null and the draw runs in an event handler, so the
 * server render is always deterministic.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CardFace } from "~/components/card-face";
import { DECK, type TarotCard } from "~/data/deck";
import { useEntitlement } from "~/lib/entitlement";
import { PurchasesPaused } from "~/components/purchases-paused";
import { paidCheckoutEnabled } from "~/lib/paid-checkout";
import { SINGLE_INSIGHT_PRICE, formatPrice } from "~/lib/payments";
import { shuffle } from "~/lib/random";
import { singleCardLine } from "~/lib/synthesis";

const REVEAL_DELAY_MS = 450;
const FLIP_DONE_MS = 500;

type Phase = "idle" | "drawing" | "done";

export function SingleInsight() {
  const [card, setCard] = useState<TarotCard | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [question, setQuestion] = useState("");
  const [drawnQuestion, setDrawnQuestion] = useState<string | undefined>(
    undefined,
  );
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const entitlement = useEntitlement("singleInsight");
  const unlocked = entitlement.status === "unlocked";

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  function draw() {
    if (!unlocked) return;

    timers.current.forEach(clearTimeout);
    timers.current = [];

    const trimmed = question.trim();
    setDrawnQuestion(trimmed.length > 0 ? trimmed : undefined);
    setCard(shuffle(DECK)[0]);
    setRevealed(false);
    setPhase("drawing");

    timers.current.push(setTimeout(() => setRevealed(true), REVEAL_DELAY_MS));
    timers.current.push(
      setTimeout(() => setPhase("done"), REVEAL_DELAY_MS + FLIP_DONE_MS),
    );

    document
      .getElementById("single-insight")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const drawing = phase === "drawing";
  const ctaLabel = drawing
    ? "Drawing your card…"
    : phase === "done"
      ? "Draw another"
      : "Draw your card";

  const line = useMemo(
    () => (card && phase === "done" ? singleCardLine(card) : null),
    [card, phase],
  );

  const recorded = useRef<string | null>(null);
  useEffect(() => {
    if (phase !== "done" || !card || !line) return;
    if (recorded.current === card.id) return;
    recorded.current = card.id;
    void entitlement.recordReading({
      spread: "single",
      question: drawnQuestion ?? null,
      card: { id: card.id, name: card.name },
      line,
      drawnAt: new Date().toISOString(),
    });
  }, [phase, card, line, drawnQuestion, entitlement]);

  return (
    <section
      id="single-insight"
      className="scroll-mt-24 pb-16 sm:scroll-mt-28 sm:pb-24"
    >
      <div className="animate-fade-up mx-auto max-w-2xl rounded-2xl border border-gold-500/25 bg-night-900/70 p-6 text-center shadow-[0_25px_70px_rgba(0,0,0,0.35)] backdrop-blur-sm sm:p-10">
        <p className="text-[10px] tracking-[0.45em] text-gold-400 uppercase">
          ✦ Single Insight ✦
        </p>
        <h2 className="mt-3 font-display text-3xl font-medium tracking-[0.08em] text-cream-50 sm:text-4xl">
          One question, one card
        </h2>
        <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-cream-100/60">
          Ask the one thing that is actually on your mind. A single card
          answers it, read in full — and a line to carry out of the reading.
        </p>

        {!unlocked && !paidCheckoutEnabled() && <PurchasesPaused />}
        {!unlocked && paidCheckoutEnabled() && (
          <>
            <button
              type="button"
              onClick={() => void entitlement.startCheckout()}
              disabled={entitlement.busy}
              className="mt-6 inline-flex cursor-pointer items-center justify-center gap-3 rounded-full bg-gradient-to-b from-gold-300 via-gold-400 to-gold-500 px-9 py-4 text-sm font-medium tracking-[0.14em] text-night-950 uppercase shadow-[0_10px_40px_rgba(198,160,85,0.35)] transition hover:shadow-[0_12px_55px_rgba(198,160,85,0.55)] hover:brightness-105 active:scale-[0.98] disabled:cursor-wait disabled:opacity-60 sm:text-base"
            >
              <span aria-hidden>✦</span>
              <span>
                {entitlement.busy
                  ? "Opening Stripe…"
                  : `Draw yours · $${formatPrice(SINGLE_INSIGHT_PRICE)}`}
              </span>
            </button>

            {entitlement.status === "awaiting-payment" && (
              <p className="mt-4 text-xs leading-relaxed text-gold-200/80">
                Waiting for Stripe to confirm — this unlocks on its own, usually
                within a few seconds.
              </p>
            )}
            {entitlement.status === "spent" && (
              <p className="mt-4 text-xs leading-relaxed text-cream-100/60">
                This card has already been drawn. Ask another whenever you like.
              </p>
            )}
            {entitlement.status === "unavailable" && (
              <p className="mt-4 text-xs leading-relaxed text-cream-100/60">
                Checkout is unavailable right now. Please try again in a moment.
              </p>
            )}
            {entitlement.status === "locked" && (
              <p className="mx-auto mt-4 max-w-md text-xs leading-relaxed text-cream-100/45 italic">
                Payments are handled securely through Stripe in a new tab. Your
                card unlocks here the moment the payment clears.
              </p>
            )}
          </>
        )}

        {unlocked && (
          <div className="mt-8 flex flex-col items-center border-t border-white/[0.07] pt-8">
            <label className="block w-full max-w-sm">
              <span className="sr-only">What's on your mind?</span>
              <input
                type="text"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="What's on your mind?"
                autoComplete="off"
                className="w-full rounded-full border border-gold-500/30 bg-night-900/75 px-5 py-3 text-sm text-cream-100 placeholder:text-cream-100/35 transition focus:border-gold-400/70 focus:ring-2 focus:ring-gold-500/25 focus:outline-none"
              />
            </label>
            <button
              type="button"
              onClick={draw}
              disabled={drawing}
              className="group mt-5 inline-flex cursor-pointer items-center gap-3 rounded-full bg-gradient-to-b from-gold-300 via-gold-400 to-gold-500 px-9 py-4 text-sm font-medium tracking-[0.14em] text-night-950 uppercase shadow-[0_10px_40px_rgba(198,160,85,0.35)] transition hover:shadow-[0_12px_55px_rgba(198,160,85,0.55)] hover:brightness-105 active:scale-[0.98] disabled:cursor-wait disabled:opacity-60 sm:text-base"
            >
              <span>{ctaLabel}</span>
              <span
                aria-hidden
                className="text-base transition-transform group-hover:rotate-45 sm:text-lg"
              >
                ✦
              </span>
            </button>
            <p className="mt-3 text-xs text-cream-100/50">
              One card from the full seventy-eight · Drawn at random
            </p>

            <div className="card-scene mt-8 aspect-[3/5] w-full max-w-[8.5rem] sm:max-w-[11rem]">
              <div className={`card-inner ${revealed ? "is-revealed" : ""}`}>
                <div aria-hidden className="card-face card-back" />
                <CardFace card={card} revealed={revealed} />
              </div>
            </div>

            <div className="mt-6 flex min-h-[11rem] w-full max-w-md min-w-0 items-start justify-center">
              {phase === "done" && card ? (
                <div className="animate-fade-in w-full min-w-0">
                  {drawnQuestion && (
                    <p className="text-xs leading-relaxed text-cream-100/50 italic">
                      &ldquo;{drawnQuestion}&rdquo;
                    </p>
                  )}
                  <p className="mt-2 font-display text-2xl text-gold-300">
                    {card.name}
                  </p>
                  <p className="mt-1.5 text-[10px] leading-relaxed tracking-[0.12em] text-gold-400/80 uppercase sm:text-[11px]">
                    {card.keywords.join(" · ")} · {card.element} ·{" "}
                    {card.astrology}
                  </p>
                  <p className="mt-3 text-sm leading-relaxed text-cream-100/80 sm:text-[15px]">
                    {card.meaning}
                  </p>
                  {line && (
                    <div className="mt-5 rounded-xl border border-gold-500/20 bg-gold-500/5 p-4">
                      <p className="text-[10px] tracking-[0.3em] text-gold-400/90 uppercase">
                        A line to carry
                      </p>
                      <p className="mt-2 text-sm leading-relaxed text-cream-100/85 italic">
                        {line}
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <p className="pt-1 text-[11px] text-cream-100/25 italic sm:text-xs">
                  The card waits in shadow
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
