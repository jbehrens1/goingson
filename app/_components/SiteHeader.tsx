import Link from "next/link";
import { SignInButton, UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { authIsConfigured, getCurrentRole } from "@/lib/auth";
import { readPending } from "@/lib/pending-sources";

export async function SiteHeader() {
  const configured = authIsConfigured();
  let userId: string | null = null;
  let role: Awaited<ReturnType<typeof getCurrentRole>> = null;
  if (configured) {
    const a = await auth();
    userId = a.userId;
    if (userId) role = await getCurrentRole();
  }
  const isAdmin = role === "admin" || role === "owner";
  const isOwner = role === "owner";

  // Show a pending-suggestions count badge in the header for admins.
  let pendingCount = 0;
  if (isAdmin) {
    try {
      const file = await readPending(process.cwd());
      pendingCount = file.pending.length;
    } catch {
      // ignore — file may not exist yet
    }
  }

  return (
    <nav className="site-header">
      <div className="site-header-inner">
        <Link href="/" className="site-header-brand">
          Goings On
        </Link>
        <div className="site-header-links">
          <Link href="/sources">Sources</Link>
          <Link href="/suggest">Suggest a venue</Link>
          {userId && <Link href="/account">Newsletter</Link>}
          {isAdmin && (
            // Consolidates the per-admin destinations behind one dropdown.
            // <details> gives us a click-to-open menu without needing a
            // client component; the rest of the header stays server-rendered.
            <details className="header-dropdown">
              <summary>
                Admin
                {pendingCount > 0 && (
                  <span
                    className="header-badge"
                    title={`${pendingCount} pending suggestion${pendingCount === 1 ? "" : "s"}`}
                  >
                    {pendingCount}
                  </span>
                )}
                <span className="header-dropdown-caret" aria-hidden>▾</span>
              </summary>
              <div className="header-dropdown-menu" role="menu">
                {isOwner && (
                  <Link href="/admin" role="menuitem">
                    Users
                  </Link>
                )}
                <Link href="/admin/discover" role="menuitem">
                  Discover
                </Link>
                <Link href="/sources/pending" role="menuitem">
                  Pending
                  {pendingCount > 0 && (
                    <span className="header-badge">{pendingCount}</span>
                  )}
                </Link>
                <Link href="/admin/qc" role="menuitem">
                  QC
                </Link>
              </div>
            </details>
          )}
        </div>
        <div className="site-header-auth">
          {!configured ? (
            <span className="site-header-muted" title="Set Clerk env vars to enable auth">
              auth not configured
            </span>
          ) : userId ? (
            <>
              {isAdmin && (
                <span className="site-header-role" title={`Role: ${role}`}>
                  {role}
                </span>
              )}
              <UserButton />
            </>
          ) : (
            <SignInButton mode="modal">
              <button type="button" className="site-header-signin">
                Sign in
              </button>
            </SignInButton>
          )}
        </div>
      </div>
    </nav>
  );
}
