import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFromRequest: vi.fn(),
  hasPro: vi.fn(),
}));

vi.mock("~/lib/billing/session-user", () => ({ userFromRequest: mocks.userFromRequest }));
vi.mock("~/lib/auth/entitlements", () => ({ hasPro: mocks.hasPro }));

import { handleProStatus } from "~/lib/pro/status";
import { Route } from "~/routes/api/pro/status";

const req = () =>
  new Request("https://divine.example/api/pro/status", { headers: { cookie: "session=abc" } });

type GetHandler = (ctx: { request: Request }) => Promise<Response>;
const routeGet = () =>
  (Route.options as unknown as { server: { handlers: { GET: GetHandler } } }).server.handlers.GET;

beforeEach(() => {
  mocks.userFromRequest.mockReset();
  mocks.hasPro.mockReset();
});

describe("GET /api/pro/status", () => {
  test("401 when signed out, without querying entitlements", async () => {
    mocks.userFromRequest.mockResolvedValue(null);
    const res = await handleProStatus(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ signedIn: false, pro: false });
    expect(mocks.hasPro).not.toHaveBeenCalled();
  });

  test("200 pro:false for a signed-in non-Pro user", async () => {
    mocks.userFromRequest.mockResolvedValue({ id: "u1", email: "a@b.c" });
    mocks.hasPro.mockResolvedValue(false);
    const res = await handleProStatus(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signedIn: true, pro: false });
    expect(mocks.hasPro).toHaveBeenCalledWith("u1");
  });

  test("200 pro:true for a Pro user", async () => {
    mocks.userFromRequest.mockResolvedValue({ id: "u2", email: "p@b.c" });
    mocks.hasPro.mockResolvedValue(true);
    const res = await handleProStatus(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signedIn: true, pro: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("503 and pro:false when the lookup fails (fail closed)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.userFromRequest.mockResolvedValue({ id: "u1", email: "a@b.c" });
    mocks.hasPro.mockRejectedValue(new Error("db down"));
    const res = await handleProStatus(req());
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect((await res.json()).pro).toBe(false);
  });

  test("503 session_unavailable (not 401) when the session lookup throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.userFromRequest.mockRejectedValue(new Error("db down"));
    const res = await handleProStatus(req());
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "session_unavailable", pro: false });
  });

  test("the registered route uses the session from the request", async () => {
    mocks.userFromRequest.mockResolvedValue({ id: "u2", email: "p@b.c" });
    mocks.hasPro.mockResolvedValue(true);
    const request = req();
    const res = await routeGet()({ request });
    expect(res.status).toBe(200);
    expect(mocks.userFromRequest).toHaveBeenCalledWith(request);
  });
});
