/**
 * CardFace — the revealed face of a card.
 *
 * Majors (and any card listed in ART_IDS) render their artwork image; every
 * other card falls back to the glyph placeholder — so the next art drop needs
 * no component changes, only files + ART_IDS. Shared by the free three-card
 * draw, the Extended Reading, and the Gift Reading.
 */
import { useEffect, useState } from "react";
import { artUrlFor } from "~/data/artwork";
import type { TarotCard } from "~/data/deck";

/** Glyph tint per suit element — all from the brand palette (never new hues). */
export const GLYPH_COLOR: Record<string, string> = {
  Fire: "#a37f3e", // gold-600
  Water: "#3a2d72", // night-600
  Air: "#2b2157", // night-700
  Earth: "#c6a055", // gold-500
};

export function CardFace({
  card,
  revealed = true,
}: {
  card: TarotCard | null;
  /** Whether the card is face-up. Reserved for reveal-gated rendering; the flip animation itself is handled by the parent. */
  revealed?: boolean;
}) {
  void revealed;
  const [artBroken, setArtBroken] = useState(false);
  const artUrl = card ? artUrlFor(card.id) : null;
  const showArt = !!(card && artUrl && !artBroken);

  useEffect(() => {
    setArtBroken(false);
  }, [card?.id]);

  return (
    <div aria-hidden className="card-face card-face--front card-front">
      {/* Placeholder layer: glyph on parchment (visible for minors, and as a
          graceful fallback if an artwork image ever fails to load) */}
      {card && (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-2 sm:gap-3">
          <span
            className="text-4xl leading-none sm:text-6xl"
            style={
              card.element
                ? { color: GLYPH_COLOR[card.element] ?? "#a37f3e" }
                : undefined
            }
          >
            {card.symbol}
          </span>
        </div>
      )}

      {/* Artwork layer: sits over the placeholder; hides itself if the image fails */}
      {showArt && (
        <img
          src={artUrl!}
          alt=""
          className="card-art-img"
          onError={() => setArtBroken(true)}
        />
      )}

      {/* Name banner — cream strip, Cormorant small caps, per the brand spec */}
      {card && (
        <div className="card-name-banner">
          {!artUrl && <span>{card.symbol} </span>}
          {card.name}
        </div>
      )}
    </div>
  );
}
