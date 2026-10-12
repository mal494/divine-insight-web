/**
 * PremiumGate — hard hide for Pro-only surfaces.
 *
 * Until subscriptions are enforced server-side, non-premium visitors should
 * not see or reach Pro UI at all. Devs can still flip `isPremium` locally via
 * PremiumDevToggle for QA.
 */
import type { ReactNode } from "react";
import { useSubscription } from "~/context/SubscriptionContext";

type PremiumGateProps = {
  children: ReactNode;
};

export function PremiumGate({ children }: PremiumGateProps) {
  const { isPremium, loading } = useSubscription();
  if (loading || !isPremium) return null;
  return <>{children}</>;
}
