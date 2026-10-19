import { describe, expect, test, vi } from "vitest";
import { hasPro } from "../entitlements";

describe("hasPro", () => {
  test("false when there are no entitlement rows", async () => {
    const db = { query: vi.fn(async (_q: string, _v: unknown[]) => ({ rows: [] as unknown[] })) };
    expect(await hasPro("u1", db)).toBe(false);
    expect(db.query.mock.calls[0][1]).toEqual(["u1"]);
    expect(db.query.mock.calls[0][0]).toMatch(/from entitlements/);
  });
  test("true when an active pro row exists", async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ "?column?": 1 }] })) };
    expect(await hasPro("u1", db)).toBe(true);
  });
  test("false for empty user id without querying", async () => {
    const db = { query: vi.fn() };
    expect(await hasPro("", db)).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });
});
