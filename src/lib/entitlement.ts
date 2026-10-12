/**
 * entitlement.ts — the client half of the paywall.
 *
 * Deliberately dumb: it holds order ids, asks the server what those orders are
 * worth, and believes the answer. It never decides entitlement itself, so
 * editing anything in the browser (or in localStorage) buys nothing — an id is
 * just a lookup key, and an id for an unpaid order reads back `pending`.
 *
 * Flow:
 *   1. startCheckout() POSTs a SKU to /api/checkout, stores the returned order
 *      id, and opens Stripe in a new tab.
 *   2. While the visitor is paying, we poll /api/order/<id>. Stripe's webhook
 *      flips the order to paid, usually within a second or two of the receipt.
 *   3. Once `paid`, the draw unlocks. Ids persist in localStorage, so a
 *      bundle's remaining credits survive a refresh and a closed tab.
 *
 * One view can be unlocked by more than one SKU: the Extended Reading accepts
 * either its own purchase or a Reading Bundle, which is why this tracks a set
 * of SKUs rather than a single one and unlocks on whichever order is paid.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Sku } from "~/lib/payments";

const STORAGE_PREFIX = "di.order.";
const POLL_INTERVAL_MS = 3000;
/** Stop polling after 20 minutes of a tab left open on the Stripe step. */
const POLL_TIMEOUT_MS = 20 * 60 * 1000;

export type EntitlementStatus =
  | "locked"
  | "awaiting-payment"
  | "unlocked"
  | "spent"
  | "unavailable";

export type GiftDetails = {
  recipientEmail?: string;
  senderName?: string;
  note?: string;
};

export type CheckoutOptions = GiftDetails & {
  /** Buy a different SKU than the primary one (e.g. the bundle). */
  sku?: Sku;
};

export type Entitlement = {
  status: EntitlementStatus;
  /** Readings left on whichever order unlocked this view. */
  credits: number;
  /** Open Stripe and begin watching for the payment. */
  startCheckout: (options?: CheckoutOptions) => Promise<void>;
  /** Spend a credit and store the reading. Call once the cards are down. */
  recordReading: (reading: unknown) => Promise<void>;
  busy: boolean;
};

type OrderView = { status: string; credits: number };
export type EntitlementOrderSnapshot = {
  id: string;
  status: string;
  credits: number;
};

export function resolveEntitlementFromOrders(
  orders: EntitlementOrderSnapshot[],
): {
  status: EntitlementStatus;
  credits: number;
  activeOrderId: string | null;
  settled: boolean;
} {
  let best: EntitlementOrderSnapshot | null = null;
  let sawPending = false;

  for (const order of orders) {
    if (order.status === "paid") {
      // Prefer an order that still has credits; otherwise remember a spent one
      // so the UI can say "already drawn" rather than "locked".
      if (!best || (order.credits > 0 && best.credits === 0)) {
        best = order;
      }
      continue;
    }
    if (order.status === "pending") sawPending = true;
  }

  if (best && best.credits > 0) {
    return {
      status: "unlocked",
      credits: best.credits,
      activeOrderId: best.id,
      settled: true,
    };
  }
  if (best) {
    return { status: "spent", credits: 0, activeOrderId: best.id, settled: true };
  }
  if (sawPending) {
    return {
      status: "awaiting-payment",
      credits: 0,
      activeOrderId: null,
      settled: false,
    };
  }
  return { status: "locked", credits: 0, activeOrderId: null, settled: false };
}

export function useEntitlement(
  primary: Sku,
  options?: { alsoAccept?: Sku[] },
): Entitlement {
  const [status, setStatus] = useState<EntitlementStatus>("locked");
  const [credits, setCredits] = useState(0);
  const [busy, setBusy] = useState(false);

  /** Every SKU that can unlock this view, primary first. */
  const skusRef = useRef<Sku[]>([primary, ...(options?.alsoAccept ?? [])]);
  /** The order currently holding credits — the one recordReading spends from. */
  const activeOrderId = useRef<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartedAt = useRef<number>(0);

  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  /**
   * Re-read every stored order and settle on the best one. Returns true when
   * the picture is final (paid or gone), which is the signal to stop polling.
   */
  const refresh = useCallback(async (): Promise<boolean> => {
    const snapshots: EntitlementOrderSnapshot[] = [];

    for (const sku of skusRef.current) {
      const id = window.localStorage.getItem(STORAGE_PREFIX + sku);
      if (!id) continue;
      let view: OrderView | null = null;
      try {
        const res = await fetch(`/api/order/${id}`, { cache: "no-store" });
        if (res.status === 404) {
          // The order no longer exists (database reset, stale id). Forget it
          // rather than polling a ghost forever.
          window.localStorage.removeItem(STORAGE_PREFIX + sku);
          continue;
        }
        if (!res.ok) continue;
        view = (await res.json()) as OrderView;
      } catch {
        continue;
      }
      snapshots.push({ id, status: view.status, credits: view.credits });
    }

    const next = resolveEntitlementFromOrders(snapshots);
    activeOrderId.current = next.activeOrderId;
    setCredits(next.credits);
    setStatus(next.status);
    return next.settled;
  }, []);

  const beginPolling = useCallback(() => {
    stopPolling();
    pollStartedAt.current = Date.now();
    pollTimer.current = setInterval(() => {
      if (Date.now() - pollStartedAt.current > POLL_TIMEOUT_MS) {
        stopPolling();
        return;
      }
      void refresh().then((settled) => {
        if (settled) stopPolling();
      });
    }, POLL_INTERVAL_MS);
  }, [refresh, stopPolling]);

  // Pick up orders from a previous visit, and re-check whenever the tab
  // regains focus — that is exactly when someone comes back from paying.
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      stopPolling();
    };
  }, [refresh, stopPolling]);

  const startCheckout = useCallback(
    async (opts?: CheckoutOptions) => {
      const sku = opts?.sku ?? primary;
      setBusy(true);
      try {
        const res = await fetch("/api/checkout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sku,
            recipientEmail: opts?.recipientEmail,
            senderName: opts?.senderName,
            note: opts?.note,
          }),
        });
        if (!res.ok) {
          setStatus("unavailable");
          return;
        }
        const { orderId, url } = (await res.json()) as {
          orderId: string;
          url: string;
        };
        window.localStorage.setItem(STORAGE_PREFIX + sku, orderId);
        if (!skusRef.current.includes(sku)) skusRef.current.push(sku);
        setStatus("awaiting-payment");
        // Open before polling starts so the click stays inside the user
        // gesture and the popup blocker leaves it alone.
        window.open(url, "_blank", "noopener,noreferrer");
        beginPolling();
      } catch {
        setStatus("unavailable");
      } finally {
        setBusy(false);
      }
    },
    [beginPolling, primary],
  );

  const recordReading = useCallback(
    async (reading: unknown) => {
      const id = activeOrderId.current;
      if (!id) return;
      try {
        const res = await fetch("/api/reading", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orderId: id, reading }),
        });
        if (res.ok) {
          const { creditsLeft } = (await res.json()) as { creditsLeft: number };
          setCredits(creditsLeft);
          setStatus(creditsLeft > 0 ? "unlocked" : "spent");
        } else if (res.status === 402) {
          await refresh();
        }
      } catch {
        // A failed save must never swallow a reading the visitor is looking
        // at. Leave the UI as it is; the next refresh reconciles the credit.
      }
    },
    [refresh],
  );

  return { status, credits, startCheckout, recordReading, busy };
}
