/**
 * PremiumGate — hard hide for Pro-only surfaces.
 *
 * Renders children only once SubscriptionContext has resolved and says the
 * visitor has Pro. That requires the Pro UI flag (VITE_PRO_UI_ENABLED=true,
 * default off) plus a real entitlement from GET /api/pro/status — or, in Vite
 * dev only, the PremiumDevToggle override.
 *
 * This is presentation only. Pro server operations are enforced separately
 * with requirePro() (src/lib/auth/require-pro.ts).
 */
import type { ReactNode } from "react";
import { useSubscription } from "~/context/SubscriptionContext";

type PremiumGateProps = {
  children: ReactNode;
};

export function shouldRenderPremium(state: { isPremium: boolean; loading: boolean }): boolean {
  return !state.loading && state.isPremium;
}

export function PremiumGate({ children }: PremiumGateProps) {
  const state = useSubscription();
  if (!shouldRenderPremium(state)) return null;
  return <>{children}</>;
}
