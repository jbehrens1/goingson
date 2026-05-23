import { NextResponse, type NextRequest } from "next/server";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Pages that require an authenticated user. Sources view is public (anyone
// can see the list); the edit grid + save endpoints additionally enforce
// role checks in their own handlers.
const isProtectedRoute = createRouteMatcher([
  "/admin(.*)",
  "/account(.*)",
  "/api/sources(.*)",
  "/api/admin(.*)",
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
