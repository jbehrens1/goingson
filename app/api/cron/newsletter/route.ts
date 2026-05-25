// Vercel Cron handler. Fires daily at the schedule in vercel.json.
// Iterates every Clerk user, then every subscription on that user, sending a
// separate digest per subscription that's due. Each subscription has its own
// lastSentAt so a daily sub on a user with a weekly sub still fires correctly.
//
// Auth: requires `Authorization: Bearer <CRON_SECRET>` header when env is set.
// ?dryRun=1 reports what WOULD be sent without calling Resend.

import { NextResponse } from "next/server";
import {
  iterateAllUsers,
  saveStateForUserId,
  stateFromUser,
} from "@/lib/newsletter/prefs";
import {
  defaultRegionIds,
  isDueNow,
  loadEventsForRegions,
  sendDigest,
  type SendResult,
} from "@/lib/newsletter/send";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${expected}`) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? `${url.protocol}//${url.host}`;

  const startedAt = new Date();
  const events = await loadEventsForRegions(defaultRegionIds());

  let usersScanned = 0;
  let subsConsidered = 0;
  let subsDue = 0;
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const failures: Array<{ userId: string; subId: string; email: string; error: string }> =
    [];

  for await (const user of iterateAllUsers()) {
    usersScanned++;
    const state = stateFromUser(user);
    if (state.subscriptions.length === 0) continue;

    const email =
      user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)
        ?.emailAddress ?? user.emailAddresses[0]?.emailAddress;
    if (!email) {
      skipped += state.subscriptions.length;
      continue;
    }

    // Track which subs got their lastSentAt updated; save once per user
    // after all their subs are processed.
    const updatedSubs = [...state.subscriptions];
    let anyUpdated = false;

    for (let i = 0; i < state.subscriptions.length; i++) {
      const sub = state.subscriptions[i];
      subsConsidered++;
      if (!isDueNow(sub, startedAt)) continue;
      subsDue++;

      if (dryRun) {
        sent++;
        continue;
      }

      let res: SendResult;
      try {
        res = await sendDigest({
          recipient: { userId: user.id, email, firstName: user.firstName ?? undefined },
          sub,
          eventsByRegion: events,
          baseUrl,
          now: startedAt,
        });
      } catch (err) {
        res = { ok: false, error: (err as Error).message };
      }

      if (!res.ok) {
        failed++;
        failures.push({ userId: user.id, subId: sub.id, email, error: res.error });
        continue;
      }
      if ("skipped" in res) {
        skipped++;
        continue;
      }
      sent++;
      updatedSubs[i] = { ...sub, lastSentAt: startedAt.toISOString() };
      anyUpdated = true;
    }

    if (anyUpdated) {
      try {
        await saveStateForUserId(user.id, { subscriptions: updatedSubs });
      } catch {
        // metadata write failures don't unsend the email; just continue
      }
    }
  }

  return NextResponse.json({
    ok: true,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    dryRun,
    usersScanned,
    subsConsidered,
    subsDue,
    sent,
    skipped,
    failed,
    failures: failures.slice(0, 20),
  });
}
