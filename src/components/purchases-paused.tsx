/** Shown in place of paid checkout buttons while paid checkout is paused (~/lib/paid-checkout). */
import { PURCHASES_PAUSED_COPY } from "~/lib/paid-checkout";

export function PurchasesPaused({ className = "mt-6" }: { className?: string }) {
  return (
    <p
      role="status"
      data-testid="purchases-paused"
      className={`${className} text-center text-xs leading-relaxed text-cream-100/60 italic`}
    >
      {PURCHASES_PAUSED_COPY}
    </p>
  );
}
