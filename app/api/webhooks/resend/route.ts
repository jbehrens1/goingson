// Captures Resend webhook events (sent / delivered / opened / clicked /
// bounced / complained) and logs them to the Vercel function log.
//
// History note: this used to append rows to public/newsletter-events.jsonl
// so /admin/newsletter could render a rollup. That never worked on Vercel
// because the serverless filesystem under process.cwd() is read-only at
// runtime — every append threw EROFS, the catch swallowed it, the
// admin page was reading a file that never existed. Resend dashboard
// (https://resend.com/emails) already has per-email opens/clicks, so for
// now we just log to console (visible in Vercel function logs) and rely
// on the dashboard. When this rollup matters we'll move to Vercel KV /
// Postgres or a logging backend — see /admin/newsletter for the placeholder.
//
// To enable: in Resend dashboard → Webhooks → add endpoint
//   https://www.goingson.co/api/webhooks/resend
// Select events: email.sent, email.delivered, email.opened, email.clicked,
//                email.bounced, email.complained.
// Copy the signing secret into Vercel env as RESEND_WEBHOOK_SECRET.
//
// Why this endpoint kept getting disabled by Resend before: signature
// verification had two bugs that combined to make every call 401:
//   1. We read headers named "webhook-signature" / "webhook-timestamp",
//      but Resend (Svix free tier) sends them as "svix-signature" /
//      "svix-timestamp". Headers were null, verify returned false.
//   2. The Svix signed payload is `{id}.{timestamp}.{body}`, not
//      `{timestamp}.{body}` — we were missing the svix-id component.
// Both are fixed below. We accept either header prefix for forward
// compatibility (Svix Pro/Enterprise can switch to "webhook-*").

import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";

type ResendEvent = {
  type: string;
  created_at: string;
  data: {
    email_id?: string;
    to?: string[];
    from?: string;
    subject?: string;
    tags?: Array<{ name: string; value: string }>;
    click?: { link?: string };
    bounce?: { type?: string };
  };
};

/** Read header by either of the Svix prefixes Resend may send. */
function svixHeader(req: Request, name: string): string | null {
  return req.headers.get(`svix-${name}`) ?? req.headers.get(`webhook-${name}`);
}

/**
 * Verify the Svix signature Resend sends. Signed payload is
 * `${id}.${timestamp}.${body}`, signature is base64(HMAC-SHA256), the
 * header may carry multiple space-delimited signatures each prefixed
 * with `v1,`.
 */
function verifyResendSignature(
  rawBody: string,
  id: string | null,
  timestamp: string | null,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!id || !timestamp || !signatureHeader) return false;
  const sigs = signatureHeader
    .split(" ")
    .filter((s) => s.startsWith("v1,"))
    .map((s) => s.slice(3));
  if (sigs.length === 0) return false;

  const signedPayload = `${id}.${timestamp}.${rawBody}`;
  // Resend's secret comes prefixed with "whsec_"; the raw secret is
  // the base64-decoded portion after that prefix.
  const rawSecret = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice(6), "base64")
    : Buffer.from(secret);
  const expected = createHmac("sha256", rawSecret)
    .update(signedPayload)
    .digest("base64");
  const expectedBuf = Buffer.from(expected);
  return sigs.some((s) => {
    const b = Buffer.from(s);
    return b.length === expectedBuf.length && timingSafeEqual(b, expectedBuf);
  });
}

export async function POST(req: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const raw = await req.text();

  if (secret) {
    const ok = verifyResendSignature(
      raw,
      svixHeader(req, "id"),
      svixHeader(req, "timestamp"),
      svixHeader(req, "signature"),
      secret,
    );
    if (!ok) {
      // Log enough to diagnose without leaking the body — header presence
      // is the most common failure mode (wrong env, wrong prefix, etc.).
      console.warn("[resend-webhook] signature verification failed", {
        hasId: !!svixHeader(req, "id"),
        hasTimestamp: !!svixHeader(req, "timestamp"),
        hasSignature: !!svixHeader(req, "signature"),
      });
      return NextResponse.json({ ok: false, error: "Bad signature" }, { status: 401 });
    }
  }

  let event: ResendEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  // Pull the bits worth surfacing in the function log. Tags carry the
  // region/schedule/surprise metadata sendDigest() attaches per email.
  const tags: Record<string, string> = {};
  for (const t of event.data?.tags ?? []) tags[t.name] = t.value;
  const row = {
    ts: event.created_at,
    type: event.type,
    emailId: event.data?.email_id,
    to: event.data?.to?.[0],
    subject: event.data?.subject,
    region: tags.region,
    schedule: tags.schedule,
    surprise: tags.surprise,
    link: event.data?.click?.link,
    bounceType: event.data?.bounce?.type,
  };
  console.log("[resend-webhook]", JSON.stringify(row));

  return NextResponse.json({ ok: true });
}
