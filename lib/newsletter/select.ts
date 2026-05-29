// Given a user's prefs and the events for their region, returns the set of
// events to include in the next digest: matched (passes filters) + surprises
// (intentionally outside filters, picked randomly with anti-repeat logic).

import { readFile } from "node:fs/promises";
import path from "node:path";
import { haversineMiles } from "../towns";
import type { EventRecord } from "../types";
import type { NewsletterSubscription } from "./types";
import { SURPRISE_K } from "./types";

export type DigestSelection = {
  matched: EventRecord[];
  surprises: EventRecord[];
  /** Window the digest covers, in ISO date strings. */
  windowStart: string;
  windowEnd: string;
};

const DAY_MS = 86_400_000;

/**
 * Load events for a region from public/events.<region>.json.
 * Called per-cron-tick rather than per-user so we hit disk once.
 */
export async function loadRegionEvents(
  rootDir: string,
  regionId: string,
): Promise<EventRecord[]> {
  const file = path.join(rootDir, "public", `events.${regionId}.json`);
  const raw = await readFile(file, "utf8");
  const parsed = JSON.parse(raw) as { events: EventRecord[] };
  return parsed.events;
}

/**
 * Filter + pick events for one user's digest.
 *
 *  - Lookahead window is the user's `lookaheadDays` pref (default 7, range 1-30).
 *  - Cap matched at 50 (daily schedule) / 100 (weekly schedule) to keep emails
 *    readable — the schedule, not the window, controls density.
 *  - Surprise events come from outside the user's type/venue/distance
 *    filters; their count is determined by sub.surprise.
 *  - We avoid showing the same surprise twice within sub.surpriseHistory.
 */
export function selectDigest(
  events: EventRecord[],
  sub: NewsletterSubscription,
  now: Date = new Date(),
): DigestSelection {
  // Honor the user's window; clamp to a sane range in case stored pref is bad.
  const horizonDays = Math.min(30, Math.max(1, sub.lookaheadDays ?? 7));
  const windowStart = new Date(now.getTime());
  const windowEnd = new Date(now.getTime() + horizonDays * DAY_MS);

  const inWindow = events.filter((ev) => {
    const ts = new Date(ev.start).getTime();
    return ts >= windowStart.getTime() && ts <= windowEnd.getTime();
  });

  function passesUserFilters(ev: EventRecord): boolean {
    if (sub.types.length > 0 && !sub.types.includes(ev.type)) return false;
    if (sub.towns && sub.towns.length > 0) {
      const t = ev.location?.town?.trim() ?? "";
      if (!sub.towns.includes(t)) return false;
    }
    if (sub.venues.length > 0) {
      const v = ev.location?.venue?.trim() ?? "";
      if (!sub.venues.includes(v)) return false;
    }
    if (sub.center && sub.radiusMi != null && sub.radiusMi > 0) {
      const lat = ev.location?.lat;
      const lon = ev.location?.lon;
      if (lat == null || lon == null) return false;
      const d = haversineMiles(
        { lat: sub.center.lat, lon: sub.center.lon },
        { lat, lon },
      );
      if (d > sub.radiusMi) return false;
    }
    return true;
  }

  const matched = inWindow
    .filter(passesUserFilters)
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, sub.schedule === "daily" ? 50 : 100);

  // Surprise pool: in-window events that DID NOT match the user's filters,
  // and weren't shown as a surprise within the recent history.
  const recentHistory = new Set(sub.surpriseHistory ?? []);
  const surprisePool = inWindow.filter(
    (ev) => !passesUserFilters(ev) && !recentHistory.has(ev.id),
  );

  const k = SURPRISE_K[sub.surprise];
  const surprises = pickRandom(surprisePool, k).sort((a, b) =>
    a.start.localeCompare(b.start),
  );

  return {
    matched,
    surprises,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
  };
}

/** Fisher–Yates partial shuffle → take K. */
function pickRandom<T>(arr: T[], k: number): T[] {
  if (k <= 0 || arr.length === 0) return [];
  const n = Math.min(k, arr.length);
  const copy = [...arr];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}
