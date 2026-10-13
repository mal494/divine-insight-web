import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  getGeminiProxyAuthHeaderName,
  resetGeminiProxySecurityStateForTests,
} from "~/lib/gemini-proxy-security";
import { handleGeminiProxyPost } from "~/routes/api/gemini/v1beta/models/$modelAndOperation";

const BASE_ENV = {
  GEMINI_API_KEY: "test-gemini-key",
  GEMINI_PROXY_APP_TOKEN: "app-secret-token",
  GEMINI_ALLOWED_OPERATIONS: "generateContent",
  GEMINI_PROXY_RATE_LIMIT_MAX: "2",
  GEMINI_PROXY_RATE_LIMIT_WINDOW_MS: "60000",
  NODE_ENV: "test",
};

const GEMINI_PATH = "gemini-2.5-flash:generateContent";

function requestFor(args?: {
  token?: string | null;
  body?: string;
  ip?: string;
  contentType?: string;
}): Request {
  const headers: Record<string, string> = {
    "content-type": args?.contentType ?? "application/json",
    "x-forwarded-for": args?.ip ?? "203.0.113.10",
  };

  const token = args && "token" in args ? (args.token ?? null) : BASE_ENV.GEMINI_PROXY_APP_TOKEN;
  if (typeof token === "string") {
    headers[getGeminiProxyAuthHeaderName()] = token;
  }

  return new Request(`https://divine.example/api/gemini/v1beta/models/${GEMINI_PATH}`, {
    method: "POST",
    headers,
    body: args?.body ?? JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ping" }] }] }),
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("handleGeminiProxyPost", () => {
  beforeEach(() => {
    resetGeminiProxySecurityStateForTests();
    for (const key of [
      "GEMINI_API_KEY",
      "GEMINI_PROXY_APP_TOKEN",
      "GEMINI_ALLOWED_OPERATIONS",
      "GEMINI_ALLOWED_MODELS",
      "GEMINI_PROXY_MAX_REQUEST_BYTES",
      "GEMINI_PROXY_RATE_LIMIT_MAX",
      "GEMINI_PROXY_RATE_LIMIT_WINDOW_MS",
      "GEMINI_PROXY_RATE_LIMIT_PREFIX",
      "UPSTASH_REDIS_REST_URL",
      "UPSTASH_REDIS_REST_TOKEN",
      "NODE_ENV",
    ]) {
      delete process.env[key];
    }

    Object.assign(process.env, BASE_ENV);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("fails closed when shared app token is not configured", async () => {
    delete process.env.GEMINI_PROXY_APP_TOKEN;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await handleGeminiProxyPost(GEMINI_PATH, requestFor());
    const body = await readJson(response);

    expect(response.status).toBe(503);
    expect(body.error).toBe("gemini_proxy_auth_not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("rejects missing or invalid shared app token with 401", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const missingHeader = await handleGeminiProxyPost(GEMINI_PATH, requestFor({ token: null }));
    expect(missingHeader.status).toBe(401);
    expect((await readJson(missingHeader)).error).toBe("unauthorized");

    const wrongHeader = await handleGeminiProxyPost(GEMINI_PATH, requestFor({ token: "wrong-token" }));
    expect(wrongHeader.status).toBe(401);
    expect((await readJson(wrongHeader)).error).toBe("unauthorized");

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("fails closed in production when durable rate limiter is not configured", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await handleGeminiProxyPost(GEMINI_PATH, requestFor());
    const body = await readJson(response);

    expect(response.status).toBe(503);
    expect(body.error).toBe("gemini_proxy_rate_limit_not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("applies local in-memory fallback limiter in non-production environments", async () => {
    process.env.GEMINI_PROXY_RATE_LIMIT_MAX = "1";
    process.env.GEMINI_PROXY_RATE_LIMIT_WINDOW_MS = "60000";

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const first = await handleGeminiProxyPost(GEMINI_PATH, requestFor());
    expect(first.status).toBe(200);

    const second = await handleGeminiProxyPost(GEMINI_PATH, requestFor());
    const secondBody = await readJson(second);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("60");
    expect(secondBody.error).toBe("rate_limited");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("forwards authenticated requests upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ candidates: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await handleGeminiProxyPost(GEMINI_PATH, requestFor());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("candidates");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1beta/models/gemini-2.5-flash:generateContent");
    expect(url).toContain("key=test-gemini-key");
    expect(init.method).toBe("POST");
  });
});
