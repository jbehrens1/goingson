import { clerkClient } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { authIsConfigured, getCurrentRole, type Role } from "@/lib/auth";
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

  const rows = users.data.map((u) => ({
    id: u.id,
    email:
      u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId)?.emailAddress ??
      u.emailAddresses[0]?.emailAddress ??
      "(no email)",
    name: u.fullName ?? "",
    role: ((u.publicMetadata?.role as Role | undefined) ?? "regular") as Role,
    createdAt: u.createdAt,
  }));

  return (
    <main className="sources-page">
      <header>
        <h1>Admin</h1>
        <p className="muted">
          {rows.length} user{rows.length === 1 ? "" : "s"}. Owners can promote others to
          admin or owner; admins can edit sources but can&rsquo;t change roles.
        </p>
      </header>
      <AdminUsersTable initialUsers={rows} />
    </main>
  );
}
