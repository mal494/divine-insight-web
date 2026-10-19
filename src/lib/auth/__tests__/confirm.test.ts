import { describe, expect, test, vi } from "vitest";
import { handleConfirmPost } from "../confirm";

const ORIGIN = "https://h.test";
function post(fields: Record<string, string>, origin = ORIGIN) {
  return new Request(`${ORIGIN}/api/auth-confirm`, { method: "POST", headers: { origin }, body: new URLSearchParams(fields) });
}
function verified() {
  const h = new Headers({ location: "/" });
  h.append("set-cookie", "better-auth.session_token=s; HttpOnly; SameSite=Lax; Path=/");
  return new Response(null, { status: 302, headers: h });
}

describe("confirm flow", () => {
  test("GET does not verify (scanner-safe)", async () => {
    const verify = vi.fn();
    const res = await handleConfirmPost(new Request(`${ORIGIN}/api/auth-confirm?token=t`), verify);
    expect(res.status).toBe(405);
    expect(verify).not.toHaveBeenCalled();
  });

  test("POST verifies once and forwards the session cookie", async () => {
    const verify = vi.fn(async (_t: string, _h: Headers) => verified());
    const res = await handleConfirmPost(post({ token: "t", callbackURL: "/x" }), verify);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0][0]).toBe("t");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/x");
    expect(res.headers.getSetCookie().join()).toContain("session_token");
  });

  test("invalid or used token goes back to sign-in", async () => {
    const verify = vi.fn(async () => new Response(null, { status: 302, headers: { location: "/?error=INVALID_TOKEN" } }));
    const res = await handleConfirmPost(post({ token: "t" }), verify);
    expect(res.headers.get("location")).toBe("/signin?error=invalid_link");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("cross-origin POST and open redirects are rejected", async () => {
    const verify = vi.fn(async (_t: string, _h: Headers) => verified());
    expect((await handleConfirmPost(post({ token: "t" }, "https://evil.test"), verify)).status).toBe(403);
    const res = await handleConfirmPost(post({ token: "t", callbackURL: "//evil.test" }), verify);
    expect(res.headers.get("location")).toBe("/");
  });

  test("missing token never calls verify", async () => {
    const verify = vi.fn();
    const res = await handleConfirmPost(post({}), verify);
    expect(verify).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe("/signin?error=invalid_link");
  });
});
