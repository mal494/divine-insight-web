import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getClaim: vi.fn(), claimGift: vi.fn() }));
vi.mock("~/lib/gifts", () => ({ getClaim: mocks.getClaim, claimGift: mocks.claimGift }));

import { Route } from "~/routes/api/claim.$token";

type Handlers = {
  GET: (ctx: { params: { token: string } }) => Promise<Response>;
  POST: (ctx: { params: { token: string }; request: Request }) => Promise<Response>;
};
const handlers = (Route.options as unknown as { server: { handlers: Handlers } }).server
  .handlers;
const TOKEN = "d".repeat(32);

describe("/api/claim/$token for a valid paid token", () => {
  beforeEach(() => vi.resetAllMocks());

  test("a gift bought without a recipient email opens normally (no error)", async () => {
    mocks.getClaim.mockResolvedValue({ senderName: null, note: null, claimed: false, reading: null });
    const res = await handlers.GET({ params: { token: TOKEN } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ senderName: null, note: null, claimed: false, reading: null });
  });

  test("turning the card burns the token once", async () => {
    mocks.claimGift.mockResolvedValueOnce({ ok: true });
    const res = await handlers.POST({
      params: { token: TOKEN },
      request: new Request("https://divine.example/api/claim/x", {
        method: "POST",
        body: JSON.stringify({ reading: { card: { id: "the-fool", name: "The Fool" } } }),
      }),
    });
    expect(res.status).toBe(200);
  });
});
