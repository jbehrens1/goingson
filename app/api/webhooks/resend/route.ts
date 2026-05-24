// Captures Resend webhook events (sent / delivered / opened / clicked /
// bounced / complained) and appends them to public/newsletter-events.jsonl.
//
// Why a JSONL file in /public? Same logic as source-health.json:
//   - The cron commits it back to the repo so we have a historical log
//   - It's tiny per row (~200 bytes) — millions of rows fit in a few MB
//   - When we later want SQL-style analytics, we backfill into Postgres
//   - In the meantime, the /admin/newsletter page can grep this file
//
// To enable: in Resend dashboard → Webhooks → add endpoint
//   https://www.goingson.co/api/webhooks/resend
// Select events: email.sent, email.delivered, email.opened, email.clicked,
//                email.bounced, email.complained.
// Copy the signing secret into Vercel env as RESEND_WEBHOOK_SECRET.

import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

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

/** Verify the Svix-style signature Resend sends on each webhook. */
function verifyResendSignature(
  rawBody: string,
  signatureHeader: string | null,
  timestampHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader || !timestampHeader) return false;
  // Resend uses Svix: signature format is "v1,<base64>"
  const sigs = signatureHeader
    .split(" ")
    .filter((s) => s.startsWith("v1,"))
    .map((s) => s.slice(3));
  if (sigs.length === 0) return false;
  const signedPayload = `${timestampHeader}.${rawBody}`;
  // Resend's secret comes prefixed with "whsec_"; the raw secret is base64-
  // decoded after stripping that prefix.
  const rawSecret = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice(6), "base64")
    : Buffer.from(secret);
  const expected = createHmac("sha256", rawSecret).update(signedPayload).digest("base64");
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
      req.headers.get("webhook-signature"),
      req.headers.get("webhook-timestamp"),
      secret,
    );
    if (!ok) {
      return NextResponse.json({ ok: false, error: "Bad signature" }, { status: 401 });
    }
  }

  let event: ResendEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  // Pull the bits we'll want to query later. Keep it small.
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

  try {
    const dir = path.join(process.cwd(), "public");
    await mkdir(dir, { recursive: true });
    await appendFile(
      path.join(dir, "newsletter-events.jsonl"),
      JSON.stringify(row) + "\n",
      "utf8",
    );
  } catch (err) {
    // Log failure but acknowledge the webhook so Resend doesn't retry forever.
    console.error("[webhook] failed to append:", (err as Error).message);
  }

  return NextResponse.json({ ok: true });
}
