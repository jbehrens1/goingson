import Link from "next/link";
import { SignInButton, UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { authIsConfigured, getCurrentRole } from "@/lib/auth";

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

  return (
    <nav className="site-header">
      <div className="site-header-inner">
        <Link href="/" className="site-header-brand">
          MetroWest Events
        </Link>
        <div className="site-header-links">
          <Link href="/sources">Sources</Link>
          {isOwner && <Link href="/admin">Admin</Link>}
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
