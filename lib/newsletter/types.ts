import type { EventType } from "../categorize";

export type Schedule = "daily" | "weekly";
export type SurpriseLevel = "never" | "sometimes" | "often";

/**
 * One subscription. A user can have several (e.g. "LBI daily music,"
 * "MetroWest weekly family events"). Each is independently sent,
 * due-checked, and unsubscribable. Stored under
 * user.publicMetadata.newsletter.subscriptions[].
 */
export type NewsletterSubscription = {
  /** UUID, used to scope unsubscribe tokens and update operations. */
  id: string;
  /** User-given label shown in the email subject and on /account. */
  name: string;
  /** Which region's events the digest pulls from. */
  region: string;
  schedule: Schedule;
  /** Days of upcoming events each digest covers (1-30). Independent from schedule. */
  lookaheadDays: number;
  /** Event types this digest includes. Empty = all. */
  types: EventType[];
  /** Town names this digest includes. Empty = all. Independent from
   *  center+radius distance filter — set this when the user wants events
   *  from a specific list of towns regardless of how far the town centroid
   *  is from any pin they've placed. */
  towns?: string[];
  /** Venue names this digest includes. Empty = all. */
  venues: string[];
  /** Optional geographic center for distance filtering. */
  center?: { label: string; lat: number; lon: number };
  /** Radius in miles around `center`. Ignored if center isn't set. */
  radiusMi?: number;
  /** How aggressively to include "off-filter" surprise events. */
  surprise: SurpriseLevel;
  /** ISO timestamp of the last successful send for this sub. */
  lastSentAt?: string;
  /** Event IDs recently shown as surprises (capped at 30) so we avoid repeats. */
  surpriseHistory?: string[];
};

/**
 * Top-level newsletter blob stored on user.publicMetadata.newsletter.
 * The old single-sub `NewsletterPrefs` shape is silently migrated to a
 * one-item subscriptions array on read (see lib/newsletter/prefs.ts).
 */
export type NewsletterState = {
  subscriptions: NewsletterSubscription[];
};

export const DEFAULT_SUBSCRIPTION: Omit<NewsletterSubscription, "id" | "name"> = {
  region: "metrowest",
  schedule: "weekly",
  lookaheadDays: 7,
  types: [],
  towns: [],
  venues: [],
  surprise: "sometimes",
};

export const LOOKAHEAD_MIN = 1;
export const LOOKAHEAD_MAX = 30;

/** Hard cap to keep all subscriptions under Clerk's 8KB metadata limit. */
export const MAX_SUBSCRIPTIONS_PER_USER = 10;

/** How many surprise events to include based on the level. */
export const SURPRISE_K: Record<SurpriseLevel, number> = {
  never: 0,
  sometimes: 2,
  often: 5,
};
