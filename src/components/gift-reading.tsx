/**
 * GiftReading — the paid single-card reading section ($5.00).
 *
 * An elegant small section on the Draw view: value framing, a short form for
 * who the gift is for, a "Send a reading" CTA that opens Stripe, then a
 * one-card draw with full detail and a short synthesized line.
 *
 * The draw is gated on a verified purchase — `useEntitlement` holds an order
 * id and the server only calls it paid once Stripe's webhook has confirmed
 * the payment. The recipient's details are captured at checkout and stored on
 * the order, so delivery can be added without asking for them twice.
 *
 * Note: the gift is not yet emailed to the recipient. The order carries their
 * address; what remains is a sender and a claim link. See PAYMENTS.md.
 *
 * SSR-safe: the card starts null and the draw runs in an event handler, so the
 * server render is always deterministic.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CardFace } from "~/components/card-face";
import { DECK, type TarotCard } from "~/data/deck";
import { useEntitlement } from "~/lib/entitlement";
import { GIFT_READING_PRICE, formatPrice } from "~/lib/payments";
import { shuffle } from "~/lib/random";
import { singleCardLine } from "~/lib/synthesis";

const REVEAL_DELAY_MS = 450;
const FLIP_DONE_MS = 500;

type Phase = "idle" | "drawing" | "done";

const FIELD_CLS =
  "w-full rounded-full border border-gold-500/30 bg-night-900/75 px-5 py-3 text-sm text-cream-100 placeholder:text-cream-100/35 transition focus:border-gold-400/70 focus:ring-2 focus:ring-gold-500/25 focus:outline-none";

export function GiftReading() {
  const [card, setCard] = useState<TarotCard | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [senderName, setSenderName] = useState("");
  const [note, setNote] = useState("");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const entitlement = useEntitlement("giftReading");
  const unlocked = entitlement.status === "unlocked";

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  function draw() {
    if (!unlocked) return;

    timers.current.forEach(clearTimeout);
    timers.current = [];

    setCard(shuffle(DECK)[0]);
    setRevealed(false);
    setPhase("drawing");

    timers.current.push(setTimeout(() => setRevealed(true), REVEAL_DELAY_MS));
    timers.current.push(
      setTimeout(() => setPhase("done"), REVEAL_DELAY_MS + FLIP_DONE_MS),
    );

    document
      .getElementById("gift-reading")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const drawing = phase === "drawing";
  const ctaLabel = drawing
    ? "Drawing your card…"
    : phase === "done"
      ? "Draw another"
      : "Draw your card";

  /** One short synthesized line — pure + deterministic (singleCardLine). */
  const line = useMemo(
    () => (card && phase === "done" ? singleCardLine(card) : null),
    [card, phase],
  );

  // Spend the credit and store the gift once the card has turned.
  const recorded = useRef<string | null>(null);
  useEffect(() => {
    if (phase !== "done" || !card || !line) return;
    if (recorded.current === card.id) return;
    recorded.current = card.id;
    void entitlement.recordReading({
      spread: "gift",
      card: { id: card.id, name: card.name },
      line,
      drawnAt: new Date().toISOString(),
    });
  }, [phase, card, line, entitlement]);

  return (
    <section
      id="gift-reading"
      className="scroll-mt-24 pb-16 sm:scroll-mt-28 sm:pb-24"
    >
      <div className="animate-fade-up mx-auto max-w-2xl rounded-2xl border border-gold-500/25 bg-night-900/70 p-6 text-center shadow-[0_25px_70px_rgba(0,0,0,0.35)] backdrop-blur-sm sm:p-10">
        <p className="text-[10px] tracking-[0.45em] text-gold-400 uppercase">
          ✦ Gift a reading ✦
        </p>
        <h2 className="mt-3 font-display text-3xl font-medium tracking-[0.08em] text-cream-50 sm:text-4xl">
          A single card, a small blessing
        </h2>
        <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-cream-100/60">
          One card, read in full and sent with your name — a small blessing
          they can return to whenever they need it.
        </p>

        {!unlocked && (
          <>
          <div className="mx-auto mt-6 flex max-w-sm flex-col gap-3 text-left">
            <label className="block">
              <span className="sr-only">Who is it for? (email)</span>
              <input
                type="email"
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value)}
                placeholder="Who is it for? (their email)"
                autoComplete="off"
                className={FIELD_CLS}
              />
            </label>
            <label className="block">
              <span className="sr-only">Your name</span>
              <input
                type="text"
                value={senderName}
                onChange={(e) => setSenderName(e.target.value)}
                placeholder="Your name"
                autoComplete="off"
                className={FIELD_CLS}
              />
            </label>
            <label className="block">
              <span className="sr-only">A short note (optional)</span>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="A short note (optional)"
                autoComplete="off"
                className={FIELD_CLS}
              />
            </label>

            <button
              type="button"
              onClick={() =>
                void entitlement.startCheckout({
                  recipientEmail: recipientEmail.trim() || undefined,
                  senderName: senderName.trim() || undefined,
                  note: note.trim() || undefined,
                })
              }
              disabled={entitlement.busy}
              className="mt-1 inline-flex cursor-pointer items-center justify-center gap-3 rounded-full bg-gradient-to-b from-gold-300 via-gold-400 to-gold-500 px-9 py-4 text-sm font-medium tracking-[0.14em] text-night-950 uppercase shadow-[0_10px_40px_rgba(198,160,85,0.35)] transition hover:shadow-[0_12px_55px_rgba(198,160,85,0.55)] hover:brightness-105 active:scale-[0.98] disabled:cursor-wait disabled:opacity-60 sm:text-base"
            >
              <span aria-hidden>✦</span>
              <span>
                {entitlement.busy
                  ? "Opening Stripe…"
                  : `Send a reading · $${formatPrice(GIFT_READING_PRICE)}`}
              </span>
            </button>

            {entitlement.status === "awaiting-payment" && (
              <p className="text-center text-xs leading-relaxed text-gold-200/80">
                Waiting for Stripe to confirm — this unlocks on its own, usually
                within a few seconds.
              </p>
            )}
            {entitlement.status === "spent" && (
              <p className="text-center text-xs leading-relaxed text-cream-100/60">
                This gift has already been drawn. Send another whenever you like.
              </p>
            )}
            {entitlement.status === "unavailable" && (
              <p className="text-center text-xs leading-relaxed text-cream-100/60">
                Checkout is unavailable right now. Please try again in a moment.
              </p>
            )}
            {entitlement.status === "locked" && (
              <p className="text-center text-xs leading-relaxed text-cream-100/45 italic">
                Payments are handled securely through Stripe in a new tab. Your
                card unlocks here the moment the payment clears.
              </p>
            )}
          </div>

          <div className="card-scene mt-8 aspect-[3/5] w-full max-w-[8.5rem] sm:max-w-[11rem]">
            <div className={`card-inner ${revealed ? "is-revealed" : ""}`}>
              <div aria-hidden className="card-face card-back" />
              <CardFace card={card} />
            </div>
          </div>

          <div className="mt-6 flex min-h-[11rem] w-full min-w-0 max-w-md items-start justify-center">
            {phase === "done" && card ? (
              <div className="animate-fade-in w-full min-w-0">
                <p className="font-display text-2xl text-gold-300">
                  {card.name}
                </p>
                <p className="mt-1.5 text-[10px] leading-relaxed tracking-[0.12em] text-gold-400/80 uppercase sm:text-[11px]">
                  {card.keywords.join(" · ")} · {card.element} ·{" "}
                  {card.astrology}
                </p>
                <p className="mt-2">
                  <span className="inline-flex w-auto items-baseline gap-1.5 rounded-full border border-gold-500/30 bg-gold-500/10 px-2.5 py-1 text-[10px] leading-snug tracking-[0.14em] text-gold-200 uppercase">
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
          </>
        )}

        {/* One-card draw — only once the purchase is verified */}
        {unlocked && (
          <div className="mt-10 flex flex-col items-center border-t border-white/[0.07] pt-8">
            <button
              type="button"
              onClick={draw}
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
            <p className="mt-3 text-xs text-cream-100/50">
              One card from the full seventy-eight · Drawn at random · Yours to
              keep or to give
            </p>

            <div className="card-scene mt-8 aspect-[3/5] w-full max-w-[8.5rem] sm:max-w-[11rem]">
              <div className={`card-inner ${revealed ? "is-revealed" : ""}`}>
                <div aria-hidden className="card-face card-back" />
                <CardFace card={card} revealed={revealed} />
              </div>
            </div>

            <div className="mt-6 flex min-h-[11rem] w-full min-w-0 max-w-md items-start justify-center">
              {phase === "done" && card ? (
                <div className="animate-fade-in w-full min-w-0">
                  <p className="font-display text-2xl text-gold-300">
                    {card.name}
                  </p>
                  <p className="mt-1.5 text-[10px] leading-relaxed tracking-[0.12em] text-gold-400/80 uppercase sm:text-[11px]">
                    {card.keywords.join(" · ")} · {card.element} ·{" "}
                    {card.astrology}
                  </p>
                  <p className="mt-2">
                    <span className="inline-flex w-auto items-baseline gap-1.5 rounded-full border border-gold-500/30 bg-gold-500/10 px-2.5 py-1 text-[10px] leading-snug tracking-[0.14em] text-gold-200 uppercase">
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
