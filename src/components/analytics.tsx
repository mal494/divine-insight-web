/**
 * Analytics — client-only loader for cookie-free traffic measurement.
 *
 * Injects the provider's script tag exactly once, but only when ANALYTICS is
 * enabled AND both fields are filled (see src/lib/analytics.ts). The tag
 * follows the standard GoatCounter shape —
 *   <script data-goatcounter="{dataAttribute}" async src="{scriptUrl}"></script>
 * — which any cookie-free provider with the same script-injection shape fits.
 *
 * The component renders nothing and mounts the script inside a useEffect, so
 * SSR output stays deterministic: no script tag is ever emitted from the
 * server, and hydration cannot mismatch.
 */
import { useEffect } from "react";
import { ANALYTICS, analyticsConfigured } from "~/lib/analytics";
import { isClaimPath } from "~/lib/claim-privacy";

/** Never load analytics on a gift claim page: the URL is a bearer token. */
export function shouldLoadAnalytics(pathname: string, configured: boolean): boolean {
  return configured && !isClaimPath(pathname);
}

export function Analytics() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!shouldLoadAnalytics(window.location.pathname, analyticsConfigured())) return;

    const script = document.createElement("script");
    script.src = ANALYTICS.scriptUrl;
    script.async = true;
    script.setAttribute("data-goatcounter", ANALYTICS.dataAttribute);
    document.head.appendChild(script);
  }, []);
  return null;
}