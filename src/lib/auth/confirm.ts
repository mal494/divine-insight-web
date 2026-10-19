/**
 * POST /api/auth-confirm handler. The emailed link lands on /auth/confirm,
 * a page that only renders a button; the button submits this form. Scanners
 * that GET the link never reach the one-time token check.
 */
import { safeCallbackPath } from "./config";

export type VerifyFn = (token: string, headers: Headers) => Promise<Response>;

export async function handleConfirmPost(request: Request, verify: VerifyFn): Promise<Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  // Same-origin form posts only.
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return new Response("Forbidden", { status: 403 });
  }

  let token = "";
  let callbackURL = "/";
  try {
    const form = await request.formData();
    token = String(form.get("token") ?? "");
    callbackURL = safeCallbackPath(form.get("callbackURL"));
  } catch {
    return redirect("/signin?error=invalid_link");
  }
  if (!token) return redirect("/signin?error=invalid_link");

  let res: Response;
  try {
    res = await verify(token, request.headers);
  } catch {
    return redirect("/signin?error=invalid_link");
  }
  const cookies = res.headers.getSetCookie?.() ?? [];
  if (!res.ok && !(res.status >= 300 && res.status < 400)) {
    return redirect("/signin?error=invalid_link");
  }
  if (!cookies.some((c) => c.includes("session_token"))) {
    return redirect("/signin?error=invalid_link");
  }
  const out = redirect(callbackURL);
  for (const c of cookies) out.headers.append("set-cookie", c);
  return out;
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}
