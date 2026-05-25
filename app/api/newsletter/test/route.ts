// "Send me a preview" button on /account. Generates and sends the digest for
// ONE subscription immediately, ignoring the lastSentAt cooldown. Body must
// include { subscriptionId } so the user picks which subscription to preview.

import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { getStateForUserId } from "@/lib/newsletter/prefs";
import { loadEventsForRegions, sendDigest, defaultRegionIds } from "@/lib/newsletter/send";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });
  }
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "User not found" }, { status: 404 });
  }
  const email =
    user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ??
    user.emailAddresses[0]?.emailAddress;
  if (!email) {
    return NextResponse.json({ ok: false, error: "No email on account" }, { status: 400 });
  }

  let body: { subscriptionId?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  if (!body.subscriptionId) {
    return NextResponse.json(
      { ok: false, error: "subscriptionId required" },
      { status: 400 },
    );
  }

  const state = await getStateForUserId(userId);
  const sub = state.subscriptions.find((s) => s.id === body.subscriptionId);
  if (!sub) {
    return NextResponse.json({ ok: false, error: "Subscription not found" }, { status: 404 });
  }

  const events = await loadEventsForRegions(defaultRegionIds());
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin.replace(/\/$/, "");

  const res = await sendDigest({
    recipient: { userId, email, firstName: user.firstName ?? undefined },
    sub,
    eventsByRegion: events,
    baseUrl,
    forceSend: true,
  });

  if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: 500 });
  if ("skipped" in res) return NextResponse.json({ ok: true, skipped: res.skipped });
  return NextResponse.json({
    ok: true,
    emailId: res.emailId,
    matched: res.matched,
    surprises: res.surprises,
  });
}
