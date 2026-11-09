/**
 * Server-side kill switch for the Journal API. VITE_PRO_UI_ENABLED only hides
 * the Journal tab; a Pro user can still call /api/pro/journal* directly. The
 * routes therefore have their own gate:
 *   - PRO_JOURNAL_ENABLED off (default) -> 503 journal_disabled, before auth
 *     and before any DB access;
 *   - journal_entries missing (0003 not applied) -> 503, never a 500.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFromRequest: vi.fn(),
  hasPro: vi.fn(),
  queries: [] as string[],
  missingTable: false,
}));

const fakePool = {
  query: async (q: string) => {
    mocks.queries.push(q);
    if (mocks.missingTable) {
      throw Object.assign(new Error('relation "journal_entries" does not exist'), { code: "42P01" });
    }
    return { rows: [] };
  },
};

vi.mock("~/lib/billing/session-user", () => ({ userFromRequest: mocks.userFromRequest }));
vi.mock("~/lib/auth/entitlements", () => ({ hasPro: mocks.hasPro }));
vi.mock("~/lib/auth/db", () => ({ getAuthPool: () => fakePool }));

import { isJournalApiEnabled } from "~/lib/journal/handlers";
import { Route as ListRoute } from "~/routes/api/pro/journal";
import { Route as EntryRoute } from "~/routes/api/pro/journal.$entryId";

type H = (ctx: { request: Request; params?: Record<string, string> }) => Promise<Response>;
const h = (route: unknown) =>
  (route as { options: { server: { handlers: Record<string, H> } } }).options.server.handlers;

const ID = "00000000-0000-4000-8000-000000000001";
const url = (p = "") => `https://divine.example/api/pro/journal${p}`;
const calls: Array<[string, () => Promise<Response>]> = [
  ["GET /api/pro/journal", () => h(ListRoute).GET({ request: new Request(url()) })],
  [
    "POST /api/pro/journal",
    () =>
      h(ListRoute).POST({
        request: new Request(url(), { method: "POST", body: JSON.stringify({ title: "x" }) }),
      }),
  ],
  [
    "PATCH /api/pro/journal/:id",
    () =>
      h(EntryRoute).PATCH({
        params: { entryId: ID },
        request: new Request(url(`/${ID}`), { method: "PATCH", body: JSON.stringify({ note: "x" }) }),
      }),
  ],
  [
    "DELETE /api/pro/journal/:id",
    () =>
      h(EntryRoute).DELETE({
        params: { entryId: ID },
        request: new Request(url(`/${ID}`), { method: "DELETE" }),
      }),
  ],
];

beforeEach(() => {
  mocks.queries.length = 0;
  mocks.missingTable = false;
  // A signed-in Pro user: the case the UI flag alone cannot stop.
  mocks.userFromRequest.mockReset().mockResolvedValue({ id: "u_pro", email: "pro@example.com" });
  mocks.hasPro.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("PRO_JOURNAL_ENABLED", () => {
  test("only the exact string 'true' enables the API", () => {
    expect(isJournalApiEnabled({})).toBe(false);
    expect(isJournalApiEnabled({ PRO_JOURNAL_ENABLED: "" })).toBe(false);
    expect(isJournalApiEnabled({ PRO_JOURNAL_ENABLED: "1" })).toBe(false);
    expect(isJournalApiEnabled({ PRO_JOURNAL_ENABLED: "TRUE" })).toBe(false);
    expect(isJournalApiEnabled({ PRO_JOURNAL_ENABLED: "true" })).toBe(true);
  });

  test.each(calls)("%s -> 503 journal_disabled for a Pro user when unset (no auth, no DB)", async (_n, call) => {
    vi.stubEnv("PRO_JOURNAL_ENABLED", "");
    const res = await call();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "journal_disabled" });
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(mocks.userFromRequest).not.toHaveBeenCalled();
    expect(mocks.hasPro).not.toHaveBeenCalled();
    expect(mocks.queries).toHaveLength(0);
  });

  test.each(calls)("%s -> 503 journal_disabled when set to 'false'", async (_n, call) => {
    vi.stubEnv("PRO_JOURNAL_ENABLED", "false");
    expect((await call()).status).toBe(503);
  });

  test("the switch is read per request (flip without a rebuild)", async () => {
    vi.stubEnv("PRO_JOURNAL_ENABLED", "true");
    expect((await calls[0][1]()).status).toBe(200);
    vi.stubEnv("PRO_JOURNAL_ENABLED", "false");
    expect((await calls[0][1]()).status).toBe(503);
  });
});

describe("journal_entries missing (migration 0003 not applied)", () => {
  test.each(calls)("%s -> 503 schema_not_migrated, never 500", async (_n, call) => {
    vi.stubEnv("PRO_JOURNAL_ENABLED", "true");
    mocks.missingTable = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call();
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "journal_unavailable",
      reason: "schema_not_migrated",
    });
  });
});
