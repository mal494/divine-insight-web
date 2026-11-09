import { beforeEach, describe, expect, test, vi } from "vitest";

const db = vi.hoisted(() => ({
  hashes: new Map<string, string | null>(),
  missing: null as null | string,
}));

vi.mock("~/db", () => ({
  sql:
    () =>
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = strings.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
      if (db.missing)
        throw Object.assign(new Error("schema missing"), { code: db.missing });
      if (q.startsWith("create") || q.startsWith("alter")) {
        throw new Error(`order access must never run DDL: ${q}`);
      }
      if (q.startsWith("create") || q.startsWith("alter")) return [];
      if (q.startsWith("select access_token_hash from orders where id =")) {
        const id = String(values[0]);
        return db.hashes.has(id)
          ? [{ access_token_hash: db.hashes.get(id) }]
          : [];
      }
      throw new Error(`unexpected query: ${q}`);
    },
}));

import {
  OrderSchemaMissingError,
  checkOrderAccess,
  decideOrderAccess,
  legacyAccessOpen,
  hashOrderToken,
  isOrderToken,
  newOrderAccessToken,
} from "~/lib/order-access";

const ORDER = "11111111-1111-4111-8111-111111111111";
const LEGACY = "22222222-2222-4222-8222-222222222222";

describe("order access tokens", () => {
  test("tokens are 256-bit base64url, unique, and only the hash is derived", () => {
    const a = newOrderAccessToken();
    const b = newOrderAccessToken();
    expect(isOrderToken(a.token)).toBe(true);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashOrderToken(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).not.toContain(a.token);
  });

  test("decideOrderAccess", () => {
    const { token, hash } = newOrderAccessToken();
    const other = newOrderAccessToken().token;
    expect(decideOrderAccess(hash, token)).toBe("granted");
    expect(decideOrderAccess(hash, other)).toBe("denied");
    expect(decideOrderAccess(hash, null)).toBe("denied");
    expect(decideOrderAccess(hash, "")).toBe("denied");
    expect(decideOrderAccess(hash, hash)).toBe("denied"); // the stored hash is not a credential
    expect(decideOrderAccess(null, null)).toBe("legacy");
    expect(decideOrderAccess(undefined, token)).toBe("denied");
  });
});

describe("checkOrderAccess", () => {
  let token: string;
  beforeEach(() => {
    db.hashes.clear();
    db.missing = null;
    const t = newOrderAccessToken();
    token = t.token;
    db.hashes.set(ORDER, t.hash);
    db.hashes.set(LEGACY, null);
  });

  test("grants the token holder", async () => {
    expect(await checkOrderAccess(ORDER, token)).toBe("granted");
  });

  test("denies the bare order id (what leaks via Stripe client_reference_id)", async () => {
    expect(await checkOrderAccess(ORDER, null)).toBe("denied");
    expect(await checkOrderAccess(ORDER, newOrderAccessToken().token)).toBe(
      "denied",
    );
  });

  test("grandfathers pre-token orders", async () => {
    expect(await checkOrderAccess(LEGACY, null)).toBe("legacy");
  });

  test("denies unknown and malformed ids without querying", async () => {
    expect(
      await checkOrderAccess("33333333-3333-4333-8333-333333333333", token),
    ).toBe("denied");
    expect(await checkOrderAccess("not-a-uuid", token)).toBe("denied");
    expect(await checkOrderAccess(`${ORDER}'--`, token)).toBe("denied");
  });
});

describe("schema not migrated", () => {
  test.each(["42703", "42P01"])(
    "Postgres %s fails closed with OrderSchemaMissingError",
    async (code) => {
      db.missing = code;
      await expect(
        checkOrderAccess(ORDER, newOrderAccessToken().token),
      ).rejects.toBeInstanceOf(OrderSchemaMissingError);
      db.missing = null;
    },
  );
});

describe("LEGACY_ORDER_ACCESS_UNTIL (legacy sunset)", () => {
  const now = new Date("2027-01-01T00:00:00Z");

  test("unset or blank keeps legacy id-only access open", () => {
    expect(legacyAccessOpen({}, now)).toBe(true);
    expect(legacyAccessOpen({ LEGACY_ORDER_ACCESS_UNTIL: "  " }, now)).toBe(
      true,
    );
  });

  test("open before the cutoff, closed at and after it", () => {
    expect(
      legacyAccessOpen({ LEGACY_ORDER_ACCESS_UNTIL: "2027-02-01" }, now),
    ).toBe(true);
    expect(
      legacyAccessOpen(
        { LEGACY_ORDER_ACCESS_UNTIL: "2027-01-01T00:00:00Z" },
        now,
      ),
    ).toBe(false);
    expect(
      legacyAccessOpen({ LEGACY_ORDER_ACCESS_UNTIL: "2026-12-01" }, now),
    ).toBe(false);
  });

  test("an unparseable value fails closed", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      legacyAccessOpen({ LEGACY_ORDER_ACCESS_UNTIL: "next spring" }, now),
    ).toBe(false);
  });

  test("closed legacy access denies pre-token orders but not token holders", async () => {
    db.hashes.clear();
    db.missing = null;
    const t = newOrderAccessToken();
    db.hashes.set(ORDER, t.hash);
    db.hashes.set(LEGACY, null);
    const closed = { LEGACY_ORDER_ACCESS_UNTIL: "2000-01-01" };
    expect(await checkOrderAccess(LEGACY, null, closed)).toBe("denied");
    expect(await checkOrderAccess(ORDER, t.token, closed)).toBe("granted");
    expect(decideOrderAccess(null, null, false)).toBe("denied");
  });
});
