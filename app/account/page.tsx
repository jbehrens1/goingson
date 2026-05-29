import { auth, currentUser } from "@clerk/nextjs/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { authIsConfigured } from "@/lib/auth";
import { getStateForUserId } from "@/lib/newsletter/prefs";
import { listRegions } from "@/lib/sources-config";
import { EVENT_TYPES } from "@/lib/categorize";
import type { EventRecord } from "@/lib/types";
import { AccountSubscriptions } from "./AccountSubscriptions";

export const dynamic = "force-dynamic";

/** Load the venue catalog for the venue-picker (per region). */
async function loadVenuesByRegion(
  regions: string[],
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const r of regions) {
    try {
      const file = path.join(process.cwd(), "public", `events.${r}.json`);
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as { events: EventRecord[] };
      const venues = new Set<string>();
      for (const e of parsed.events) {
        const v = e.location?.venue?.trim();
        if (v) venues.add(v);
      }
      out[r] = [...venues].sort();
    } catch {
      out[r] = [];
    }
  }
  return out;
}

/** Union of town names that appear in (a) the region's curated towns.json
 *  and (b) the actual ingested events — so picker options always reflect
 *  reality even when an event references a town not yet in the curated list. */
async function loadTownsByRegion(
  regions: string[],
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const r of regions) {
    const towns = new Set<string>();
    // Curated town list
    try {
      const tFile = path.join(process.cwd(), "config/regions", r, "towns.json");
      const tRaw = await readFile(tFile, "utf8");
      const tParsed = JSON.parse(tRaw) as { towns?: Array<{ name?: string }> };
      for (const t of tParsed.towns ?? []) {
        if (t.name) towns.add(t.name.trim());
      }
    } catch {
      /* no towns.json — fall back to ingested-events scan only */
    }
    // Ingested-events scan
    try {
      const eFile = path.join(process.cwd(), "public", `events.${r}.json`);
      const eRaw = await readFile(eFile, "utf8");
      const eParsed = JSON.parse(eRaw) as { events: EventRecord[] };
      for (const e of eParsed.events) {
        const t = e.location?.town?.trim();
        if (t) towns.add(t);
      }
    } catch {
      /* no events file yet */
    }
    out[r] = [...towns].sort();
  }
  return out;
}

export default async function AccountPage() {
  if (!authIsConfigured()) {
    return (
      <main className="sources-page">
        <h1>Account</h1>
        <p className="hint hint-error">Auth is not configured.</p>
      </main>
    );
  }
  const { userId } = await auth();
  if (!userId) {
    return (
      <main className="sources-page">
        <h1>Account</h1>
        <p>Please sign in to manage your newsletter subscriptions.</p>
      </main>
    );
  }

  const user = await currentUser();
  const email =
    user?.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ??
    user?.emailAddresses[0]?.emailAddress ??
    "";

  const state = await getStateForUserId(userId);
  const regions = await listRegions();
  const venuesByRegion = await loadVenuesByRegion(regions);
  const townsByRegion = await loadTownsByRegion(regions);

  return (
    <main className="sources-page account-page">
      <header>
        <h1>Account</h1>
        <p className="muted">
          Signed in as <strong>{email}</strong>.
        </p>
      </header>

      <section>
        <h2>Newsletter subscriptions</h2>
        <p className="muted small">
          Subscribe to multiple personalized digests — pick a different region,
          schedule, or filter set for each one. Every subscription sends + can
          be unsubscribed from independently.
        </p>
        <AccountSubscriptions
          initialState={state}
          regions={regions}
          venuesByRegion={venuesByRegion}
          townsByRegion={townsByRegion}
          eventTypes={[...EVENT_TYPES]}
        />
      </section>
    </main>
  );
}
