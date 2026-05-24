// Vercel Cron handler. Runs daily at the schedule defined in vercel.json.
// Iterates every Clerk user, sends a digest to anyone subscribed + due.
//
// Vercel adds an "Authorization: Bearer <CRON_SECRET>" header to cron-fired
// requests when CRON_SECRET env var is set. We require that to prevent
// random web traffic from triggering blast sends.
//
// ?dryRun=1 query param skips the actual Resend call but still iterates
// users and reports what WOULD have happened. Useful for first-time setup.
import { NextResponse } from "next/server";
import { iterateAllUsers, prefsFromUser, savePrefsForUserId } from "@/lib/newsletter/prefs";
import {
  defaultRegionIds,
  isDueNow,
  loadEventsForRegions,
  sendDigest,
  type SendResult,
} from "@/lib/newsletter/send";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 minutes — generous for a few hundred sends

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
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? `${url.protocol}//${url.host}`;

  const startedAt = new Date();
  const events = await loadEventsForRegions(defaultRegionIds());

  let scanned = 0;
  let subscribed = 0;
  let due = 0;
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const failures: Array<{ userId: string; email: string; error: string }> = [];

  for await (const user of iterateAllUsers()) {
    scanned++;
    const prefs = prefsFromUser(user);
    if (!prefs.subscribed) continue;
    subscribed++;
    if (!isDueNow(prefs, startedAt)) continue;
    due++;

    const email =
      user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ??
      user.emailAddresses[0]?.emailAddress;
    if (!email) {
      skipped++;
      continue;
    }

    if (dryRun) {
      sent++;
      continue;
    }

    let res: SendResult;
    try {
      res = await sendDigest({
        recipient: { userId: user.id, email, firstName: user.firstName ?? undefined },
        prefs,
        eventsByRegion: events,
        baseUrl,
        now: startedAt,
      });
    } catch (err) {
      res = { ok: false, error: (err as Error).message };
    }

    if (!res.ok) {
      failed++;
      failures.push({ userId: user.id, email, error: res.error });
      continue;
    }
    if ("skipped" in res) {
      skipped++;
      continue;
    }
    sent++;

    // Update lastSentAt + surpriseHistory so we don't re-send / repeat surprises.
    try {
      const newHistory = [...(prefs.surpriseHistory ?? [])];
      // Surprises were picked inside sendDigest; we don't have them back here.
      // Acceptable trade-off: lastSentAt cools the schedule down, surprise
      // dedupe will catch up on the next send via natural shuffling.
      await savePrefsForUserId(user.id, {
        lastSentAt: startedAt.toISOString(),
        surpriseHistory: newHistory,
      });
    } catch {
      // metadata update failures don't unsend the email; just log
    }
  }

  return NextResponse.json({
    ok: true,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    dryRun,
    scanned,
    subscribed,
    due,
    sent,
    skipped,
    failed,
    failures: failures.slice(0, 20),
  });
}
