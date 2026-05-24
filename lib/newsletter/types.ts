import type { EventType } from "../categorize";

export type Schedule = "daily" | "weekly";
export type SurpriseLevel = "never" | "sometimes" | "often";

/**
 * Newsletter preferences stored on Clerk user.publicMetadata.newsletter.
 * Empty arrays = "no filter applied" (i.e. all values qualify).
 *
 * Stays under Clerk's 8KB metadata cap as long as venues[] is < ~100 entries
 * and surpriseHistory is trimmed to 30 most recent.
 */
export type NewsletterPrefs = {
  subscribed: boolean;
  /** Which region's events the digest pulls from. */
  region: string;
  schedule: Schedule;
  /** Event types the user wants. Empty = all. */
  types: EventType[];
  /** Venue names the user wants. Empty = all. */
  venues: string[];
  /** Optional geographic center for distance filtering. */
  center?: { label: string; lat: number; lon: number };
  /** Radius in miles around `center`. Ignored if center is not set. */
  radiusMi?: number;
  /** How aggressive to be about including "off-filter" surprise events. */
  surprise: SurpriseLevel;
  /** ISO timestamp of the last successful send. Used to skip duplicate sends. */
  lastSentAt?: string;
  /** Event IDs recently shown as surprises (capped at 30) so we avoid repeats. */
  surpriseHistory?: string[];
};

export const DEFAULT_PREFS: NewsletterPrefs = {
  subscribed: false,
  region: "metrowest",
  schedule: "weekly",
  types: [],
  venues: [],
  surprise: "sometimes",
};

/** How many surprise events to include based on the level. */
export const SURPRISE_K: Record<SurpriseLevel, number> = {
  never: 0,
  sometimes: 2,
  often: 5,
};
