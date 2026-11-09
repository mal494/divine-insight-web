/**
 * Regression guard for which server routes are Pro-gated.
 *
 * Pro-gated today: the user-scoped Journal API (/api/pro/journal*). Celtic
 * Cross and 1-to-5 vector scoring are not built and have no endpoint. The
 * three-card spread is drawn and synthesized client-side with no endpoint.
 * When a Pro endpoint is added it must call requirePro/withPro and be listed
 * in PRO_GATED_ROUTES; free and paid one-time routes must never be gated.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFromRequest: vi.fn(),
  hasPro: vi.fn(),
  saveReading: vi.fn(),
  getOrder: vi.fn(),
  listReadings: vi.fn(),
}));

vi.mock("~/lib/billing/session-user", () => ({ userFromRequest: mocks.userFromRequest }));
vi.mock("~/lib/auth/entitlements", () => ({ hasPro: mocks.hasPro }));
vi.mock("~/lib/orders", () => ({
  saveReading: mocks.saveReading,
  getOrder: mocks.getOrder,
  listReadings: mocks.listReadings,
}));

import { Route as ReadingRoute } from "~/routes/api/reading";
import { Route as OrderRoute } from "~/routes/api/order.$orderId";

const API_DIR = join(process.cwd(), "src/routes/api");

/** Routes that must enforce Pro server-side (requirePro / withPro). */
const PRO_GATED_ROUTES: string[] = ["pro/journal.ts", "pro/journal.$entryId.ts"];

/** Free or one-time-paid routes that must never require Pro. */
const NEVER_PRO_GATED = [
  "reading.ts",
  "order.$orderId.ts",
  "checkout.ts",
  "claim.$token.ts",
  "stripe-webhook.ts",
  "stripe-subscription-webhook.ts",
  "pro/checkout.ts",
  "pro/portal.ts",
  "pro/status.ts",
  "auth/$.ts",
  "auth-confirm.ts",
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const routeFiles = walk(API_DIR).map((p) => relative(API_DIR, p).split("\\").join("/"));
/** Direct guard use, or a handler module whose handlers are all wrapped in withPro. */
const PRO_GUARD_PATTERN = /\b(requirePro|withPro)\b|~\/lib\/journal\/handlers/;
const usesProGuard = (rel: string) => PRO_GUARD_PATTERN.test(readFileSync(join(API_DIR, rel), "utf8"));

describe("Pro route inventory", () => {
  test("every route using the Pro guard is declared, and every declared route uses it", () => {
    const guarded = routeFiles.filter(usesProGuard).sort();
    expect(guarded).toEqual([...PRO_GATED_ROUTES].sort());
  });

  test.each(NEVER_PRO_GATED)("%s does not require Pro", (rel) => {
    expect(routeFiles).toContain(rel);
    expect(usesProGuard(rel)).toBe(false);
  });
});

type Handler = (ctx: { request: Request; params?: Record<string, string> }) => Promise<Response>;
const handlers = (route: unknown) =>
  (route as { options: { server: { handlers: Record<string, Handler> } } }).options.server.handlers;

describe("paid one-time readings keep working without a session or Pro", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.userFromRequest.mockRejectedValue(new Error("must not consult the session"));
    mocks.hasPro.mockRejectedValue(new Error("must not consult Pro entitlements"));
  });

  test("POST /api/reading spends an order credit with no session", async () => {
    mocks.saveReading.mockResolvedValue({ readingId: "r1", creditsLeft: 2 });
    const res = await handlers(ReadingRoute).POST({
      request: new Request("https://divine.example/api/reading", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId: "o1", reading: { cards: [] } }),
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ readingId: "r1", creditsLeft: 2 });
    expect(mocks.userFromRequest).not.toHaveBeenCalled();
    expect(mocks.hasPro).not.toHaveBeenCalled();
  });

  test("GET /api/order/:id?include=readings works with no session", async () => {
    mocks.getOrder.mockResolvedValue({ id: "o1", status: "paid", kind: "extended", credits: 1 });
    mocks.listReadings.mockResolvedValue([{ id: "r1" }]);
    const res = await handlers(OrderRoute).GET({
      params: { orderId: "o1" },
      request: new Request("https://divine.example/api/order/o1?include=readings"),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).readings).toEqual([{ id: "r1" }]);
    expect(mocks.userFromRequest).not.toHaveBeenCalled();
    expect(mocks.hasPro).not.toHaveBeenCalled();
  });
});

describe("three-card spread stays free", () => {
  test("the free spread has no server endpoint to gate (client-side draw + synthesis)", () => {
    expect(routeFiles.some((f) => /three|spread|synth/i.test(f))).toBe(false);
  });
});
