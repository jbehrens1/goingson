// Read/write newsletter state on a Clerk user's publicMetadata.
// Server-side only — uses Clerk's secret-key SDK.
//
// Storage shape:
//   user.publicMetadata.newsletter = { subscriptions: NewsletterSubscription[] }
//
// Migration: older users with the single-pref shape are silently upgraded
// to a one-item subscriptions array on read (see stateFromUser below).

import { clerkClient } from "@clerk/nextjs/server";
import type { User } from "@clerk/backend";
import type { NewsletterState, NewsletterSubscription } from "./types";
import { DEFAULT_SUBSCRIPTION, MAX_SUBSCRIPTIONS_PER_USER } from "./types";

const EMPTY_STATE: NewsletterState = { subscriptions: [] };

/**
 * Extract subscriptions from a Clerk User, transparently migrating the old
 * single-subscription shape if encountered.
 */
export function stateFromUser(user: Pick<User, "publicMetadata">): NewsletterState {
  const raw = (user.publicMetadata as { newsletter?: unknown })?.newsletter;
  if (!raw || typeof raw !== "object") return EMPTY_STATE;

  // New shape: { subscriptions: [...] }
  const asNew = raw as Partial<NewsletterState> & {
    subscribed?: unknown;
    region?: string;
    schedule?: unknown;
  };
  if (Array.isArray(asNew.subscriptions)) {
    return { subscriptions: asNew.subscriptions as NewsletterSubscription[] };
  }

  // Old shape: a single inline subscription. If subscribed === true, lift
  // it into a one-element subscriptions array. If subscribed === false,
  // drop it (user un-subscribed under the old model).
  if (asNew.subscribed === true && typeof asNew.region === "string") {
    const upgraded: NewsletterSubscription = {
      id: cryptoUuid(),
      name: `${asNew.region} ${asNew.schedule ?? "weekly"} digest`,
      ...DEFAULT_SUBSCRIPTION,
      ...(asNew as Partial<NewsletterSubscription>),
    } as NewsletterSubscription;
    return { subscriptions: [upgraded] };
  }
  return EMPTY_STATE;
}

export async function getStateForUserId(userId: string): Promise<NewsletterState> {
  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  return stateFromUser(user);
}

/**
 * Save the full subscriptions list. Trims surpriseHistory on each sub to
 * the last 30 entries and caps total subs at MAX_SUBSCRIPTIONS_PER_USER
 * (safety net for Clerk's 8KB publicMetadata limit).
 */
export async function saveStateForUserId(
  userId: string,
  next: NewsletterState,
): Promise<NewsletterState> {
  const client = await clerkClient();
  const user = await client.users.getUser(userId);

  const capped = next.subscriptions.slice(0, MAX_SUBSCRIPTIONS_PER_USER).map((s) => ({
    ...s,
    surpriseHistory: s.surpriseHistory?.slice(-30),
  }));

  await client.users.updateUser(userId, {
    publicMetadata: {
      ...user.publicMetadata,
      newsletter: { subscriptions: capped },
    },
  });
  return { subscriptions: capped };
}

/** Update a single subscription, identified by id. */
export async function patchSubscription(
  userId: string,
  subscriptionId: string,
  patch: Partial<NewsletterSubscription>,
): Promise<NewsletterState> {
  const state = await getStateForUserId(userId);
  const next: NewsletterState = {
    subscriptions: state.subscriptions.map((s) =>
      s.id === subscriptionId ? { ...s, ...patch, id: s.id } : s,
    ),
  };
  return saveStateForUserId(userId, next);
}

/** Add a new subscription. Throws if user already has MAX_SUBSCRIPTIONS. */
export async function addSubscription(
  userId: string,
  sub: Omit<NewsletterSubscription, "id">,
): Promise<{ state: NewsletterState; created: NewsletterSubscription }> {
  const state = await getStateForUserId(userId);
  if (state.subscriptions.length >= MAX_SUBSCRIPTIONS_PER_USER) {
    throw new Error(`Maximum ${MAX_SUBSCRIPTIONS_PER_USER} subscriptions per user`);
  }
  const created: NewsletterSubscription = { ...sub, id: cryptoUuid() };
  const next: NewsletterState = {
    subscriptions: [...state.subscriptions, created],
  };
  const saved = await saveStateForUserId(userId, next);
  return { state: saved, created };
}

/** Remove a subscription by id. Returns the new state. */
export async function deleteSubscription(
  userId: string,
  subscriptionId: string,
): Promise<NewsletterState> {
  const state = await getStateForUserId(userId);
  const next: NewsletterState = {
    subscriptions: state.subscriptions.filter((s) => s.id !== subscriptionId),
  };
  return saveStateForUserId(userId, next);
}

/**
 * Iterate every Clerk user once. Used by the cron handler to find users
 * with active subscriptions. Clerk paginates at 100/request.
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

function cryptoUuid(): string {
  return globalThis.crypto.randomUUID();
}
