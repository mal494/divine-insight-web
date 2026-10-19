import { describe, expect, test } from "vitest";
import { buildAuthOptions } from "../auth";
import { authAllowedHosts, MAGIC_LINK_EXPIRES_IN_SECONDS, safeCallbackPath, toConfirmUrl } from "../config";

describe("auth config", () => {
  const opts = buildAuthOptions({} as never, { NODE_ENV: "production", BETTER_AUTH_SECRET: "x".repeat(32) });

  test("magic link only, no passwords", () => {
    expect(opts.emailAndPassword.enabled).toBe(false);
    expect(opts.plugins.map((p) => p.id)).toEqual(["magic-link", "tanstack-start-cookies"]);
  });

  test("tokens expire after 15 minutes and are hashed", () => {
    expect(MAGIC_LINK_EXPIRES_IN_SECONDS).toBe(900);
    const ml = opts.plugins[0] as unknown as { options: { expiresIn: number; storeToken: string } };
    expect(ml.options.expiresIn).toBe(900);
    expect(ml.options.storeToken).toBe("hashed");
  });

  test("rate limit stored in the database; https in production", () => {
    expect(opts.rateLimit).toEqual({ enabled: true, storage: "database" });
    expect(opts.baseURL.protocol).toBe("https");
  });

  test("allowedHosts covers project-scoped Vercel previews and BETTER_AUTH_URL", () => {
    const hosts = authAllowedHosts({ BETTER_AUTH_URL: "https://divineinsight.app", VERCEL_URL: "divine-insight-web-abc123-team.vercel.app" });
    expect(hosts).toContain("divine-insight-web-*.vercel.app");
    expect(hosts).toContain("divineinsight.app");
    expect(hosts).toContain("divine-insight-web-abc123-team.vercel.app");
    expect(hosts).not.toContain("*.vercel.app");
  });

  test("emailed link points at the interstitial, not the GET verify endpoint", () => {
    const url = toConfirmUrl("https://h.test/api/auth/magic-link/verify?token=abc&callbackURL=%2F");
    const u = new URL(url);
    expect(u.pathname).toBe("/auth/confirm");
    expect(u.searchParams.get("token")).toBe("abc");
  });

  test("callback paths are same-site only", () => {
    expect(safeCallbackPath("/x")).toBe("/x");
    expect(safeCallbackPath("//evil.com")).toBe("/");
    expect(safeCallbackPath("https://evil.com")).toBe("/");
    expect(safeCallbackPath(undefined)).toBe("/");
  });
});
