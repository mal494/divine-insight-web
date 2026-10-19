import { createFileRoute } from "@tanstack/react-router";
import { safeCallbackPath } from "~/lib/auth/config";

// Interstitial: GETting this page does nothing, so email link scanners can't
// use up the one-time token. Only the button POST verifies it.
export const Route = createFileRoute("/auth/confirm")({
  validateSearch: (s: Record<string, unknown>) => ({
    token: typeof s.token === "string" ? s.token : "",
    callbackURL: safeCallbackPath(s.callbackURL),
  }),
  head: () => ({ meta: [{ name: "robots", content: "noindex" }, { name: "referrer", content: "no-referrer" }] }),
  component: Confirm,
});

function Confirm() {
  const { token, callbackURL } = Route.useSearch();
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-6 px-5 text-center">
      <h1 className="font-display text-3xl text-cream-50">Sign in to Divine Insight</h1>
      {token ? (
        <form method="post" action="/api/auth-confirm">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="callbackURL" value={callbackURL} />
          <button type="submit" className="rounded-full bg-gold-500 px-8 py-3 text-sm tracking-[0.2em] text-night-900 uppercase">
            Continue
          </button>
        </form>
      ) : (
        <p className="text-cream-100/70">This sign-in link is incomplete. <a className="underline" href="/signin">Request a new one</a>.</p>
      )}
    </main>
  );
}
