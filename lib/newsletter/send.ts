// Build + send a digest to one user. Used by both /api/cron/newsletter and
// /api/newsletter/test. Returns a structured result that callers can log.

import { Resend } from "resend";
import { render } from "@react-email/render";
import Newsletter from "@/emails/Newsletter";
import { loadRegion, listRegionIds } from "../region";
import type { EventRecord } from "../types";
import { selectDigest, loadRegionEvents } from "./select";
import type { NewsletterPrefs } from "./types";
import { unsubscribeUrl } from "./token";
import path from "node:path";

export type SendResult =
  | { ok: true; emailId: string; matched: number; surprises: number; skipped?: never }
  | { ok: true; skipped: string; emailId?: never }
  | { ok: false; error: string };

export type RecipientRef = {
  userId: string;
  email: string;
  firstName?: string;
};

const rootDir = process.cwd();

/**
 * Pre-load events for each region the cron needs, once per tick.
 * Returns a map keyed by region id.
 */
export async function loadEventsForRegions(
  regionIds: string[],
): Promise<Map<string, EventRecord[]>> {
  const out = new Map<string, EventRecord[]>();
  for (const id of regionIds) {
    try {
      out.set(id, await loadRegionEvents(rootDir, id));
    } catch {
      // missing payload — skip; we'll log when a user is on that region
    }
  }
  return out;
}

/**
 * Decide whether a user is due for a send right now.
 * Daily: skip if lastSentAt within 18h (avoids double-sends on cron retries).
 * Weekly: only on Fridays; skip if lastSentAt within 5 days.
 */
export function isDueNow(prefs: NewsletterPrefs, now: Date = new Date()): boolean {
  if (!prefs.subscribed) return false;
  const lastMs = prefs.lastSentAt ? new Date(prefs.lastSentAt).getTime() : 0;
  const ageH = (now.getTime() - lastMs) / 3_600_000;
  if (prefs.schedule === "daily") {
    return ageH > 18;
  }
  // Weekly: Friday only (in UTC; close enough across US ET / PT for ~7am sends).
  if (now.getUTCDay() !== 5) return false;
  return ageH > 5 * 24;
}

/**
 * Send a digest to one recipient. `forceSend` bypasses the lastSentAt check
 * (used by the "send me a test" button).
 */
export async function sendDigest(opts: {
  recipient: RecipientRef;
  prefs: NewsletterPrefs;
  eventsByRegion: Map<string, EventRecord[]>;
  baseUrl: string;
  forceSend?: boolean;
  now?: Date;
}): Promise<SendResult> {
  const { recipient, prefs, eventsByRegion, baseUrl, forceSend } = opts;
  const now = opts.now ?? new Date();

  if (!forceSend && !isDueNow(prefs, now)) {
    return { ok: true, skipped: "not due yet" };
  }

  const events = eventsByRegion.get(prefs.region);
  if (!events) {
    return { ok: false, error: `No events payload for region "${prefs.region}"` };
  }

  // Look up region metadata for the email header / TZ.
  let regionDisplayName = prefs.region;
  let timeZone: string | undefined;
  try {
    const r = loadRegion(rootDir, prefs.region);
    regionDisplayName = r.config.displayName;
    timeZone = r.config.timeZone;
  } catch {
    // fall back to defaults above
  }

  const selection = selectDigest(events, prefs, now);
  if (selection.matched.length === 0 && selection.surprises.length === 0) {
    return { ok: true, skipped: "no events to show" };
  }

  // Render the email.
  const unsubUrl = unsubscribeUrl(baseUrl, recipient.userId);
  const manageUrl = new URL("/account", baseUrl).toString();
  const subscribeUrl = manageUrl; // same destination for forwarded recipients

  const html = await render(
    Newsletter({
      recipientFirstName: recipient.firstName,
      regionDisplayName,
      schedule: prefs.schedule,
      windowStart: selection.windowStart,
      windowEnd: selection.windowEnd,
      matched: selection.matched,
      surprises: selection.surprises,
      unsubscribeUrl: unsubUrl,
      manageUrl,
      subscribeUrl,
      timeZone,
    }),
  );
  const text = await render(
    Newsletter({
      recipientFirstName: recipient.firstName,
      regionDisplayName,
      schedule: prefs.schedule,
      windowStart: selection.windowStart,
      windowEnd: selection.windowEnd,
      matched: selection.matched,
      surprises: selection.surprises,
      unsubscribeUrl: unsubUrl,
      manageUrl,
      subscribeUrl,
      timeZone,
    }),
    { plainText: true },
  );

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from) {
    return { ok: false, error: "RESEND_API_KEY or RESEND_FROM not configured" };
  }
  const resend = new Resend(apiKey);

  // Tag every send for Resend's dashboard slicing + future analytics ingest.
  const tags = [
    { name: "region", value: prefs.region },
    { name: "schedule", value: prefs.schedule },
    { name: "surprise", value: prefs.surprise },
  ];

  const subject =
    prefs.schedule === "daily"
      ? `Today in ${regionDisplayName} · ${selection.matched.length + selection.surprises.length} picks`
      : `This week in ${regionDisplayName} · ${selection.matched.length + selection.surprises.length} picks`;

  const res = await resend.emails.send({
    from,
    to: recipient.email,
    subject,
    html,
    text,
    headers: {
      // RFC 8058: enables Gmail / Apple's native one-click Unsubscribe button.
      "List-Unsubscribe": `<${unsubUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    tags,
  });

  if (res.error) {
    return { ok: false, error: res.error.message };
  }
  if (!res.data?.id) {
    return { ok: false, error: "Resend returned no id" };
  }

  return {
    ok: true,
    emailId: res.data.id,
    matched: selection.matched.length,
    surprises: selection.surprises.length,
  };
}

export function defaultRegionIds(): string[] {
  try {
    return listRegionIds(rootDir);
  } catch {
    return [];
  }
}

// Re-exported for tests / scripts.
export { rootDir as newsletterRootDir };
export { path as nodePath };
