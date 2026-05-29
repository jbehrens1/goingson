import { clerkClient } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { authIsConfigured, getCurrentRole, type Role } from "@/lib/auth";
import { stateFromUser } from "@/lib/newsletter/prefs";
import { listRegions } from "@/lib/sources-config";
import { loadTownsByRegion, loadVenuesByRegion } from "@/lib/region-data";
import { EVENT_TYPES } from "@/lib/categorize";
import { AdminUsersTable } from "./AdminUsersTable";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  if (!authIsConfigured()) {
    return (
      <main className="sources-page">
        <h1>Admin</h1>
        <p className="hint hint-error">Auth is not configured. Set Clerk env vars.</p>
      </main>
    );
  }

  const role = await getCurrentRole();
  if (role !== "owner") {
    // Non-owners can't see the user list. Send admins back to /sources.
    redirect("/sources");
  }

  const client = await clerkClient();
  const users = await client.users.getUserList({ limit: 200, orderBy: "-created_at" });

  // Same option lists the user-facing /account editor uses, so admin pickers
  // see the same towns/venues/types as the user would. Computed once at
  // page-load time (small region count, fast).
  const regions = await listRegions();
  const venuesByRegion = await loadVenuesByRegion(process.cwd(), regions);
  const townsByRegion = await loadTownsByRegion(process.cwd(), regions);

  // Pull each user's newsletter subscriptions off Clerk publicMetadata via the
  // same helper /account uses, so the admin view stays in sync with the
  // user-facing one. The migration path for the old single-sub shape is
  // handled in stateFromUser.
  const rows = users.data.map((u) => {
    const { subscriptions } = stateFromUser(u);
    return {
      id: u.id,
      email:
        u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId)?.emailAddress ??
        u.emailAddresses[0]?.emailAddress ??
        "(no email)",
      name: u.fullName ?? "",
      role: ((u.publicMetadata?.role as Role | undefined) ?? "regular") as Role,
      createdAt: u.createdAt,
      subscriptions,
    };
  });

  return (
    <main className="sources-page">
      <header>
        <h1>Admin</h1>
        <p className="muted">
          {rows.length} user{rows.length === 1 ? "" : "s"}. Owners can promote others to
          admin or owner; admins can edit sources but can&rsquo;t change roles. Click a
          subscription count to see its filters.
        </p>
      </header>
      <AdminUsersTable
        initialUsers={rows}
        regions={regions}
        venuesByRegion={venuesByRegion}
        townsByRegion={townsByRegion}
        eventTypes={[...EVENT_TYPES]}
      />
    </main>
  );
}
