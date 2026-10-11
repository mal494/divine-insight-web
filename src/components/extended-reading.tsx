/**
 * ExtendedReading — the paid five-card reading view ($9.99).
 *
 * Value-framed offer: an "Unlock" CTA that opens Stripe in a new tab, then a
 * five-card draw — Foundation · Current path · Hidden influence · Near future ·
 * Outcome — with a position note + full card detail per card, and the extended
 * synthesized reading.
 *
 * The draw is gated on a verified purchase. `useEntitlement` holds an order id
 * and asks the server what it is worth; the server only answers "paid" after
 * Stripe's webhook has confirmed the payment, so nothing the browser does can
 * unlock the cards. Once the cards are down the reading is posted back and
 * stored against the order, which is what lets the Reading Bundle hand out
 * three draws and keep them. See PAYMENTS.md.
 *
 * SSR-safe: this component only mounts after the visitor clicks the Extended
 * tab (client-side), and its draw runs in an event handler, so nothing
 * non-deterministic is ever rendered on the server.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CardFace } from "~/components/card-face";
import { ReadingPanel } from "~/components/reading-panel";
import { DECK, type TarotCard } from "~/data/deck";
import { useEntitlement } from "~/lib/entitlement";
import {
  EXTENDED_READING_PRICE,
  READING_BUNDLE_PRICE,
  formatPrice,
} from "~/lib/payments";
import { shuffle } from "~/lib/random";
import { SPREAD_POSITIONS, synthesizeReading } from "~/lib/synthesis";

const FIRST_REVEAL_DELAY_MS = 450;
const REVEAL_STAGGER_MS = 700;
const FLIP_DONE_MS = 500;

type Phase = "idle" | "drawing" | "done";

/** Position labels come from SPREAD_POSITIONS (single source of truth with the
 *  synthesizer); hints + interpretation notes are display-only. */
const POSITION_HINTS: Record<string, string> = {
  Foundation: "the ground beneath you",
  "Current path": "the road you walk now",
  "Hidden influence": "what moves beneath the surface",
  "Near future": "what is drawing closer",
  Outcome: "the direction things lean",
};

const POSITION_NOTES: Record<string, string> = {
  Foundation:
    "This card grounds the spread — it speaks to the roots beneath you, the resources you already hold, and the ground you stand on.",
  "Current path":
    "This card speaks to the road you are walking now — the choices, rhythms, and small decisions shaping your days.",
  "Hidden influence":
    "This card speaks to what moves beneath the surface — a quiet current at work behind the scenes, not yet fully named.",
  "Near future":
    "This card speaks to what is gently drawing closer — a shift taking shape on the horizon, still soft enough to shape.",
  Outcome:
    "This card speaks to the direction things lean — a tendency to understand and hold lightly, never a verdict.",
};

const NUMEROLOGY_CHIP_CLS =
  "inline-flex w-auto items-baseline gap-1.5 rounded-full border border-gold-500/30 bg-gold-500/10 px-2.5 py-1 text-[9px] leading-snug tracking-[0.14em] text-gold-200 uppercase sm:text-[10px]";

const CTA_CLS =
  "mt-6 inline-flex cursor-pointer items-center gap-3 rounded-full bg-gradient-to-b from-gold-300 via-gold-400 to-gold-500 px-9 py-4 text-sm font-medium tracking-[0.14em] text-night-950 uppercase shadow-[0_10px_40px_rgba(198,160,85,0.35)] transition hover:shadow-[0_12px_55px_rgba(198,160,85,0.55)] hover:brightness-105 active:scale-[0.98] disabled:cursor-wait disabled:opacity-60 sm:text-base";

export function ExtendedReading() {
  const [cards, setCards] = useState<TarotCard[]>([]);
  const [revealed, setRevealed] = useState<boolean[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [question, setQuestion] = useState("");
  /** The question captured at draw time — the reading never changes after the cards turn. */
  const [drawnQuestion, setDrawnQuestion] = useState<string | undefined>(
    undefined,
  );
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const entitlement = useEntitlement("extendedReading", {
    alsoAccept: ["readingBundle"],
  });
  const unlocked = entitlement.status === "unlocked";

  const positions = SPREAD_POSITIONS[5];
  const count = positions.length;

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  function draw() {
    // Belt and braces — the button is disabled when locked, but the draw must
    // not depend on the button's state to stay honest.
    if (!unlocked) return;

    timers.current.forEach(clearTimeout);
    timers.current = [];

    const trimmed = question.trim();
    setDrawnQuestion(trimmed.length > 0 ? trimmed : undefined);
    setCards(shuffle(DECK).slice(0, count));
    setRevealed(Array(count).fill(false));
    setPhase("drawing");

    for (let i = 0; i < count; i++) {
      timers.current.push(
        setTimeout(
          () =>
            setRevealed((prev) => prev.map((r, idx) => (idx === i ? true : r))),
          FIRST_REVEAL_DELAY_MS + i * REVEAL_STAGGER_MS,
        ),
      );
    }
    timers.current.push(
      setTimeout(
        () => setPhase("done"),
        FIRST_REVEAL_DELAY_MS + (count - 1) * REVEAL_STAGGER_MS + FLIP_DONE_MS,
      ),
    );

    document
      .getElementById("extended-reading")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const drawing = phase === "drawing";
  const ctaLabel = drawing
    ? "Drawing your cards…"
    : phase === "done"
      ? "Draw again"
      : "Draw your five cards";

  const summary = useMemo(
    () =>
      cards.length === count ? synthesizeReading(cards, drawnQuestion) : null,
    [cards, drawnQuestion, count],
  );

  // Spend the credit and store the reading once the last card has turned.
  // Keyed on the drawn cards so a re-render never double-counts a draw.
  const recorded = useRef<string | null>(null);
  useEffect(() => {
    if (phase !== "done" || !summary || cards.length !== count) return;
    const key = cards.map((c) => c.id).join("|");
    if (recorded.current === key) return;
    recorded.current = key;
    void entitlement.recordReading({
      spread: "extended",
      question: drawnQuestion ?? null,
      cards: cards.map((card, i) => ({
        id: card.id,
        name: card.name,
        position: positions[i]?.position ?? null,
      })),
      summary,
      drawnAt: new Date().toISOString(),
    });
  }, [phase, summary, cards, count, drawnQuestion, positions, entitlement]);

  return (
    <section
      id="extended-reading"
      className="scroll-mt-24 pt-16 pb-16 sm:scroll-mt-28 sm:pt-20 sm:pb-24"
    >
      {/* Offer header */}
      <div className="animate-fade-up text-center">
        <p className="text-[10px] tracking-[0.45em] text-gold-400 uppercase sm:text-xs">
          ✦ The Extended Reading ✦
        </p>
        <h2 className="mt-4 font-display text-4xl font-medium tracking-[0.08em] text-cream-50 sm:text-5xl">
          Five cards, a deeper mirror
        </h2>
        <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-cream-100/55 sm:max-w-lg sm:text-[15px]">
          The Extended Reading draws five cards across five positions —
          Foundation, Current path, Hidden influence, Near future, and Outcome.
          Each card is interpreted in its place, then all five are woven into
          one longer reading. Like every reading here, it is a space for
          reflection, not a prediction: a deeper look at where you are and the
          currents moving around you.
        </p>
      </div>

      {/* Unlock card — hidden once the purchase is verified */}
      {!unlocked && (
        <div
          className="animate-fade-up mx-auto mt-10 max-w-xl rounded-2xl border border-gold-500/25 bg-night-900/70 p-6 text-center shadow-[0_25px_70px_rgba(0,0,0,0.35)] backdrop-blur-sm sm:p-8"
          style={{ animationDelay: "0.1s" }}
        >
          <p className="font-display text-2xl font-medium tracking-[0.08em] text-gold-200 sm:text-3xl">
            Unlock the Extended Reading
          </p>
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-cream-100/65">
            Five cards across five positions — Foundation, Current path, Hidden
            influence, Near future, Outcome — each read in its place, then woven
            into one longer, more personal reading.
          </p>

          <button
            type="button"
            onClick={() => void entitlement.startCheckout()}
            disabled={entitlement.busy}
            className={CTA_CLS}
          >
            <span aria-hidden>✦</span>
            <span>
              {entitlement.busy
                ? "Opening Stripe…"
                : `Unlock · $${formatPrice(EXTENDED_READING_PRICE)}`}
            </span>
          </button>

          {entitlement.status === "awaiting-payment" && (
            <p className="mt-4 text-xs leading-relaxed text-gold-200/80">
              Waiting for Stripe to confirm your payment — this page unlocks on
              its own, usually within a few seconds. You can leave the tab open.
            </p>
          )}
          {entitlement.status === "spent" && (
            <p className="mt-4 text-xs leading-relaxed text-cream-100/60">
              This reading has already been drawn. Unlock another whenever
              you&rsquo;re ready.
            </p>
          )}
          {entitlement.status === "unavailable" && (
            <p className="mt-4 text-xs leading-relaxed text-cream-100/60">
              Checkout is unavailable right now. Please try again in a moment.
            </p>
          )}
          {entitlement.status === "locked" && (
            <p className="mt-4 text-xs leading-relaxed text-cream-100/45 italic">
              Payments are handled securely through Stripe in a new tab. Your
              reading unlocks here the moment the payment clears.
            </p>
          )}

          <p className="mt-2.5 text-xs text-cream-100/55">
            <button
              type="button"
              onClick={() => void entitlement.startCheckout({ sku: "readingBundle" })}
              disabled={entitlement.busy}
              className="cursor-pointer underline decoration-gold-500/50 underline-offset-2 transition hover:text-gold-200 hover:decoration-gold-400 disabled:cursor-wait disabled:opacity-60"
            >
              Or take three Extended Readings for ${formatPrice(READING_BUNDLE_PRICE)}{" "}
              — one for today, two for when it matters
            </button>
          </p>
        </div>
      )}

      {/* Draw area — only once the purchase is verified */}
      {unlocked && (
        <div className="animate-fade-up mx-auto mt-12 max-w-xl text-center sm:mt-16">
          <label className="block">
            <span className="sr-only">What's on your mind? (optional)</span>
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
            Five cards from the full seventy-eight · Drawn at random · Never
            repeated in a reading
          </p>
          {entitlement.credits > 1 && (
            <p className="mt-1.5 text-xs text-gold-300/80">
              {entitlement.credits} readings remaining on your bundle
            </p>
          )}
        </div>
      )}

      {/* The five cards — stacked on mobile, five-up from lg */}
      {unlocked && (
        <div
          role="region"
          aria-label="Extended reading cards"
          className="animate-fade-up mt-10 grid grid-cols-1 items-start gap-10 sm:mt-14 sm:gap-12 lg:grid-cols-5 lg:gap-5"
          style={{ animationDelay: "0.15s" }}
        >
          {positions.map((pos, i) => {
            const card = cards[i] ?? null;
            const isRevealed = revealed[i] ?? false;
            return (
              <div
                key={pos.position}
                className="flex min-w-0 flex-col items-center text-center"
              >
                <p className="font-display text-sm tracking-[0.3em] text-gold-300 uppercase sm:text-base">
                  {pos.position}
                </p>
                <p className="mt-1 text-[10px] text-cream-100/40 italic sm:text-xs">
                  {POSITION_HINTS[pos.position]}
                </p>

                <div className="card-scene mt-4 aspect-[3/5] w-full max-w-[8rem] sm:max-w-[9rem] lg:max-w-[10.5rem]">
                  <div
                    className={`card-inner ${isRevealed ? "is-revealed" : ""}`}
                  >
                    <div aria-hidden className="card-face card-back" />
                    <CardFace card={card} />
                  </div>
                </div>

                <div className="mt-4 flex w-full min-w-0 items-start justify-center">
                  {isRevealed && card ? (
                    <div className="animate-fade-in w-full min-w-0 lg:max-w-[15rem]">
                      <p className="font-display text-base text-gold-300 sm:text-lg">
                        {card.name}
                      </p>
                      <p className="mt-1 text-[9px] leading-relaxed tracking-[0.12em] text-gold-400/80 uppercase sm:text-[10px]">
                        {card.keywords.join(" · ")} · {card.element} ·{" "}
                        {card.astrology}
                      </p>
                      <p className="mt-1.5">
                        <span className={NUMEROLOGY_CHIP_CLS}>
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
                      <p className="mt-2 text-[11px] leading-relaxed text-cream-100/80 italic sm:text-xs">
                        {POSITION_NOTES[pos.position]}
                      </p>
                      <p className="mt-1.5 text-[11px] leading-relaxed text-cream-100/75 sm:text-xs">
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
          })}
        </div>
      )}

      {/* Extended synthesized reading */}
      {unlocked && phase === "done" && summary && (
        <ReadingPanel
          summary={summary}
          kicker="Woven from your five cards"
          title="Your extended reading"
        />
      )}

      {unlocked && (
        <div className="mt-10 flex min-h-[5rem] flex-col items-center gap-3 sm:mt-14">
          {phase === "done" && entitlement.status === "unlocked" && (
            <button
              type="button"
              onClick={draw}
              className="inline-flex cursor-pointer items-center gap-2.5 rounded-full border border-gold-500/50 px-8 py-3.5 text-sm tracking-[0.14em] text-gold-300 uppercase transition hover:border-gold-400/80 hover:bg-gold-500/10 hover:text-gold-200 active:scale-[0.98]"
            >
              <span>Draw again</span>
              <span aria-hidden>✦</span>
            </button>
          )}
          {phase === "done" && (
            <p className="text-xs text-cream-100/40">
              A fresh shuffle, a new lens — the deck holds all seventy-eight
              cards.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
