// Admin newsletter test-send endpoint.
//
// POST /api/admin/newsletter-test
//   body: { userId: string; subscriptionId: string; recipient: "admin" | "user" }
//
//   recipient: "admin"  → send the target user's digest to the admin's email
//                         so the admin can see what the user would receive
//                         without spamming the user. Subject is prefixed with
//                         "[PREVIEW for <email>] " for clarity.
//   recipient: "user"   → send the digest to the target user's actual email,
//                         bypassing the lastSentAt cooldown. Useful for "I
//                         changed their settings, show them the result."
//
// Admin/owner role required. Both modes use forceSend=true so the cron
// schedule doesn't block the test.

import { NextResponse } from "next/server";
import { clerkClient, currentUser } from "@clerk/nextjs/server";
import { requireRole } from "@/lib/auth";
import { getStateForUserId } from "@/lib/newsletter/prefs";
import {
  defaultRegionIds,
  loadEventsForRegions,
  sendDigest,
} from "@/lib/newsletter/send";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    await requireRole("admin");
  } catch (res) {
    if (res instanceof Response) return res;
    throw res;
  }

  // Look up the admin's own email/profile for "send to me" mode.
  const adminUser = await currentUser();
  if (!adminUser) {
    return NextResponse.json(
      { ok: false, error: "Admin user not found" },
      { status: 401 },
    );
  }
  const adminEmail =
    adminUser.emailAddresses.find((e) => e.id === adminUser.primaryEmailAddressId)
      ?.emailAddress ?? adminUser.emailAddresses[0]?.emailAddress;

  let body: {
    userId?: string;
    subscriptionId?: string;
    recipient?: "admin" | "user";
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const targetUserId = body.userId?.trim();
  const subscriptionId = body.subscriptionId?.trim();
  const mode: "admin" | "user" = body.recipient === "user" ? "user" : "admin";
  if (!targetUserId || !subscriptionId) {
    return NextResponse.json(
      { ok: false, error: "userId and subscriptionId required" },
      { status: 400 },
    );
  }
  if (mode === "admin" && !adminEmail) {
    return NextResponse.json(
      { ok: false, error: "Admin has no email on their account" },
      { status: 400 },
    );
  }

  // Pull the target user's profile + subscription from Clerk.
  const client = await clerkClient();
  let targetEmail: string | undefined;
  let targetFirstName: string | undefined;
  try {
    const u = await client.users.getUser(targetUserId);
    targetEmail =
      u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId)?.emailAddress ??
      u.emailAddresses[0]?.emailAddress;
    targetFirstName = u.firstName ?? undefined;
  } catch {
    return NextResponse.json(
      { ok: false, error: `Unknown user: ${targetUserId}` },
      { status: 404 },
    );
  }

  const state = await getStateForUserId(targetUserId);
  const sub = state.subscriptions.find((s) => s.id === subscriptionId);
  if (!sub) {
    return NextResponse.json(
      { ok: false, error: "Subscription not found on that user" },
      { status: 404 },
    );
  }

  if (mode === "user" && !targetEmail) {
    return NextResponse.json(
      { ok: false, error: "Target user has no email on their account" },
      { status: 400 },
    );
  }

  // For "admin" mode, prefix the subscription name so the rendered subject
  // line clearly says "[PREVIEW for foo@bar.com]". We mutate a copy; the
  // stored subscription on the target user is untouched.
  const subForSend =
    mode === "admin"
      ? { ...sub, name: `[PREVIEW for ${targetEmail ?? targetUserId}] ${sub.name}` }
      : sub;

  const events = await loadEventsForRegions(defaultRegionIds());
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin.replace(/\/$/, "");

  // recipient.userId controls unsubscribe-token scoping. For admin previews
  // we use the TARGET user's id so any "unsubscribe" link in the preview
  // would correctly identify that user's subscription (admin shouldn't
  // click it casually, but if they do, it'd unsubscribe the correct
  // record, not a nonexistent admin-on-someone-else's-sub).
  const res = await sendDigest({
    recipient:
      mode === "admin"
        ? {
            userId: targetUserId,
            email: adminEmail!,
            firstName: adminUser.firstName ?? undefined,
          }
        : {
            userId: targetUserId,
            email: targetEmail!,
            firstName: targetFirstName,
          },
    sub: subForSend,
    eventsByRegion: events,
    baseUrl,
    forceSend: true,
  });

  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.error }, { status: 500 });
  }
  if ("skipped" in res) {
    return NextResponse.json({
      ok: true,
      skipped: res.skipped,
      recipient: mode === "admin" ? adminEmail : targetEmail,
    });
  }
  return NextResponse.json({
    ok: true,
    emailId: res.emailId,
    matched: res.matched,
    surprises: res.surprises,
    recipient: mode === "admin" ? adminEmail : targetEmail,
    mode,
  });
}
