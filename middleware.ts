import { NextResponse, type NextRequest } from "next/server";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Pages that require an authenticated user. Sources view is public (anyone
// can see the list); the edit grid + save endpoints additionally enforce
// role checks in their own handlers.
const isProtectedRoute = createRouteMatcher([
  "/admin(.*)",
  "/account(.*)",
  "/sources/pending(.*)",
  "/api/sources(.*)",
  "/api/admin(.*)",
  "/api/suggest(.*)",
  "/api/account(.*)",
  "/api/newsletter(.*)",
]);

// Endpoints that must remain public for third-party callers (Resend webhook,
// Vercel Cron, and one-click unsubscribe from email clients). Discover-status
// is also here: the actual discovery action is admin-gated on dispatch, the
// polled result file is opaque-ID-keyed, and removing auth eliminates a
// Clerk-middleware "Unauthenticated → 404" race that the polling client
// otherwise sees as a missing route.
const isAlwaysPublic = createRouteMatcher([
  "/api/webhooks/(.*)",
  "/api/cron/(.*)",
  "/api/unsubscribe(.*)",
  "/api/admin/discover/status(.*)",
]);

const clerkConfigured = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY,
);

const clerkAware = clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export default function middleware(req: NextRequest, evt: Parameters<typeof clerkAware>[1]) {
  // Webhooks + cron + email unsubscribe links: skip Clerk entirely. They
  // authenticate via their own signatures / tokens / shared secrets and
  // are called by external services that won't have Clerk session cookies.
  if (isAlwaysPublic(req)) {
    return NextResponse.next();
  }
  // No Clerk env vars yet? Skip auth entirely so the site still renders.
  // Protected routes will 503 instead of crashing the middleware.
  if (!clerkConfigured) {
    if (isProtectedRoute(req)) {
      return new NextResponse("Auth not configured (Clerk env vars missing).", {
        status: 503,
      });
    }
    return NextResponse.next();
  }
  return clerkAware(req, evt);
}

export const config = {
  matcher: [
    // Skip Next internals, static files, and the public events JSON.
    "/((?!_next|events\\.[^/]*\\.json|regions\\.json|.*\\.(?:html?|css|js|jpg|jpeg|png|gif|svg|ico|webp|woff|woff2|ttf|otf)).*)",
    // Always run on API routes.
    "/(api|trpc)(.*)",
  ],
};
