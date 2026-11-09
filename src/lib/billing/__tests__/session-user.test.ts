import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SessionLookupError, userFromRequest } from "../session-user";

const req = () => new Request("https://divine.example/api/pro/status", { headers: { cookie: "s=1" } });

beforeEach(() => {
  process.env.DATABASE_URL = "postgres://x";
  process.env.BETTER_AUTH_SECRET = "s".repeat(32);
});
afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.BETTER_AUTH_SECRET;
});

describe("userFromRequest", () => {
  test("returns the user for a valid session", async () => {
    const getSession = vi.fn(async () => ({ user: { id: "u1", email: "a@b.c" } }));
    expect(await userFromRequest(req(), getSession)).toEqual({ id: "u1", email: "a@b.c" });
  });

  test("null when there is no session", async () => {
    expect(await userFromRequest(req(), async () => null)).toBeNull();
  });

  test("null when auth is not configured (no lookup attempted)", async () => {
    delete process.env.DATABASE_URL;
    const getSession = vi.fn();
    expect(await userFromRequest(req(), getSession)).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
  });

  test("a DB/auth outage throws SessionLookupError instead of looking signed out", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      userFromRequest(req(), async () => { throw new Error("connect ECONNREFUSED"); }),
    ).rejects.toBeInstanceOf(SessionLookupError);
    spy.mockRestore();
  });
});
