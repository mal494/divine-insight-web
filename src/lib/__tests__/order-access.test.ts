import { beforeEach, describe, expect, test, vi } from "vitest";

const db = vi.hoisted(() => ({ hashes: new Map<string, string | null>() }));

vi.mock("~/db", () => ({
  sql:
    () =>
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = strings.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
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
  checkOrderAccess,
  decideOrderAccess,
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
