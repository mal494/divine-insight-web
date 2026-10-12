import { describe, expect, test } from "vitest";
import { verifyStripeSignature } from "../stripe-signature";

async function sign(secret: string, payload: string, timestamp: number): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${payload}`),
  );
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("verifyStripeSignature", () => {
  test("accepts a valid v1 signature", async () => {
    const payload = JSON.stringify({ id: "evt_1" });
    const secret = "whsec_test";
    const now = 1_700_000_000;
    const signature = await sign(secret, payload, now);

    const result = await verifyStripeSignature({
      payload,
      secret,
      header: `t=${now},v1=${signature}`,
      nowSeconds: now,
    });

    expect(result).toEqual({ ok: true });
  });

  test("accepts any matching candidate during secret rotation", async () => {
    const payload = '{"type":"checkout.session.completed"}';
    const secret = "whsec_live";
    const now = 1_700_000_200;
    const good = await sign(secret, payload, now);

    const result = await verifyStripeSignature({
      payload,
      secret,
      header: `t=${now},v1=deadbeef,v1=${good},v1=not-it`,
      nowSeconds: now,
    });

    expect(result).toEqual({ ok: true });
  });

  test("rejects stale timestamps", async () => {
    const payload = "{}";
    const secret = "whsec_test";
    const sentAt = 1_700_000_000;
    const signature = await sign(secret, payload, sentAt);

    const result = await verifyStripeSignature({
      payload,
      secret,
      header: `t=${sentAt},v1=${signature}`,
      nowSeconds: sentAt + 301,
    });

    expect(result).toEqual({ ok: false, reason: "timestamp" });
  });

  test("rejects mismatched signatures", async () => {
    const payload = "{}";
    const secret = "whsec_test";
    const now = 1_700_001_000;

    const result = await verifyStripeSignature({
      payload,
      secret,
      header: `t=${now},v1=abc123`,
      nowSeconds: now,
    });

    expect(result).toEqual({ ok: false, reason: "mismatch" });
  });

  test("rejects malformed headers", async () => {
    const result = await verifyStripeSignature({
      payload: "{}",
      secret: "whsec_test",
      header: "v1=abc123",
    });

    expect(result).toEqual({ ok: false, reason: "malformed" });
  });
});
