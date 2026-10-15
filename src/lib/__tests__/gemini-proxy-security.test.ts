import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redisConstructor: vi.fn(),
  redisEval: vi.fn(),
}));

vi.mock("@upstash/redis", () => ({
  Redis: class MockRedis {
    constructor(args: { url: string; token: string }) {
      mocks.redisConstructor(args);
    }

    eval(...args: unknown[]) {
      return mocks.redisEval(...args);
    }
  },
}));

import {
  enforceGeminiProxyRateLimit,
  resetGeminiProxySecurityStateForTests,
} from "~/lib/gemini-proxy-security";

function productionEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    GEMINI_PROXY_RATE_LIMIT_MAX: "20",
    GEMINI_PROXY_RATE_LIMIT_WINDOW_MS: "60000",
    ...overrides,
  };
}

describe("enforceGeminiProxyRateLimit redis credential selection", () => {
  beforeEach(() => {
    resetGeminiProxySecurityStateForTests();
    vi.resetAllMocks();
    mocks.redisEval.mockResolvedValue([1, 60000]);
  });

  test("prefers UPSTASH_REDIS_REST_* credentials when both providers are present", async () => {
    const result = await enforceGeminiProxyRateLimit({
      tokenFingerprint: "token-fingerprint",
      clientAddress: "203.0.113.10",
      env: productionEnv({
        UPSTASH_REDIS_REST_URL: "https://upstash-primary.example.com",
        UPSTASH_REDIS_REST_TOKEN: "upstash-write-token",
        KV_REST_API_URL: "https://kv-fallback.example.com",
        KV_REST_API_TOKEN: "kv-write-token",
        KV_REST_API_READ_ONLY_TOKEN: "kv-read-only-token",
      }),
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.redisConstructor).toHaveBeenCalledTimes(1);
    expect(mocks.redisConstructor).toHaveBeenCalledWith({
      url: "https://upstash-primary.example.com",
      token: "upstash-write-token",
    });
  });

  test("falls back to KV_REST_API_URL + KV_REST_API_TOKEN when UPSTASH_REDIS_REST_* is absent", async () => {
    const result = await enforceGeminiProxyRateLimit({
      tokenFingerprint: "token-fingerprint",
      clientAddress: "203.0.113.10",
      env: productionEnv({
        KV_REST_API_URL: "https://kv-fallback.example.com",
        KV_REST_API_TOKEN: "kv-write-token",
        KV_REST_API_READ_ONLY_TOKEN: "kv-read-only-token",
      }),
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.redisConstructor).toHaveBeenCalledTimes(1);
    expect(mocks.redisConstructor).toHaveBeenCalledWith({
      url: "https://kv-fallback.example.com",
      token: "kv-write-token",
    });
  });

  test("does not treat KV_REST_API_READ_ONLY_TOKEN as a writable limiter credential", async () => {
    const result = await enforceGeminiProxyRateLimit({
      tokenFingerprint: "token-fingerprint",
      clientAddress: "203.0.113.10",
      env: productionEnv({
        KV_REST_API_URL: "https://kv-fallback.example.com",
        KV_REST_API_READ_ONLY_TOKEN: "kv-read-only-token",
      }),
    });

    expect(result).toEqual({ ok: false, kind: "not_configured" });
    expect(mocks.redisConstructor).not.toHaveBeenCalled();
  });
});
