import { createFileRoute } from "@tanstack/react-router";
import {
  authenticateGeminiProxyRequest,
  enforceGeminiProxyRateLimit,
} from "~/lib/gemini-proxy-security";

const DEFAULT_ALLOWED_OPERATIONS = ["generateContent"];
const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024;
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";

export const Route = createFileRoute("/api/gemini/v1beta/models/$modelAndOperation")({
  server: {
    handlers: {
      POST: async ({ params, request }) => handleGeminiProxyPost(params.modelAndOperation, request),
    },
  },
});

export async function handleGeminiProxyPost(
  modelAndOperation: string,
  request: Request,
): Promise<Response> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return json({ error: "gemini_proxy_not_configured" }, 503);

  const auth = authenticateGeminiProxyRequest(request);
  if (!auth.ok) {
    if (auth.kind === "not_configured") {
      console.error(
        "gemini proxy app auth not configured: set GEMINI_PROXY_APP_TOKEN before enabling endpoint",
      );
      return json({ error: "gemini_proxy_auth_not_configured" }, 503);
    }
    return json({ error: "unauthorized" }, 401);
  }

  const parsed = parseModelAndOperation(modelAndOperation);
  if (!parsed) return json({ error: "invalid_model_or_operation" }, 400);

  const config = readProxyConfig();
  const { model, operation } = parsed;
  if (!config.allowedOperations.has(operation)) {
    return json({ error: "operation_not_allowed" }, 403);
  }

  if (config.allowedModels.size > 0 && !config.allowedModels.has(model)) {
    return json({ error: "model_not_allowed" }, 403);
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return json({ error: "unsupported_media_type" }, 415);
  }

  const rateLimit = await enforceGeminiProxyRateLimit({
    tokenFingerprint: auth.tokenFingerprint,
    clientAddress: clientAddress(request),
  });

  if (!rateLimit.ok) {
    if (rateLimit.kind === "rate_limited") {
      return json(
        { error: "rate_limited", retryAfterSeconds: rateLimit.retryAfterSeconds },
        429,
        { "retry-after": String(rateLimit.retryAfterSeconds) },
      );
    }

    return json({ error: "gemini_proxy_rate_limit_not_configured" }, 503);
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > config.maxRequestBytes) {
    return json({ error: "payload_too_large" }, 413);
  }

  const payload = new TextDecoder().decode(bytes);
  try {
    JSON.parse(payload);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const upstreamUrl = new URL(
    `/v1beta/models/${encodeURIComponent(model)}:${operation}`,
    GEMINI_BASE_URL,
  );
  upstreamUrl.searchParams.set("key", apiKey);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: payload,
    });
  } catch {
    // Avoid logging request metadata that could include sensitive query params.
    console.error("gemini proxy upstream request failed");
    return json({ error: "upstream_unavailable" }, 503);
  }

  const upstreamBody = await upstreamResponse.text();
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type":
      upstreamResponse.headers.get("content-type") ?? "application/json; charset=utf-8",
  });

  return new Response(upstreamBody, {
    status: upstreamResponse.status,
    headers,
  });
}

function json(
  body: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function parseModelAndOperation(value: string): { model: string; operation: string } | null {
  const split = value.indexOf(":");
  if (split <= 0 || split === value.length - 1) return null;
  const model = value.slice(0, split);
  const operation = value.slice(split + 1);

  if (!/^[a-zA-Z0-9._-]+$/.test(model)) return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(operation)) return null;

  return { model, operation };
}

function clientAddress(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const [first] = forwardedFor.split(",");
    const trimmed = first?.trim();
    if (trimmed) return trimmed;
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp?.trim()) return realIp.trim();
  return "unknown";
}

function readProxyConfig(): {
  allowedOperations: Set<string>;
  allowedModels: Set<string>;
  maxRequestBytes: number;
} {
  return {
    allowedOperations: readCsvEnv("GEMINI_ALLOWED_OPERATIONS", DEFAULT_ALLOWED_OPERATIONS),
    allowedModels: readCsvEnv("GEMINI_ALLOWED_MODELS"),
    maxRequestBytes: readNumberEnv("GEMINI_PROXY_MAX_REQUEST_BYTES", DEFAULT_MAX_REQUEST_BYTES),
  };
}

function readCsvEnv(name: string, defaultValues: string[] = []): Set<string> {
  const value = process.env[name];
  if (!value) return new Set(defaultValues);
  const parsed = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return new Set(parsed.length > 0 ? parsed : defaultValues);
}

function readNumberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}
