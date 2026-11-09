/**
 * gift-email.ts — sends the "someone sent you a reading" email to the
 * recipient, and the gift receipt (with the shareable claim link) to the buyer.
 *
 * Uses Resend's HTTP API directly over fetch: one POST, no SDK, nothing added
 * to the bundle. Swapping providers later means changing this one function.
 *
 * Configuration:
 *   RESEND_API_KEY  — required. Without it nothing is sent and the failure is
 *                     logged, never thrown: a gift that was paid for must not
 *                     fail the webhook, or Stripe will retry the payment event
 *                     for days over an email problem.
 *   GIFT_FROM_EMAIL — the verified sender, e.g. "Divine Insight <readings@yourdomain>".
 *   PUBLIC_SITE_URL — origin used to build the claim link.
 *
 * Server-only.
 */
import { SHARE_CLAIM_LINK_COPY } from "~/lib/gift-validation";

export type GiftEmailInput = {
  to: string;
  senderName: string | null;
  note: string | null;
  claimUrl: string;
};

export async function sendGiftEmail(input: GiftEmailInput): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.GIFT_FROM_EMAIL;
  if (!apiKey || !from) {
    console.error(
      "gift email not sent — RESEND_API_KEY and GIFT_FROM_EMAIL must both be set",
    );
    return false;
  }

  const sender = input.senderName?.trim() || "Someone";
  const subject = `${sender} sent you a tarot reading`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject,
        text: plainText(sender, input.note, input.claimUrl),
        html: html(sender, input.note, input.claimUrl),
      }),
    });
    if (!res.ok) {
      console.error("gift email rejected:", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("gift email failed to send", err);
    return false;
  }
}

export type GiftBuyerEmailInput = {
  /** The buyer's address, from Stripe's checkout session customer_details. */
  to: string;
  /** Null when the gift was bought without a recipient address. */
  recipientEmail: string | null;
  claimUrl: string;
};

/**
 * The buyer's gift receipt: always carries the claim link, so the buyer can
 * share it themselves whether or not we could email the recipient. Same
 * failure contract as sendGiftEmail — logs and returns false, never throws.
 */
export async function sendGiftBuyerEmail(input: GiftBuyerEmailInput): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.GIFT_FROM_EMAIL;
  if (!apiKey || !from) {
    console.error(
      "gift receipt not sent — RESEND_API_KEY and GIFT_FROM_EMAIL must both be set",
    );
    return false;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: "Your gift reading is ready to share",
        text: buyerText(input.recipientEmail, input.claimUrl),
        html: buyerHtml(input.recipientEmail, input.claimUrl),
      }),
    });
    if (!res.ok) {
      console.error("gift receipt rejected:", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("gift receipt failed to send", err);
    return false;
  }
}


export function buyerText(recipientEmail: string | null, url: string): string {
  return [
    "Thank you — your gift reading is paid for and ready.",
    "",
    recipientEmail
      ? `We've also emailed it to ${recipientEmail}. If it doesn't arrive, ${SHARE_CLAIM_LINK_COPY.toLowerCase()}:`
      : `${SHARE_CLAIM_LINK_COPY}:`,
    url,
    "",
    "The link works once: whoever opens it turns the card.",
  ].join("\n");
}

function buyerHtml(recipientEmail: string | null, url: string): string {
  const lead = recipientEmail
    ? `We&rsquo;ve also emailed it to ${escapeHtml(recipientEmail)}. If it doesn&rsquo;t arrive, share this link with the person you&rsquo;re gifting.`
    : "Share this link with the person you&rsquo;re gifting.";
  const safeUrl = escapeHtml(url);
  return `<!doctype html>
<html>
  <body style="margin:0;padding:32px 16px;background:#0d0b14;font-family:Georgia,'Times New Roman',serif;color:#f4ecdf;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;">
      <tr><td style="text-align:center;padding-bottom:8px;">
        <p style="margin:0;font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#c6a055;">Divine Insight</p>
      </td></tr>
      <tr><td style="text-align:center;padding:16px 0 8px;">
        <h1 style="margin:0;font-size:24px;font-weight:500;color:#f4ecdf;">Your gift reading is ready</h1>
      </td></tr>
      <tr><td style="text-align:center;padding:8px 0 20px;">
        <p style="margin:0;font-size:14px;line-height:1.7;color:#bfb4a0;">${lead}</p>
      </td></tr>
      <tr><td style="text-align:center;padding-bottom:20px;">
        <a href="${safeUrl}" style="display:inline-block;padding:14px 32px;border-radius:999px;background:#c6a055;color:#0d0b14;font-size:13px;letter-spacing:2px;text-transform:uppercase;text-decoration:none;">Open the gift link</a>
        <p style="margin:12px 0 0;font-size:12px;word-break:break-all;color:#8e8676;">${safeUrl}</p>
      </td></tr>
      <tr><td style="text-align:center;border-top:1px solid rgba(255,255,255,0.08);padding-top:16px;">
        <p style="margin:0;font-size:11px;line-height:1.6;color:#8e8676;">The link works once: whoever opens it turns the card.</p>
      </td></tr>
    </table>
  </body>
</html>`;
}

/** Build the claim URL for a token. */
export function claimUrlFor(token: string, requestUrl: string): string {
  const base = process.env.PUBLIC_SITE_URL ?? new URL(requestUrl).origin;
  return new URL(`/claim/${token}`, base).toString();
}

function plainText(sender: string, note: string | null, url: string): string {
  const lines = [
    `${sender} sent you a tarot reading.`,
    "",
    note ? `"${note}"` : null,
    note ? "" : null,
    "One card, drawn for you and read in full. Turn it whenever you are ready:",
    url,
    "",
    "Divine Insight readings are offered as a space for reflection, never a prediction.",
  ];
  return lines.filter((line) => line !== null).join("\n");
}

function html(sender: string, note: string | null, url: string): string {
  const safeSender = escapeHtml(sender);
  const safeNote = note ? escapeHtml(note) : null;
  return `<!doctype html>
<html>
  <body style="margin:0;padding:32px 16px;background:#0d0b14;font-family:Georgia,'Times New Roman',serif;color:#f4ecdf;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;">
      <tr><td style="text-align:center;padding-bottom:8px;">
        <p style="margin:0;font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#c6a055;">Divine Insight</p>
      </td></tr>
      <tr><td style="text-align:center;padding:16px 0 8px;">
        <h1 style="margin:0;font-size:26px;font-weight:500;letter-spacing:1px;color:#f4ecdf;">${safeSender} sent you a reading</h1>
      </td></tr>
      ${
        safeNote
          ? `<tr><td style="text-align:center;padding:12px 0;">
        <p style="margin:0;font-size:15px;line-height:1.6;font-style:italic;color:#d8cbb4;">&ldquo;${safeNote}&rdquo;</p>
      </td></tr>`
          : ""
      }
      <tr><td style="text-align:center;padding:8px 0 24px;">
        <p style="margin:0;font-size:14px;line-height:1.7;color:#bfb4a0;">One card, drawn for you and read in full. Turn it whenever you are ready.</p>
      </td></tr>
      <tr><td style="text-align:center;padding-bottom:28px;">
        <a href="${url}" style="display:inline-block;padding:14px 32px;border-radius:999px;background:#c6a055;color:#0d0b14;font-size:13px;letter-spacing:2px;text-transform:uppercase;text-decoration:none;">Turn your card</a>
      </td></tr>
      <tr><td style="text-align:center;border-top:1px solid rgba(255,255,255,0.08);padding-top:16px;">
        <p style="margin:0;font-size:11px;line-height:1.6;color:#8e8676;">Offered as a space for reflection and entertainment, never a prediction.</p>
      </td></tr>
    </table>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
