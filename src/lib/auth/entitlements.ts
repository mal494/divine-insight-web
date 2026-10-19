/**
 * Server-side Pro entitlement check. Nothing writes to `entitlements` yet
 * (billing lands in a later milestone), so this is false for everyone today.
 */
import { getAuthPool } from "./db";

type Queryable = { query: (text: string, values: unknown[]) => Promise<{ rows: unknown[] }> };

export async function hasPro(userId: string, db: Queryable = getAuthPool()): Promise<boolean> {
  if (!userId) return false;
  const { rows } = await db.query(
    `select 1 from entitlements
      where user_id = $1 and plan = 'pro' and status in ('active', 'trialing')
        and (current_period_end is null or current_period_end > now())
      limit 1`,
    [userId],
  );
  return rows.length > 0;
}
