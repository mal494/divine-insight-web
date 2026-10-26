/**
 * Server-side Pro entitlement check. Rows are written only by the Pro
 * subscription webhook (lib/billing/subscription-webhook.ts). past_due keeps
 * access while Stripe retries (grace = until current_period_end).
 */
import { getAuthPool } from "./db";

type Queryable = { query: (text: string, values: unknown[]) => Promise<{ rows: unknown[] }> };

export async function hasPro(userId: string, db: Queryable = getAuthPool()): Promise<boolean> {
  if (!userId) return false;
  const { rows } = await db.query(
    `select 1 from entitlements
      where user_id = $1 and plan = 'pro' and status in ('active', 'trialing', 'past_due')
        and (current_period_end is null or current_period_end > now())
      limit 1`,
    [userId],
  );
  return rows.length > 0;
}
