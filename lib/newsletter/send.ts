// Build + send a digest to one user for one subscription. Used by both
// /api/cron/newsletter (iterates subscriptions per user) and
// /api/newsletter/test (one subscription on demand).

import { Resend } from "resend";
import { render } from "@react-email/render";
import Newsletter from "@/emails/Newsletter";
import { loadRegion, listRegionIds } from "../region";
import type { EventRecord } from "../types";
import { selectDigest, loadRegionEvents } from "./select";
import type { NewsletterSubscription } from "./types";
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

/** Pre-load events for each region once per cron tick. */
export async function loadEventsForRegions(
  regionIds: string[],
): Promise<Map<string, EventRecord[]>> {
  const out = new Map<string, EventRecord[]>();
  for (const id of regionIds) {
    try {
      out.set(id, await loadRegionEvents(rootDir, id));
    } catch {
      // missing payload — skip; the per-sub send will report this
    }
  }
  return out;
}

/**
 * Decide whether a subscription is due for a send right now.
 * Daily: skip if its lastSentAt is within 18h (avoids double-sends on retries).
 * Weekly: only Fridays; skip if lastSentAt within 5 days.
 */
export function isDueNow(sub: NewsletterSubscription, now: Date = new Date()): boolean {
  const lastMs = sub.lastSentAt ? new Date(sub.lastSentAt).getTime() : 0;
  const ageH = (now.getTime() - lastMs) / 3_600_000;
  if (sub.schedule === "daily") return ageH > 18;
  // Weekly: Friday only (UTC; close enough across US ET / PT for ~7am sends).
  if (now.getUTCDay() !== 5) return false;
  return ageH > 5 * 24;
}

/**
 * Send a digest for one subscription. `forceSend` bypasses the
 * lastSentAt cooldown (used by the /account "Send me a preview" button).
 */
export async function sendDigest(opts: {
  recipient: RecipientRef;
  sub: NewsletterSubscription;
  eventsByRegion: Map<string, EventRecord[]>;
  baseUrl: string;
  forceSend?: boolean;
  now?: Date;
}): Promise<SendResult> {
  const { recipient, sub, eventsByRegion, baseUrl, forceSend } = opts;
  const now = opts.now ?? new Date();

  if (!forceSend && !isDueNow(sub, now)) {
    return { ok: true, skipped: "not due yet" };
  }

  const events = eventsByRegion.get(sub.region);
  if (!events) {
    return { ok: false, error: `No events payload for region "${sub.region}"` };
  }

  // Region metadata for the email header / TZ.
  let regionDisplayName = sub.region;
  let timeZone: string | undefined;
  try {
    const r = loadRegion(rootDir, sub.region);
    regionDisplayName = r.config.displayName;
    timeZone = r.config.timeZone;
  } catch {
    /* fall back to defaults above */
  }

  const selection = selectDigest(events, sub, now);
  if (selection.matched.length === 0 && selection.surprises.length === 0) {
    return { ok: true, skipped: "no events to show" };
  }

  const unsubUrl = unsubscribeUrl(baseUrl, recipient.userId, sub.id);
  const manageUrl = new URL("/account", baseUrl).toString();
  const subscribeUrl = manageUrl;

  const newsletterProps = {
    recipientFirstName: recipient.firstName,
    regionDisplayName,
    subscriptionName: sub.name,
    schedule: sub.schedule,
    windowStart: selection.windowStart,
    windowEnd: selection.windowEnd,
    matched: selection.matched,
    surprises: selection.surprises,
    unsubscribeUrl: unsubUrl,
    manageUrl,
    subscribeUrl,
    timeZone,
  };
  const html = await render(Newsletter(newsletterProps));
  const text = await render(Newsletter(newsletterProps), { plainText: true });

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from) {
    return { ok: false, error: "RESEND_API_KEY or RESEND_FROM not configured" };
  }
  const resend = new Resend(apiKey);

  // Tag every send for Resend dashboard slicing + analytics ingest.
  const tags = [
    { name: "region", value: sub.region },
    { name: "schedule", value: sub.schedule },
    { name: "surprise", value: sub.surprise },
    { name: "subscription_id", value: sub.id },
  ];

  const total = selection.matched.length + selection.surprises.length;
  const subject = `${sub.name} · ${total} pick${total === 1 ? "" : "s"} ${
    sub.schedule === "daily" ? "today" : "this week"
  }`;

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

  if (res.error) return { ok: false, error: res.error.message };
  if (!res.data?.id) return { ok: false, error: "Resend returned no id" };

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

export { rootDir as newsletterRootDir };
export { path as nodePath };
