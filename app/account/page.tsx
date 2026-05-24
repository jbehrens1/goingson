import { auth, currentUser } from "@clerk/nextjs/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { authIsConfigured } from "@/lib/auth";
import { getPrefsForUserId } from "@/lib/newsletter/prefs";
import { listRegions } from "@/lib/sources-config";
import { EVENT_TYPES } from "@/lib/categorize";
import type { EventRecord } from "@/lib/types";
import { AccountPrefs } from "./AccountPrefs";

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
        <p>Please sign in to manage your newsletter preferences.</p>
      </main>
    );
  }

  const user = await currentUser();
  const email =
    user?.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ??
    user?.emailAddresses[0]?.emailAddress ??
    "";

  const prefs = await getPrefsForUserId(userId);
  const regions = await listRegions();
  const venuesByRegion = await loadVenuesByRegion(regions);

  return (
    <main className="sources-page account-page">
      <header>
        <h1>Account</h1>
        <p className="muted">
          Signed in as <strong>{email}</strong>.
        </p>
      </header>

      <section>
        <h2>Newsletter</h2>
        <p className="muted small">
          Get a personalized digest of upcoming local events. Filters apply on every
          send; "surprise" frequency adds events from outside your filters at the level
          you choose.
        </p>
        <AccountPrefs
          initialPrefs={prefs}
          regions={regions}
          venuesByRegion={venuesByRegion}
          eventTypes={[...EVENT_TYPES]}
        />
      </section>
    </main>
  );
}
