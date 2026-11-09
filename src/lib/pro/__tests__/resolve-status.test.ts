import { describe, expect, test, vi } from "vitest";
import { isProUiEnabled } from "../flags";
import {
  DEV_OVERRIDE_STORAGE_KEY,
  PRO_STATUS_PATH,
  readStorageOverride,
  resolvePremiumStatus,
  type FetchLike,
} from "../resolve-status";

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("VITE_PRO_UI_ENABLED (hidden by default)", () => {
  test.each([
    [{}, false],
    [{ VITE_PRO_UI_ENABLED: undefined }, false],
    [{ VITE_PRO_UI_ENABLED: "" }, false],
    [{ VITE_PRO_UI_ENABLED: "false" }, false],
    [{ VITE_PRO_UI_ENABLED: "1" }, false],
    [{ VITE_PRO_UI_ENABLED: "TRUE" }, false],
    [{ VITE_PRO_UI_ENABLED: true }, false],
    [{ VITE_PRO_UI_ENABLED: "true" }, true],
  ])("%j -> %s", (env, expected) => {
    expect(isProUiEnabled(env)).toBe(expected);
  });

  test("this test build has the flag off", () => {
    expect(isProUiEnabled()).toBe(false);
  });
});

describe("resolvePremiumStatus", () => {
  const base = { devOverrideEnabled: false, readDevOverride: () => null };

  test("flag off: false and the status endpoint is never called", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonRes({ pro: true }));
    expect(await resolvePremiumStatus({ ...base, proUiEnabled: false, fetchImpl })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("flag on: fetches the real status with the session cookie", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonRes({ signedIn: true, pro: true }));
    expect(await resolvePremiumStatus({ ...base, proUiEnabled: true, fetchImpl })).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(PRO_STATUS_PATH);
    expect(init?.credentials).toBe("same-origin");
    expect(init?.method).toBe("GET");
  });

  test("flag on: signed-in non-Pro -> false", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonRes({ signedIn: true, pro: false }));
    expect(await resolvePremiumStatus({ ...base, proUiEnabled: true, fetchImpl })).toBe(false);
  });

  test("flag on: signed out (401) -> false", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonRes({ signedIn: false, pro: false }, 401));
    expect(await resolvePremiumStatus({ ...base, proUiEnabled: true, fetchImpl })).toBe(false);
  });

  test("flag on: a 401/503 body claiming pro:true is still false", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonRes({ pro: true }, 503));
    expect(await resolvePremiumStatus({ ...base, proUiEnabled: true, fetchImpl })).toBe(false);
  });

  test("flag on: network error or malformed body -> false", async () => {
    const boom = vi.fn<FetchLike>(async () => { throw new Error("offline"); });
    expect(await resolvePremiumStatus({ ...base, proUiEnabled: true, fetchImpl: boom })).toBe(false);
    const garbage = vi.fn<FetchLike>(async () => new Response("<html>", { status: 200 }));
    expect(await resolvePremiumStatus({ ...base, proUiEnabled: true, fetchImpl: garbage })).toBe(false);
    const truthy = vi.fn<FetchLike>(async () => jsonRes({ pro: "yes" }));
    expect(await resolvePremiumStatus({ ...base, proUiEnabled: true, fetchImpl: truthy })).toBe(false);
  });

  test("flag on but no fetch (SSR) -> false", async () => {
    expect(await resolvePremiumStatus({ ...base, proUiEnabled: true })).toBe(false);
  });

  test("DEV override wins over the flag and the server", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonRes({ pro: false }));
    expect(
      await resolvePremiumStatus({ proUiEnabled: false, devOverrideEnabled: true, readDevOverride: () => true, fetchImpl }),
    ).toBe(true);
    expect(
      await resolvePremiumStatus({ proUiEnabled: true, devOverrideEnabled: true, readDevOverride: () => false, fetchImpl }),
    ).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("DEV with no override falls through to the flag/server path", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonRes({ pro: true }));
    expect(
      await resolvePremiumStatus({ proUiEnabled: true, devOverrideEnabled: true, readDevOverride: () => null, fetchImpl }),
    ).toBe(true);
  });

  test("production builds ignore the localStorage override", async () => {
    const readDevOverride = vi.fn(() => true);
    expect(
      await resolvePremiumStatus({ proUiEnabled: false, devOverrideEnabled: false, readDevOverride }),
    ).toBe(false);
    expect(readDevOverride).not.toHaveBeenCalled();
  });
});

describe("readStorageOverride", () => {
  const store = (v: string | null) => ({ getItem: (k: string) => (k === DEV_OVERRIDE_STORAGE_KEY ? v : null) });
  test("parses true/false and treats anything else as no override", () => {
    expect(readStorageOverride(store("true"))).toBe(true);
    expect(readStorageOverride(store("false"))).toBe(false);
    expect(readStorageOverride(store(null))).toBeNull();
    expect(readStorageOverride(store("1"))).toBeNull();
    expect(readStorageOverride(undefined)).toBeNull();
    expect(readStorageOverride({ getItem: () => { throw new Error("denied"); } })).toBeNull();
  });
});
