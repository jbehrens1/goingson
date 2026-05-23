import { auth, clerkClient, currentUser } from "@clerk/nextjs/server";

export type Role = "regular" | "admin" | "owner";

const ROLE_ORDER: Record<Role, number> = { regular: 0, admin: 1, owner: 2 };

export function roleAtLeast(have: Role, want: Role): boolean {
  return ROLE_ORDER[have] >= ROLE_ORDER[want];
}

/**
 * Returns the role stored on the current user's Clerk publicMetadata, or
 * null if no user is signed in. Bootstraps the configured OWNER_EMAIL to
 * 'owner' role on first call after sign-in so the project always has an
 * owner without manual Clerk dashboard fiddling.
 */
export async function getCurrentRole(): Promise<Role | null> {
  const user = await currentUser();
  if (!user) return null;

  const ownerEmail = process.env.OWNER_EMAIL?.toLowerCase().trim();
  const primaryEmail =
    user.emailAddresses
      .find((e) => e.id === user.primaryEmailAddressId)
      ?.emailAddress?.toLowerCase() ??
    user.emailAddresses[0]?.emailAddress?.toLowerCase();

  const existing = (user.publicMetadata?.role as Role | undefined) ?? null;

  // Owner bootstrap: if the signed-in user matches OWNER_EMAIL and isn't
  // already owner, upgrade them. Persists across sessions.
  if (ownerEmail && primaryEmail === ownerEmail && existing !== "owner") {
    const client = await clerkClient();
    await client.users.updateUser(user.id, {
      publicMetadata: { ...user.publicMetadata, role: "owner" },
    });
    return "owner";
  }

  return existing ?? "regular";
}

/**
 * Throws a Response with status 403 if the current user isn't at least the
 * required role. Use inside API routes.
 */
export async function requireRole(want: Role): Promise<Role> {
  const { userId } = await auth();
  if (!userId) {
    throw new Response(JSON.stringify({ error: "Not signed in" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  const have = await getCurrentRole();
  if (!have || !roleAtLeast(have, want)) {
    throw new Response(JSON.stringify({ error: `Requires ${want}` }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  return have;
}

export function authIsConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY,
  );
}
