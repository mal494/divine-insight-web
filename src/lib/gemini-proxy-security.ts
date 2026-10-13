import { createHash, timingSafeEqual } from "node:crypto";
import { Redis } from "@upstash/redis";

const DEFAULT_RATE_LIMIT_MAX = 20;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_PREFIX = "gemini-proxy:v1";
const AUTH_HEADER = "x-divine-app-token";

const REDIS_RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local max_requests = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local count = redis.call("INCR", key)
if count == 1 then
  redis.call("PEXPIRE", key, window_ms)
end
local ttl_ms = redis.call("PTTL", key)
if ttl_ms < 0 then
  ttl_ms = window_ms
end
if count > max_requests then
  return {0, ttl_ms}
end
return {1, ttl_ms}
`;

type MemoryRateLimitBucket = {
  windowStartMs: number;
  count: number;
};

type MemoryRateLimitState = {
  buckets: Map<string, MemoryRateLimitBucket>;
  lastCleanupMs: number;
};

type RateLimitMode = "redis" | "memory" | "disabled";

type RateLimitConfig = {
  max: number;
  windowMs: number;
  keyPrefix: string;
  mode: RateLimitMode;
};

type RateLimitAllowed = { ok: true };
type RateLimited = { ok: false; kind: "rate_limited"; retryAfterSeconds: number };
type RateLimitUnavailable = { ok: false; kind: "not_configured" | "unavailable" };

export type GeminiRateLimitResult = RateLimitAllowed | RateLimited | RateLimitUnavailable;

export type GeminiAuthResult =
  | { ok: true; tokenFingerprint: string }
  | { ok: false; kind: "not_configured" | "unauthenticated" };

type GlobalWithGeminiProxy = typeof globalThis & {
  __geminiProxyMemoryState?: MemoryRateLimitState;
  __geminiProxyRedisClient?:
    | {
        cacheKey: string;
        client: Redis;
      }
    | undefined;
};

export function getGeminiProxyAuthHeaderName(): string {
  return AUTH_HEADER;
}

export function authenticateGeminiProxyRequest(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): GeminiAuthResult {
  const configuredToken = env.GEMINI_PROXY_APP_TOKEN?.trim();
  if (!configuredToken) return { ok: false, kind: "not_configured" };

  const providedToken = request.headers.get(AUTH_HEADER)?.trim();
  if (!providedToken) return { ok: false, kind: "unauthenticated" };
  if (!constantTimeEqual(providedToken, configuredToken)) {
    return { ok: false, kind: "unauthenticated" };
  }

  return { ok: true, tokenFingerprint: digestHex(providedToken) };
}

export async function enforceGeminiProxyRateLimit(args: {
  tokenFingerprint: string;
  clientAddress: string;
  nowMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<GeminiRateLimitResult> {
  const env = args.env ?? process.env;
  const config = readRateLimitConfig(env);
  const nowMs = args.nowMs ?? Date.now();
  const key = rateLimitKey(config, args.tokenFingerprint, args.clientAddress);

  if (config.mode === "disabled") {
    return { ok: false, kind: "not_configured" };
  }

  if (config.mode === "memory") {
    return enforceMemoryRateLimit(key, config, nowMs);
  }

  try {
    const redis = getRedisClient(env);
    const response = await redis.eval(REDIS_RATE_LIMIT_SCRIPT, [key], [
      String(config.max),
      String(config.windowMs),
    ]);
    const [allowedRaw, ttlRaw] = parseRedisEvalResponse(response);
    if (allowedRaw === 1) return { ok: true };
    return {
      ok: false,
      kind: "rate_limited",
      retryAfterSeconds: Math.max(1, Math.ceil(ttlRaw / 1000)),
    };
  } catch {
    console.error("gemini proxy rate limiter unavailable");
    return { ok: false, kind: "unavailable" };
  }
}

export function resetGeminiProxySecurityStateForTests(): void {
  const scope = globalThis as GlobalWithGeminiProxy;
  scope.__geminiProxyMemoryState = { buckets: new Map(), lastCleanupMs: 0 };
  scope.__geminiProxyRedisClient = undefined;
}

function readRateLimitConfig(env: NodeJS.ProcessEnv): RateLimitConfig {
  const max = readNumberEnv("GEMINI_PROXY_RATE_LIMIT_MAX", DEFAULT_RATE_LIMIT_MAX, env);
  const windowMs = readNumberEnv(
    "GEMINI_PROXY_RATE_LIMIT_WINDOW_MS",
    DEFAULT_RATE_LIMIT_WINDOW_MS,
    env,
  );
  const keyPrefix = env.GEMINI_PROXY_RATE_LIMIT_PREFIX?.trim() || DEFAULT_RATE_LIMIT_PREFIX;
  const hasRedisConfig = Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN);
  const mode: RateLimitMode = hasRedisConfig
    ? "redis"
    : env.NODE_ENV === "production"
      ? "disabled"
      : "memory";

  return { max, windowMs, keyPrefix, mode };
}

function rateLimitKey(config: RateLimitConfig, tokenFingerprint: string, clientAddress: string): string {
  const ipFingerprint = digestHex(clientAddress.trim().toLowerCase() || "unknown");
  return `${config.keyPrefix}:token:${tokenFingerprint}:ip:${ipFingerprint}`;
}

function enforceMemoryRateLimit(
  key: string,
  config: RateLimitConfig,
  nowMs: number,
): RateLimitAllowed | RateLimited {
  const state = getMemoryRateLimitState();
  if (state.lastCleanupMs + config.windowMs < nowMs) {
    cleanupExpiredBuckets(state, config.windowMs, nowMs);
  }

  const current = state.buckets.get(key);
  if (!current || nowMs - current.windowStartMs >= config.windowMs) {
    state.buckets.set(key, { windowStartMs: nowMs, count: 1 });
    return { ok: true };
  }

  if (current.count >= config.max) {
    const retryAfterMs = Math.max(1, config.windowMs - (nowMs - current.windowStartMs));
    return { ok: false, kind: "rate_limited", retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
  }

  current.count += 1;
  return { ok: true };
}

function cleanupExpiredBuckets(state: MemoryRateLimitState, windowMs: number, nowMs: number): void {
  for (const [key, bucket] of state.buckets) {
    if (nowMs - bucket.windowStartMs >= windowMs) {
      state.buckets.delete(key);
    }
  }
  state.lastCleanupMs = nowMs;
}

function getMemoryRateLimitState(): MemoryRateLimitState {
  const scope = globalThis as GlobalWithGeminiProxy;
  if (!scope.__geminiProxyMemoryState) {
    scope.__geminiProxyMemoryState = { buckets: new Map(), lastCleanupMs: 0 };
  }
  return scope.__geminiProxyMemoryState;
}

function getRedisClient(env: NodeJS.ProcessEnv): Redis {
  const url = env.UPSTASH_REDIS_REST_URL?.trim() ?? "";
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim() ?? "";
  const cacheKey = `${url}::${token}`;
  const scope = globalThis as GlobalWithGeminiProxy;

  if (!scope.__geminiProxyRedisClient || scope.__geminiProxyRedisClient.cacheKey !== cacheKey) {
    scope.__geminiProxyRedisClient = {
      cacheKey,
      client: new Redis({ url, token }),
    };
  }

  return scope.__geminiProxyRedisClient.client;
}

function parseRedisEvalResponse(value: unknown): [0 | 1, number] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error("invalid redis limiter response");
  }

  const allowed = Number(value[0]);
  const ttlMs = Number(value[1]);
  if ((allowed !== 0 && allowed !== 1) || !Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new Error("invalid redis limiter response");
  }
  return [allowed as 0 | 1, Math.floor(ttlMs)];
}

function digestHex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function readNumberEnv(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const value = env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}
