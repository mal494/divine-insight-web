/**
 * Sends the sign-in email through the same Resend setup as gift emails
 * (RESEND_API_KEY + GIFT_FROM_EMAIL, plain fetch, no SDK).
 *
 * Unlike gift emails this throws on failure, so Better Auth reports an error
 * to the sign-in form instead of a false "check your email".
 */
export async function sendMagicLinkEmail(to: string, url: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.GIFT_FROM_EMAIL;
  if (!apiKey || !from) {
    throw new Error("sign-in email not sent — RESEND_API_KEY and GIFT_FROM_EMAIL must both be set");
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      from,
      to: [to],
      subject: "Your Divine Insight sign-in link",
      text: `Sign in to Divine Insight:\n${url}\n\nThis link expires in 15 minutes. If you didn't ask for it, ignore this email.`,
      html: `<p>Sign in to Divine Insight:</p><p><a href="${escapeAttr(url)}">Continue to sign in</a></p><p>This link expires in 15 minutes. If you didn't ask for it, ignore this email.</p>`,
    }),
  });
  if (!res.ok) {
    throw new Error(`sign-in email rejected by Resend: ${res.status}`);
  }
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
