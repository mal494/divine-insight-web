import { useEffect, useState } from "react";
import { authClient } from "~/lib/auth/client";
import { getSessionUser, type SessionUser } from "~/lib/auth/session.functions";

/** Header sign-in / signed-in indicator. Loaded client-side so the home page SSR is unchanged. */
export function AuthIndicator() {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  useEffect(() => {
    getSessionUser().then(setUser, () => setUser(null));
  }, []);
  if (user === undefined) return null;
  if (!user) {
    return (
      <a href="/signin" className="text-[11px] tracking-[0.25em] text-cream-100/60 uppercase hover:text-cream-50">
        Sign in
      </a>
    );
  }
  return (
    <span className="flex items-center gap-2 text-[11px] text-cream-100/70">
      <span title={user.email} aria-label={`Signed in as ${user.email}`}>● {user.email}</span>
      <button
        type="button"
        className="underline"
        onClick={async () => {
          await authClient.signOut();
          setUser(null);
        }}
      >
        Sign out
      </button>
    </span>
  );
}
