/**
 * QA round 6 (N2, N3): the Resend calls in gift-email.ts are bounded by a
 * timeout, classify 409s correctly, and send a deterministic body so a retry
 * under the same Idempotency-Key never trips Resend's "different payload" 409.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  RESEND_TIMEOUT_MS,
  classifyResend,
  sendGiftBuyerEmail,
  sendGiftEmail,
} from "~/lib/gift-email";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("GIFT_FROM_EMAIL", "Divine Insight <gifts@example.com>");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const recipient = {
  to: "friend@example.com",
  senderName: "Sam",
  note: "for you",
  claimUrl: "https://divine.example/claim/abc",
  idempotencyKey: "gift-recipient-1",
};
const buyer = {
  to: "buyer@example.com",
  recipientEmail: "friend@example.com",
  claimUrl: "https://divine.example/claim/abc",
  idempotencyKey: "gift-buyer-1",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("N2: Resend timeout", () => {
  test("timeout is 10-15 s", () => {
    expect(RESEND_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(RESEND_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });

  test.each([
    ["recipient", () => sendGiftEmail(recipient)],
    ["buyer", () => sendGiftBuyerEmail(buyer)],
  ])("a hung %s send is aborted and reported as failed", async (_name, send) => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          signal = init.signal ?? undefined;
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const pending = send();
    await vi.advanceTimersByTimeAsync(RESEND_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(signal?.aborted).toBe(true);
    await expect(pending).resolves.toBe("failed");
  });

  test("a fast response clears the timer (no abort later)", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return json(200, { id: "em_1" });
    });
    await expect(sendGiftEmail(recipient)).resolves.toBe("sent");
    await vi.advanceTimersByTimeAsync(RESEND_TIMEOUT_MS * 2);
    expect(signal?.aborted).toBe(false);
  });
});

describe("N3: Resend 409 handling", () => {
  test("invalid_idempotent_request (key reused, different body) is permanent", async () => {
    fetchMock.mockImplementation(async () => json(409, { name: "invalid_idempotent_request", message: "x" }));
    await expect(sendGiftEmail(recipient)).resolves.toBe("rejected");
    await expect(sendGiftBuyerEmail(buyer)).resolves.toBe("rejected");
  });

  test("concurrent_idempotent_requests is transient", async () => {
    fetchMock.mockResolvedValue(json(409, { name: "concurrent_idempotent_requests", message: "x" }));
    await expect(sendGiftEmail(recipient)).resolves.toBe("failed");
  });

  test("R7-1: resource_locked, unknown and unparseable 409s are transient (bounded by the cap)", async () => {
    fetchMock.mockImplementation(async () => json(409, { name: "resource_locked", message: "x" }));
    await expect(sendGiftEmail(recipient)).resolves.toBe("failed");
    fetchMock.mockImplementation(async () => json(409, { name: "something_new" }));
    await expect(sendGiftEmail(recipient)).resolves.toBe("failed");
    fetchMock.mockImplementation(async () => new Response("conflict", { status: 409 }));
    await expect(sendGiftBuyerEmail(buyer)).resolves.toBe("failed");
  });

  test("R7-2: 401 / 403 (bad or restricted key, unverified domain) are transient within the cap", async () => {
    fetchMock.mockImplementation(async () => json(401, { name: "missing_api_key" }));
    await expect(sendGiftEmail(recipient)).resolves.toBe("failed");
    fetchMock.mockImplementation(async () => json(403, { name: "invalid_api_key" }));
    await expect(sendGiftBuyerEmail(buyer)).resolves.toBe("failed");
  });

  test("a 422 (invalid address) stays permanent", async () => {
    fetchMock.mockImplementation(async () => json(422, { name: "validation_error" }));
    await expect(sendGiftEmail(recipient)).resolves.toBe("rejected");
  });

  test("classifyResend table", () => {
    expect(classifyResend(200)).toBe("sent");
    expect(classifyResend(202)).toBe("sent");
    expect(classifyResend(408)).toBe("failed");
    expect(classifyResend(429)).toBe("failed");
    expect(classifyResend(500)).toBe("failed");
    expect(classifyResend(503)).toBe("failed");
    expect(classifyResend(409, "concurrent_idempotent_requests")).toBe("failed");
    expect(classifyResend(409, "invalid_idempotent_request")).toBe("rejected");
    expect(classifyResend(409, "resource_locked")).toBe("failed");
    expect(classifyResend(409)).toBe("failed");
    expect(classifyResend(401)).toBe("failed");
    expect(classifyResend(403)).toBe("failed");
    expect(classifyResend(400)).toBe("rejected");
    expect(classifyResend(422)).toBe("rejected");
  });

  test("the request body is deterministic for the same input (safe to retry under one key)", async () => {
    fetchMock.mockResolvedValue(json(200, { id: "em" }));
    await sendGiftEmail(recipient);
    await sendGiftEmail({ ...recipient });
    await sendGiftBuyerEmail(buyer);
    await sendGiftBuyerEmail({ ...buyer });
    const bodies = fetchMock.mock.calls.map((c) => (c[1] as RequestInit).body);
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[2]).toBe(bodies[3]);
    const headers = fetchMock.mock.calls.map((c) => (c[1] as RequestInit).headers as Record<string, string>);
    expect(headers[0]["idempotency-key"]).toBe("gift-recipient-1");
    expect(headers[2]["idempotency-key"]).toBe("gift-buyer-1");
  });
});
