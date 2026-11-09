/**
 * gift-validation.ts — shared by the gift form (client) and /api/checkout
 * (server), so both sides agree on what counts as a deliverable recipient.
 *
 * A gift is only useful if it can reach someone, so a Gift Reading cannot be
 * bought without a valid recipient email. This is deliberately a pragmatic
 * shape check (one "@", a dotted domain, no spaces), not RFC 5322: the goal is
 * to catch empty fields and typos before payment, not to reject real inboxes.
 */
export const MAX_RECIPIENT_EMAIL_LENGTH = 320;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/;

/** Trim and validate. Returns the normalized address, or null if invalid. */
export function normalizeRecipientEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_RECIPIENT_EMAIL_LENGTH) return null;
  if (!EMAIL_SHAPE.test(trimmed)) return null;
  const domain = trimmed.slice(trimmed.lastIndexOf("@") + 1);
  if (domain.startsWith(".") || domain.includes("..")) return null;
  return trimmed;
}

export function isValidRecipientEmail(value: unknown): boolean {
  return normalizeRecipientEmail(value) !== null;
}

/** Copy shown to the buyer beside the claim link on the confirmation view. */
export const SHARE_CLAIM_LINK_COPY = "Share this link with the person you're gifting";
