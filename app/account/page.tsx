import { auth, currentUser } from "@clerk/nextjs/server";
import { authIsConfigured } from "@/lib/auth";
import { getStateForUserId } from "@/lib/newsletter/prefs";
import { listRegions } from "@/lib/sources-config";
import { loadVenuesByRegion, loadTownsByRegion } from "@/lib/region-data";
import { EVENT_TYPES } from "@/lib/categorize";
import { AccountSubscriptions } from "./AccountSubscriptions";

export const dynamic = "force-dynamic";

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
  const venuesByRegion = await loadVenuesByRegion(process.cwd(), regions);
  const townsByRegion = await loadTownsByRegion(process.cwd(), regions);

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
