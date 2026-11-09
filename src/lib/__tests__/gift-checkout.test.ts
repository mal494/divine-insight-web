import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createOrder: vi.fn() }));

vi.mock("~/lib/orders", async () => {
  const actual = await vi.importActual<typeof import("~/lib/orders")>("~/lib/orders");
  return { ...actual, createOrder: mocks.createOrder };
});

import { validateGiftForm } from "~/components/gift-reading";
import { isValidRecipientEmail, normalizeRecipientEmail } from "~/lib/gift-validation";
import { handleCheckout } from "~/routes/api/checkout";

function post(body: unknown): Request {
  return new Request("https://divine.example/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("recipient email validation", () => {
  test("accepts ordinary addresses and trims them", () => {
    expect(normalizeRecipientEmail("  friend@example.com ")).toBe("friend@example.com");
    expect(isValidRecipientEmail("first.last+tag@sub.example.co.uk")).toBe(true);
  });

  test("rejects empty, missing and malformed addresses", () => {
    for (const bad of [
      undefined,
      null,
      42,
      "",
      "   ",
      "friend",
      "friend@",
      "@example.com",
      "friend@example",
      "friend@@example.com",
      "fr iend@example.com",
      "friend@.example.com",
      "friend@example..com",
      `${"a".repeat(320)}@example.com`,
    ]) {
      expect(isValidRecipientEmail(bad), String(bad)).toBe(false);
    }
  });

  test("the gift form refuses to open checkout without a valid email", () => {
    expect(validateGiftForm("")).toEqual({
      ok: false,
      error: "Add the email of the person you're gifting.",
    });
    expect(validateGiftForm("not-an-email").ok).toBe(false);
    expect(validateGiftForm(" friend@example.com ")).toEqual({
      ok: true,
      recipientEmail: "friend@example.com",
    });
  });
});

describe("POST /api/checkout", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.createOrder.mockResolvedValue("22222222-2222-4222-8222-222222222222");
  });

  test("rejects a gift with a missing recipient email before creating an order", async () => {
    const res = await handleCheckout(post({ sku: "giftReading", senderName: "Me" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_recipient_email" });
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });

  test("rejects a gift with an invalid recipient email", async () => {
    for (const recipientEmail of ["", "   ", "nope", "a@b"]) {
      const res = await handleCheckout(post({ sku: "giftReading", recipientEmail }));
      expect(res.status).toBe(400);
    }
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });

  test("a gift with a valid email checks out as before", async () => {
    const res = await handleCheckout(
      post({
        sku: "giftReading",
        recipientEmail: " friend@example.com ",
        senderName: " Me ",
        note: "Hi",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orderId: string; url: string };
    expect(body.orderId).toBe("22222222-2222-4222-8222-222222222222");
    expect(new URL(body.url).searchParams.get("client_reference_id")).toBe(body.orderId);
    expect(mocks.createOrder).toHaveBeenCalledWith("giftReading", {
      recipientEmail: "friend@example.com",
      senderName: "Me",
      note: "Hi",
    });
  });

  test("non-gift SKUs (readings) do not need an email and are unchanged", async () => {
    for (const sku of ["singleInsight", "extendedReading", "readingBundle"]) {
      const res = await handleCheckout(post({ sku }));
      expect(res.status).toBe(200);
    }
    expect(mocks.createOrder).toHaveBeenCalledWith("singleInsight", undefined);
  });
});
