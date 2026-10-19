import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "~/lib/auth/client";
import { getSessionUser } from "~/lib/auth/session.functions";

export const Route = createFileRoute("/signin")({
  validateSearch: (s: Record<string, unknown>) => ({
    error: typeof s.error === "string" ? s.error : undefined,
  }),
  loader: () => getSessionUser(),
  head: () => ({ meta: [{ title: "Sign in — Divine Insight" }, { name: "robots", content: "noindex" }] }),
  component: SignIn,
});

function SignIn() {
  const user = Route.useLoaderData();
  const { error } = Route.useSearch();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");

  if (user) {
    return (
      <Shell>
        <p className="text-cream-100/80">Signed in as {user.email}.</p>
        <button
          type="button"
          className="underline"
          onClick={async () => {
            await authClient.signOut();
            window.location.assign("/");
          }}
        >
          Sign out
        </button>
        <a className="underline" href="/">Back to readings</a>
      </Shell>
    );
  }

  if (state === "sent") {
    return (
      <Shell>
        <h1 className="font-display text-3xl text-cream-50">Check your email</h1>
        <p className="text-cream-100/70">
          We sent a sign-in link to {email}. It expires in 15 minutes.
        </p>
        <button type="button" className="underline" onClick={() => setState("idle")}>Use a different email</button>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="font-display text-3xl text-cream-50">Sign in</h1>
      {error && <p role="alert" className="text-red-300">That link is invalid or expired. Request a new one.</p>}
      <form
        className="flex w-full flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setState("sending");
          const { error: err } = await authClient.signIn.magicLink({ email, callbackURL: "/" });
          setState(err ? "failed" : "sent");
        }}
      >
        <label className="sr-only" htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="rounded-full border border-white/10 bg-night-900/60 px-5 py-3 text-cream-50"
        />
        <button
          type="submit"
          disabled={state === "sending"}
          className="rounded-full bg-gold-500 px-8 py-3 text-sm tracking-[0.2em] text-night-900 uppercase disabled:opacity-60"
        >
          {state === "sending" ? "Sending…" : "Email me a link"}
        </button>
        {state === "failed" && <p role="alert" className="text-red-300">Couldn't send the link. Try again in a minute.</p>}
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-5 px-5 text-center">
      {children}
    </main>
  );
}
