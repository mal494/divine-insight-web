/**
 * /claim/$token — where a gift recipient turns their card.
 *
 * Reached only from the email link. The token is the credential: no account,
 * no sign-in, single use. The page asks the API what the gift is, lets the
 * recipient turn one card, and posts the result back, which burns the token
 * and stores the reading. Re-opening the link afterwards shows the same card
 * again rather than drawing a new one, so it keeps working as a keepsake.
 *
 * SSR-safe: everything loads in an effect and the draw runs in an event
 * handler, so the server render is always deterministic.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { CardFace } from "~/components/card-face";
import { DECK, type TarotCard } from "~/data/deck";
import { shuffle } from "~/lib/random";
import { singleCardLine } from "~/lib/synthesis";

export const Route = createFileRoute("/claim/$token")({
  // The token in this URL is the recipient's credential: never send it as a
  // Referer to fonts or any other third party. (The response header is set
  // in vercel-entry.ts / serve.ts; this covers any host that misses it.)
  head: () => ({
    meta: [
      { name: "referrer", content: "no-referrer" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: ClaimPage,
});

const REVEAL_DELAY_MS = 450;
const FLIP_DONE_MS = 500;

type Claim = {
  senderName: string | null;
  note: string | null;
  claimed: boolean;
  reading: { card?: { id: string; name: string }; line?: string } | null;
};

type Status = "loading" | "ready" | "drawing" | "done" | "missing" | "expired" | "error";

/** Copy for an unclaimed link past GIFT_TOKEN_TTL_DAYS. Exported for tests. */
export const EXPIRED_TITLE = "This gift link has expired";
export const EXPIRED_BODY =
  "Please contact support and we'll reissue it for you — the gift itself isn't lost.";

function ClaimPage() {
  const { token } = Route.useParams();
  const [claim, setClaim] = useState<Claim | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [card, setCard] = useState<TarotCard | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [supportEmail, setSupportEmail] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/claim/${token}`, { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 404) {
          setStatus("missing");
          return;
        }
        if (res.status === 410) {
          const body = (await res.json().catch(() => ({}))) as { supportEmail?: string };
          setSupportEmail(typeof body.supportEmail === "string" ? body.supportEmail : null);
          setStatus("expired");
          return;
        }
        if (!res.ok) {
          setStatus("error");
          return;
        }
        const data = (await res.json()) as Claim;
        setClaim(data);
        if (data.claimed && data.reading?.card) {
          // Already turned — show the card it landed on, don't draw again.
          const saved = DECK.find((c) => c.id === data.reading?.card?.id) ?? null;
          setCard(saved);
          setRevealed(true);
          setStatus("done");
        } else {
          setStatus("ready");
        }
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const line = useMemo(() => {
    if (claim?.reading?.line) return claim.reading.line;
    return card && status === "done" ? singleCardLine(card) : null;
  }, [card, status, claim]);

  function turnCard() {
    if (status !== "ready") return;
    const drawn = shuffle(DECK)[0];
    setCard(drawn);
    setRevealed(false);
    setStatus("drawing");

    timers.current.push(setTimeout(() => setRevealed(true), REVEAL_DELAY_MS));
    timers.current.push(
      setTimeout(() => {
        setStatus("done");
        void fetch(`/api/claim/${token}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            reading: {
              spread: "gift",
              card: { id: drawn.id, name: drawn.name },
              line: singleCardLine(drawn),
              drawnAt: new Date().toISOString(),
            },
          }),
        });
      }, REVEAL_DELAY_MS + FLIP_DONE_MS),
    );
  }

  const sender = claim?.senderName?.trim() || "Someone";

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center px-5 py-16 text-center sm:px-8">
      {status === "loading" && (
        <p className="text-sm text-cream-100/50 italic">Opening your gift…</p>
      )}

      {status === "missing" && (
        <>
          <h1 className="font-display text-3xl font-medium tracking-[0.08em] text-cream-50">
            We couldn&rsquo;t find this gift
          </h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-cream-100/60">
            We couldn&rsquo;t find a gift for this link. Check that the whole
            link was copied, or ask the person who sent it to share it again.
          </p>
          <a
            href="/"
            className="mt-8 inline-flex items-center gap-2 rounded-full border border-gold-500/50 px-7 py-3 text-xs tracking-[0.14em] text-gold-300 uppercase transition hover:border-gold-400/80 hover:bg-gold-500/10"
          >
            Draw a free reading instead
          </a>
        </>
      )}

      {status === "expired" && <ExpiredGift supportEmail={supportEmail} />}

      {status === "error" && (
        <p className="text-sm text-cream-100/60">
          Something went wrong opening your gift. Please try the link again in a
          moment.
        </p>
      )}

      {(status === "ready" || status === "drawing" || status === "done") && (
        <>
          <p className="text-[10px] tracking-[0.45em] text-gold-400 uppercase">
            ✦ A gift for you ✦
          </p>
          <h1 className="mt-4 font-display text-4xl font-medium tracking-[0.08em] text-cream-50 sm:text-5xl">
            {sender} sent you a reading
          </h1>
          {claim?.note && (
            <p className="mx-auto mt-5 max-w-md text-[15px] leading-relaxed text-cream-100/75 italic">
              &ldquo;{claim.note}&rdquo;
            </p>
          )}

          {status === "ready" && (
            <>
              <p className="mx-auto mt-6 max-w-md text-sm leading-relaxed text-cream-100/60">
                One card, drawn for you from the full seventy-eight and read in
                full. Turn it whenever you are ready.
              </p>
              <button
                type="button"
                onClick={turnCard}
                className="group mt-8 inline-flex cursor-pointer items-center gap-3 rounded-full bg-gradient-to-b from-gold-300 via-gold-400 to-gold-500 px-9 py-4 text-sm font-medium tracking-[0.14em] text-night-950 uppercase shadow-[0_10px_40px_rgba(198,160,85,0.35)] transition hover:shadow-[0_12px_55px_rgba(198,160,85,0.55)] hover:brightness-105 active:scale-[0.98] sm:text-base"
              >
                <span>Turn your card</span>
                <span
                  aria-hidden
                  className="text-base transition-transform group-hover:rotate-45 sm:text-lg"
                >
                  ✦
                </span>
              </button>
            </>
          )}

          <div className="card-scene mt-10 aspect-[3/5] w-full max-w-[8.5rem] sm:max-w-[11rem]">
            <div className={`card-inner ${revealed ? "is-revealed" : ""}`}>
              <div aria-hidden className="card-face card-back" />
              <CardFace card={card} revealed={revealed} />
            </div>
          </div>

          {status === "done" && card && (
            <div className="animate-fade-in mt-6 w-full max-w-md min-w-0">
              <p className="font-display text-2xl text-gold-300">{card.name}</p>
              <p className="mt-1.5 text-[10px] leading-relaxed tracking-[0.12em] text-gold-400/80 uppercase sm:text-[11px]">
                {card.keywords.join(" · ")} · {card.element} · {card.astrology}
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
              <a
                href="/"
                className="mt-8 inline-flex items-center gap-2 rounded-full border border-gold-500/50 px-7 py-3 text-xs tracking-[0.14em] text-gold-300 uppercase transition hover:border-gold-400/80 hover:bg-gold-500/10"
              >
                Draw your own reading
              </a>
            </div>
          )}
        </>
      )}
    </main>
  );
}

/** Friendly view for an expired, unclaimed gift link. */
export function ExpiredGift({ supportEmail }: { supportEmail: string | null }) {
  return (
    <>
      <h1 className="font-display text-3xl font-medium tracking-[0.08em] text-cream-50">
        {EXPIRED_TITLE}
      </h1>
      <p className="mt-4 max-w-md text-sm leading-relaxed text-cream-100/60">
        {EXPIRED_BODY}
      </p>
      {supportEmail && (
        <a
          href={`mailto:${supportEmail}?subject=${encodeURIComponent("Expired gift link")}`}
          className="mt-6 inline-flex items-center gap-2 rounded-full border border-gold-500/50 px-7 py-3 text-xs tracking-[0.14em] text-gold-300 uppercase transition hover:border-gold-400/80 hover:bg-gold-500/10"
        >
          Contact support
        </a>
      )}
      <a
        href="/"
        className="mt-4 inline-flex items-center gap-2 rounded-full border border-gold-500/30 px-7 py-3 text-xs tracking-[0.14em] text-gold-300/80 uppercase transition hover:bg-gold-500/10"
      >
        Draw a free reading
      </a>
    </>
  );
}
