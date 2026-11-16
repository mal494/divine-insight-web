/**
 * claim-privacy.ts — keep gift claim tokens out of referrers, analytics and logs.
 *
 * A /claim/<token> URL is a bearer credential. Anything that records the URL
 * (a Referer header sent to Google Fonts, an analytics pageview, an access log
 * line) leaks the gift. Every surface that serves or observes claim URLs goes
 * through these helpers:
 *   - vercel-entry.ts / serve.ts add Referrer-Policy: no-referrer to every
 *     /claim/* and /api/claim/* response (vercel.json headers do not apply to
 *     this Build Output API deploy, so it is set in the handler).
 *   - the claim page also emits <meta name="referrer" content="no-referrer">.
 *   - the analytics loader never runs on a claim path.
 *   - redactClaimPath() is for any log line that must mention a path.
 *
 * Client-safe (no server imports).
 */
export const CLAIM_REFERRER_POLICY = "no-referrer";

/** True for the claim page and its API. */
export function isClaimPath(pathname: string): boolean {
  return /^\/(api\/)?claim(\/|$)/.test(pathname);
}

/** Headers to add to a response for `pathname`. Empty for non-claim paths. */
export function claimPrivacyHeaders(pathname: string): Record<string, string> {
  return isClaimPath(pathname) ? { "Referrer-Policy": CLAIM_REFERRER_POLICY } : {};
}

/** Replace the token segment of a claim path, for logs. */
export function redactClaimPath(pathname: string): string {
  return pathname.replace(/^(\/(?:api\/)?claim\/)[^/?#]+/, "$1[redacted]");
}
