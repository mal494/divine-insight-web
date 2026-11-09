/**
 * Regression guard for which server entry points are Pro-gated.
 *
 * Covers every API route under src/routes/api (including what each route
 * imports directly from ~/lib) and every createServerFn server function.
 * Any entry point that references requirePro / withPro / hasPro must be
 * declared below as Pro-GATED or Pro-AWARE (reads entitlement but is not
 * gated), so a new Pro check can't appear — or disappear — unnoticed.
 *
 * Today no Pro-only operation exists: Celtic Cross and 1-to-5 vector scoring
 * are not built, the Journal is client-only, and the three-card spread is
 * drawn client-side with no endpoint.
 *
 * Free / one-time-paid entry points must never be Pro-gated. Note this
 * asserts "no Pro check", not "no session": one-time orders are authorized by
 * the per-order access token issued at checkout (x-order-token, see
 * ~/lib/order-access), a separate product decision.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFromRequest: vi.fn(),
  hasPro: vi.fn(),
  saveReading: vi.fn(),
  getOrder: vi.fn(),
  listReadings: vi.fn(),
  checkOrderAccess: vi.fn(),
}));

vi.mock("~/lib/billing/session-user", () => ({ userFromRequest: mocks.userFromRequest }));
vi.mock("~/lib/auth/entitlements", () => ({ hasPro: mocks.hasPro }));
vi.mock("~/lib/order-access", () => ({
  checkOrderAccess: mocks.checkOrderAccess,
  orderTokenFrom: (request: Request) => request.headers.get("x-order-token"),
}));
vi.mock("~/lib/orders", () => ({
  saveReading: mocks.saveReading,
  getOrder: mocks.getOrder,
  listReadings: mocks.listReadings,
}));

import { Route as ReadingRoute } from "~/routes/api/reading";
import { Route as OrderRoute } from "~/routes/api/order.$orderId";
import { handleGeminiProxyPost } from "~/routes/api/gemini/v1beta/models/$modelAndOperation";

const SRC = join(process.cwd(), "src");
const API_DIR = join(SRC, "routes/api");

/** API routes that must enforce Pro (401 signed out / 403 not Pro). */
const PRO_GATED_ROUTES: string[] = [];

/** API routes that read the entitlement but are deliberately not gated by it. */
const PRO_AWARE_ROUTES = [
  "pro/checkout.ts", // refuses a second subscription (409) for existing Pro users
  "pro/status.ts", // reports hasPro to the signed-in user
];

/** Free or one-time-paid routes that must never require Pro. */
const NEVER_PRO_GATED = [
  "reading.ts",
  "order.$orderId.ts",
  "checkout.ts",
  "claim.$token.ts",
  "stripe-webhook.ts",
  "stripe-subscription-webhook.ts",
  "pro/portal.ts",
  "auth/$.ts",
  "auth-confirm.ts",
  "gemini/v1beta/models/$modelAndOperation.ts",
];

/** Every createServerFn module, and whether it is Pro-gated. */
const SERVER_FN_MODULES: Record<string, "gated" | "never"> = {
  "lib/auth/session.functions.ts": "never",
};

const PRO_SIGNAL = /\b(requirePro|withPro|hasPro)\b/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "__tests__" ? [] : walk(p);
    return /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
  });
}

const rel = (base: string, p: string) => relative(base, p).split("\\").join("/");
const read = (p: string) => readFileSync(p, "utf8");

/** Source of a file plus every ~/lib module it imports directly. */
function sourceWithDirectLibImports(file: string): string {
  const src = read(file);
  const libs = [...src.matchAll(/from\s+["']~\/(lib\/[^"']+)["']/g)].map((m) => m[1]);
  const resolved = libs
    .flatMap((l) => [`${l}.ts`, `${l}.tsx`, `${l}/index.ts`].map((c) => join(SRC, c)))
    .filter((p) => existsSync(p));
  return [src, ...resolved.map(read)].join("\n");
}

const routeFiles = walk(API_DIR).map((p) => rel(API_DIR, p));
const routeHasProSignal = (r: string) => PRO_SIGNAL.test(sourceWithDirectLibImports(join(API_DIR, r)));

describe("Pro route inventory", () => {
  test("every route referencing a Pro check is declared gated or aware, and vice versa", () => {
    const signalled = routeFiles.filter(routeHasProSignal).sort();
    expect(signalled).toEqual([...PRO_GATED_ROUTES, ...PRO_AWARE_ROUTES].sort());
  });

  test("gated routes use the guard (requirePro/withPro), not a bare hasPro", () => {
    for (const r of PRO_GATED_ROUTES) {
      expect(sourceWithDirectLibImports(join(API_DIR, r))).toMatch(/\b(requirePro|withPro)\b/);
    }
  });

  test("every route is classified", () => {
    const classified = new Set([...PRO_GATED_ROUTES, ...PRO_AWARE_ROUTES, ...NEVER_PRO_GATED]);
    expect(routeFiles.filter((r) => !classified.has(r))).toEqual([]);
  });

  test.each(NEVER_PRO_GATED)("%s has no Pro check", (r) => {
    expect(routeFiles).toContain(r);
    expect(routeHasProSignal(r)).toBe(false);
  });
});

describe("server function inventory", () => {
  // Modules that actually import createServerFn (comments mentioning it don't count).
  const IMPORTS_SERVER_FN = /import\s*\{[^}]*\bcreateServerFn\b[^}]*\}\s*from\s*["']@tanstack\/react-start["']/;
  const serverFnModules = walk(SRC)
    .filter((p) => IMPORTS_SERVER_FN.test(read(p)))
    .map((p) => rel(SRC, p));

  test("every createServerFn module is declared", () => {
    expect(serverFnModules.sort()).toEqual(Object.keys(SERVER_FN_MODULES).sort());
  });

  test.each(Object.entries(SERVER_FN_MODULES))("%s Pro check matches its declaration (%s)", (file, kind) => {
    const hasSignal = PRO_SIGNAL.test(sourceWithDirectLibImports(join(SRC, file)));
    expect(hasSignal).toBe(kind === "gated");
  });
});

type Handler = (ctx: { request: Request; params?: Record<string, string> }) => Promise<Response>;
const handlers = (route: unknown) =>
  (route as { options: { server: { handlers: Record<string, Handler> } } }).options.server.handlers;

const ORDER_TOKEN = "t".repeat(43);

describe("paid one-time readings keep working without Pro", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.userFromRequest.mockResolvedValue(null);
    mocks.hasPro.mockRejectedValue(new Error("must not consult Pro entitlements"));
    mocks.checkOrderAccess.mockResolvedValue("granted");
  });

  test("POST /api/reading spends an order credit for a signed-out, non-Pro visitor", async () => {
    mocks.saveReading.mockResolvedValue({ readingId: "r1", creditsLeft: 2 });
    const res = await handlers(ReadingRoute).POST({
      request: new Request("https://divine.example/api/reading", {
        method: "POST",
        headers: { "content-type": "application/json", "x-order-token": ORDER_TOKEN },
        body: JSON.stringify({ orderId: "o1", reading: { cards: [] } }),
      }),
    });
    expect(res.status).toBe(200);
    expect(mocks.checkOrderAccess).toHaveBeenCalledWith("o1", ORDER_TOKEN);
    expect(await res.json()).toEqual({ readingId: "r1", creditsLeft: 2 });
    expect(mocks.hasPro).not.toHaveBeenCalled();
  });

  test("GET /api/order/:id?include=readings works for a signed-out, non-Pro visitor", async () => {
    mocks.getOrder.mockResolvedValue({ id: "o1", status: "paid", kind: "extended", credits: 1 });
    mocks.listReadings.mockResolvedValue([{ id: "r1" }]);
    const res = await handlers(OrderRoute).GET({
      params: { orderId: "o1" },
      request: new Request("https://divine.example/api/order/o1?include=readings", {
        headers: { "x-order-token": ORDER_TOKEN },
      }),
    });
    expect(res.status).toBe(200);
    expect(mocks.checkOrderAccess).toHaveBeenCalledWith("o1", ORDER_TOKEN);
    expect((await res.json()).readings).toEqual([{ id: "r1" }]);
    expect(mocks.hasPro).not.toHaveBeenCalled();
  });
});

describe("Gemini proxy is app-token gated, not Pro gated", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    mocks.hasPro.mockReset();
    mocks.userFromRequest.mockReset();
    process.env = { ...saved, GEMINI_API_KEY: "k", GEMINI_PROXY_APP_TOKEN: "t".repeat(32) };
  });

  test("a request without the app token gets 401 from the app-token check; Pro is never consulted", async () => {
    const res = await handleGeminiProxyPost(
      "gemini-2.5-flash:generateContent",
      new Request("https://divine.example/api/gemini/v1beta/models/gemini-2.5-flash:generateContent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    process.env = saved;
    expect(res.status).toBe(401);
    expect(mocks.hasPro).not.toHaveBeenCalled();
    expect(mocks.userFromRequest).not.toHaveBeenCalled();
  });
});

describe("three-card spread stays free", () => {
  test("the free spread has no server endpoint to gate (client-side draw + synthesis)", () => {
    expect(routeFiles.some((f) => /three|spread|synth/i.test(f))).toBe(false);
  });
});
