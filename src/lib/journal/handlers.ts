/**
 * Pro Journal API (user-scoped). Every handler runs behind withPro():
 *   401 signed out, 403 not Pro, 503 if the entitlement lookup fails.
 *
 *   GET    /api/pro/journal            -> 200 { entries: JournalEntry[] } (own entries only)
 *   POST   /api/pro/journal            -> 201 { entry }
 *   PATCH  /api/pro/journal/:entryId   -> 200 { entry } | 404
 *   DELETE /api/pro/journal/:entryId   -> 204 | 404
 *
 * Another user's entry id returns 404 (indistinguishable from a missing one).
 */
import { guardJson, withPro, type ProGuardDeps } from "~/lib/auth/require-pro";
import type { JournalInput, JournalPatch, JournalStore } from "./types";
import { LIMITS } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };
const bad = (error: string, status = 400): { ok: false; response: Response } => ({
  ok: false,
  response: guardJson({ error }, status),
});

async function readBody(request: Request): Promise<Parsed<Record<string, unknown>>> {
  const raw = await request.text();
  if (raw.length > LIMITS.bodyBytes) return bad("payload_too_large", 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return bad("invalid_json");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("invalid_body");
  return { ok: true, value: body as Record<string, unknown> };
}

function validate(body: Record<string, unknown>, partial: boolean): Parsed<JournalPatch> {
  const out: JournalPatch = {};
  if (body.title !== undefined || !partial) {
    if (typeof body.title !== "string" || !body.title.trim()) return bad("invalid_title");
    const t = body.title.trim();
    if (t.length > LIMITS.title) return bad("invalid_title");
    out.title = t;
  }
  if (body.spread !== undefined) {
    if (body.spread !== null && (typeof body.spread !== "string" || body.spread.length > LIMITS.spread)) {
      return bad("invalid_spread");
    }
    out.spread = (body.spread as string | null) || null;
  } else if (!partial) out.spread = null;
  if (body.note !== undefined) {
    if (typeof body.note !== "string" || body.note.length > LIMITS.note) return bad("invalid_note");
    out.note = body.note;
  } else if (!partial) out.note = "";
  if (body.reading !== undefined) {
    if (JSON.stringify(body.reading).length > LIMITS.readingBytes) return bad("reading_too_large", 413);
    out.reading = body.reading;
  } else if (!partial) out.reading = null;
  if (partial && Object.keys(out).length === 0) return bad("empty_patch");
  return { ok: true, value: out };
}

function failed(err: unknown): Response {
  console.error("journal operation failed", err);
  return guardJson({ error: "unavailable" }, 503);
}

export function journalHandlers(store: () => JournalStore, guard?: ProGuardDeps) {
  return {
    list: withPro<{ request: Request }>(async ({ user }) => {
      try {
        return guardJson({ entries: await store().list(user.id) }, 200);
      } catch (err) {
        return failed(err);
      }
    }, guard),

    create: withPro<{ request: Request }>(async ({ request, user }) => {
      const body = await readBody(request);
      if (!body.ok) return body.response;
      const input = validate(body.value, false);
      if (!input.ok) return input.response;
      try {
        return guardJson({ entry: await store().create(user.id, input.value as JournalInput) }, 201);
      } catch (err) {
        return failed(err);
      }
    }, guard),

    update: withPro<{ request: Request; params: { entryId: string } }>(async ({ request, params, user }) => {
      if (!UUID.test(params.entryId)) return guardJson({ error: "not_found" }, 404);
      const body = await readBody(request);
      if (!body.ok) return body.response;
      const patch = validate(body.value, true);
      if (!patch.ok) return patch.response;
      try {
        const entry = await store().update(user.id, params.entryId, patch.value);
        return entry ? guardJson({ entry }, 200) : guardJson({ error: "not_found" }, 404);
      } catch (err) {
        return failed(err);
      }
    }, guard),

    remove: withPro<{ request: Request; params: { entryId: string } }>(async ({ params, user }) => {
      if (!UUID.test(params.entryId)) return guardJson({ error: "not_found" }, 404);
      try {
        const removed = await store().remove(user.id, params.entryId);
        return removed
          ? new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
          : guardJson({ error: "not_found" }, 404);
      } catch (err) {
        return failed(err);
      }
    }, guard),
  };
}
