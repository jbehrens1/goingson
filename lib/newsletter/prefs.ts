// Read/write newsletter preferences on a Clerk user's publicMetadata.
// Server-side only — uses Clerk's secret-key SDK.

import { clerkClient } from "@clerk/nextjs/server";
import type { User } from "@clerk/backend";
import type { NewsletterPrefs } from "./types";
import { DEFAULT_PREFS } from "./types";

/** Extract prefs from a Clerk User object, applying defaults for missing keys. */
export function prefsFromUser(user: Pick<User, "publicMetadata">): NewsletterPrefs {
  const raw = (user.publicMetadata as { newsletter?: Partial<NewsletterPrefs> })
    ?.newsletter;
  return { ...DEFAULT_PREFS, ...(raw ?? {}) };
}

export async function getPrefsForUserId(userId: string): Promise<NewsletterPrefs> {
  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  return prefsFromUser(user);
}

export async function savePrefsForUserId(
  userId: string,
  patch: Partial<NewsletterPrefs>,
): Promise<NewsletterPrefs> {
  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  const current = prefsFromUser(user);
  const next: NewsletterPrefs = { ...current, ...patch };

  // Trim surprise history to last 30 to stay under Clerk's 8KB metadata cap.
  if (next.surpriseHistory && next.surpriseHistory.length > 30) {
    next.surpriseHistory = next.surpriseHistory.slice(-30);
  }

  await client.users.updateUser(userId, {
    publicMetadata: {
      ...user.publicMetadata,
      newsletter: next,
    },
  });
  return next;
}

/**
 * Iterate every Clerk user once. Used by the cron handler to find who's due
 * for a send. Clerk paginates at 100/request; we hold pages in memory and
 * yield individual users. Fine up to ~10k users; past that, migrate to a DB.
 */
export async function* iterateAllUsers(): AsyncGenerator<User> {
  const client = await clerkClient();
  let offset = 0;
  const limit = 100;
  for (;;) {
    const page = await client.users.getUserList({ limit, offset });
    for (const u of page.data) yield u;
    if (page.data.length < limit) return;
    offset += limit;
  }
}
