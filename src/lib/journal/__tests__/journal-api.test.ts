/**
 * Journal API: auth (401), non-Pro (403), Pro CRUD, and cross-user isolation.
 * Runs through the real route handlers and the real SQL store against a small
 * in-memory fake of journal_entries that honours the WHERE clauses.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

type Row = { id: string; user_id: string; title: string; spread: string | null; note: string; reading: unknown; created_at: Date; updated_at: Date };

const mocks = vi.hoisted(() => ({
  userFromRequest: vi.fn(),
  hasPro: vi.fn(),
  rows: [] as Row[],
  queries: [] as Array<{ q: string; v: unknown[] }>,
}));

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

const fakePool = {
  query: async (q: string, v: unknown[]) => {
    mocks.queries.push({ q, v });
    if (/^select .* from journal_entries where user_id = \$1/s.test(q)) {
      return { rows: mocks.rows.filter((r) => r.user_id === v[0]).sort((a, b) => +b.created_at - +a.created_at) };
    }
    if (/^insert into journal_entries/.test(q)) {
      const now = new Date(Date.now() + seq);
      const row: Row = { id: uuid(), user_id: v[0] as string, title: v[1] as string, spread: v[2] as string | null, note: v[3] as string, reading: v[4] == null ? null : JSON.parse(v[4] as string), created_at: now, updated_at: now };
      mocks.rows.push(row);
      return { rows: [row] };
    }
    if (/^update journal_entries set (.*) where id = \$1 and user_id = \$2/s.test(q)) {
      const row = mocks.rows.find((r) => r.id === v[0] && r.user_id === v[1]);
      if (!row) return { rows: [] };
      for (const m of q.matchAll(/(\w+) = \$(\d+)/g)) {
        const [, col, idx] = m;
        if (col === "id" || col === "user_id") continue;
        const val = v[Number(idx) - 1];
        (row as any)[col] = col === "reading" && typeof val === "string" ? JSON.parse(val) : val;
      }
      row.updated_at = new Date();
      return { rows: [row] };
    }
    if (/^delete from journal_entries where id = \$1 and user_id = \$2/.test(q)) {
      const i = mocks.rows.findIndex((r) => r.id === v[0] && r.user_id === v[1]);
      if (i < 0) return { rows: [] };
      const [row] = mocks.rows.splice(i, 1);
      return { rows: [{ id: row.id }] };
    }
    throw new Error(`unexpected query: ${q}`);
  },
};

vi.mock("~/lib/billing/session-user", () => ({ userFromRequest: mocks.userFromRequest }));
vi.mock("~/lib/auth/entitlements", () => ({ hasPro: mocks.hasPro }));
vi.mock("~/lib/auth/db", () => ({ getAuthPool: () => fakePool }));

import { Route as ListRoute } from "~/routes/api/pro/journal";
import { Route as EntryRoute } from "~/routes/api/pro/journal.$entryId";

type H = (ctx: { request: Request; params?: Record<string, string> }) => Promise<Response>;
const h = (route: unknown) => (route as { options: { server: { handlers: Record<string, H> } } }).options.server.handlers;

const USERS: Record<string, { id: string; email: string; pro: boolean }> = {
  alice: { id: "u_alice", email: "alice@example.com", pro: true },
  bob: { id: "u_bob", email: "bob@example.com", pro: true },
  free: { id: "u_free", email: "free@example.com", pro: false },
};

function as(who: keyof typeof USERS | null) {
  mocks.userFromRequest.mockImplementation(async () => (who ? { id: USERS[who].id, email: USERS[who].email } : null));
  mocks.hasPro.mockImplementation(async (id: string) => Object.values(USERS).some((u) => u.id === id && u.pro));
}

const url = (path = "") => `https://divine.example/api/pro/journal${path}`;
const list = () => h(ListRoute).GET({ request: new Request(url()) });
const create = (body: unknown) =>
  h(ListRoute).POST({ request: new Request(url(), { method: "POST", body: JSON.stringify(body) }) });
const patch = (id: string, body: unknown) =>
  h(EntryRoute).PATCH({ params: { entryId: id }, request: new Request(url(`/${id}`), { method: "PATCH", body: JSON.stringify(body) }) });
const del = (id: string) =>
  h(EntryRoute).DELETE({ params: { entryId: id }, request: new Request(url(`/${id}`), { method: "DELETE" }) });

beforeEach(() => {
  mocks.rows.length = 0;
  mocks.queries.length = 0;
  mocks.userFromRequest.mockReset();
  mocks.hasPro.mockReset();
});

describe("Journal API auth", () => {
  const someId = "00000000-0000-4000-8000-000000000999";
  test.each([
    ["GET list", () => list()],
    ["POST create", () => create({ title: "x" })],
    ["PATCH", () => patch(someId, { note: "x" })],
    ["DELETE", () => del(someId)],
  ])("%s -> 401 when signed out, no DB access", async (_n, call) => {
    as(null);
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "sign_in_required" });
    expect(mocks.queries).toHaveLength(0);
  });

  test.each([
    ["GET list", () => list()],
    ["POST create", () => create({ title: "x" })],
    ["PATCH", () => patch(someId, { note: "x" })],
    ["DELETE", () => del(someId)],
  ])("%s -> 403 for a signed-in non-Pro user, no DB access", async (_n, call) => {
    as("free");
    const res = await call();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "pro_required" });
    expect(mocks.queries).toHaveLength(0);
  });
});

describe("Journal API during a session outage", () => {
  test("503 session_unavailable (not 401), no DB access", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.userFromRequest.mockRejectedValue(new Error("db down"));
    const res = await list();
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "session_unavailable" });
    expect(mocks.queries).toHaveLength(0);
  });
});

describe("Journal API for Pro users", () => {
  test("create, list, update, delete own entries", async () => {
    as("alice");
    const c = await create({ title: "  Celtic Cross  ", spread: "celtic-cross", note: "soft", reading: { cards: ["The Star"] } });
    expect(c.status).toBe(201);
    const { entry } = await c.json();
    expect(entry).toMatchObject({ title: "Celtic Cross", spread: "celtic-cross", note: "soft", reading: { cards: ["The Star"] } });

    const l = await (await list()).json();
    expect(l.entries.map((e: { id: string }) => e.id)).toEqual([entry.id]);

    const u = await patch(entry.id, { note: "updated" });
    expect(u.status).toBe(200);
    expect((await u.json()).entry).toMatchObject({ id: entry.id, title: "Celtic Cross", note: "updated" });

    expect((await del(entry.id)).status).toBe(204);
    expect((await (await list()).json()).entries).toEqual([]);
  });

  test("validation", async () => {
    as("alice");
    expect((await create({})).status).toBe(400);
    expect((await create({ title: "   " })).status).toBe(400);
    expect((await create({ title: "x".repeat(121) })).status).toBe(400);
    expect((await create({ title: "ok", note: 5 })).status).toBe(400);
    expect((await create({ title: "ok", reading: { big: "x".repeat(17 * 1024) } })).status).toBe(413);
    const bad = await h(ListRoute).POST({ request: new Request(url(), { method: "POST", body: "{nope" }) });
    expect(bad.status).toBe(400);
    const { entry } = await (await create({ title: "ok" })).json();
    expect((await patch(entry.id, {})).status).toBe(400);
    expect((await patch("not-a-uuid", { note: "x" })).status).toBe(404);
  });
});

describe("Journal cross-user isolation", () => {
  test("users only ever see and change their own entries", async () => {
    as("alice");
    const { entry: a } = await (await create({ title: "Alice private" })).json();
    as("bob");
    const { entry: b } = await (await create({ title: "Bob private" })).json();

    // Bob's list never includes Alice's entry
    const bobList = await (await list()).json();
    expect(bobList.entries.map((e: { title: string }) => e.title)).toEqual(["Bob private"]);

    // Bob cannot update or delete Alice's entry: 404, and her row is untouched
    expect((await patch(a.id, { title: "pwned" })).status).toBe(404);
    expect((await del(a.id)).status).toBe(404);

    as("alice");
    const aliceList = await (await list()).json();
    expect(aliceList.entries).toEqual([expect.objectContaining({ id: a.id, title: "Alice private" })]);
    // and Alice can't touch Bob's
    expect((await del(b.id)).status).toBe(404);
    expect(mocks.rows.map((r) => r.title).sort()).toEqual(["Alice private", "Bob private"]);
  });

  test("every journal query is bound to the caller's user id", async () => {
    as("bob");
    const { entry } = await (await create({ title: "x" })).json();
    await list();
    await patch(entry.id, { note: "y" });
    await del(entry.id);
    expect(mocks.queries).toHaveLength(4);
    for (const { q, v } of mocks.queries) {
      expect(v).toContain("u_bob");
      if (!q.startsWith("insert")) expect(q).toMatch(/user_id = \$\d/);
    }
  });

  test("a user id in the request body is ignored", async () => {
    as("bob");
    const { entry } = await (await create({ title: "x", user_id: "u_alice", userId: "u_alice" })).json();
    expect(mocks.rows.find((r) => r.id === entry.id)?.user_id).toBe("u_bob");
  });
});
