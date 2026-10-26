/**
 * Minimal server-side Stripe REST client (fetch + form encoding). The repo
 * deliberately avoids the Stripe SDK (see lib/stripe-signature.ts), so the
 * few calls Pro needs go straight to the API with STRIPE_SECRET_KEY.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function encodeForm(params: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") {
      const nested = encodeForm(v as Record<string, unknown>, key);
      if (nested) parts.push(nested);
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.join("&");
}

export async function stripeRequest<T>(
  method: "GET" | "POST",
  path: string,
  params: Record<string, unknown> = {},
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  const body = encodeForm(params);
  const url = `https://api.stripe.com/v1${path}${method === "GET" && body ? `?${body}` : ""}`;
  const res = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: method === "POST" ? body : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(`stripe ${method} ${path} failed: ${res.status} ${json?.error?.message ?? ""}`);
  return json;
}
