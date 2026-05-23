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

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next internals, static files, and the public events JSON.
    "/((?!_next|events\\.[^/]*\\.json|regions\\.json|.*\\.(?:html?|css|js|jpg|jpeg|png|gif|svg|ico|webp|woff|woff2|ttf|otf)).*)",
    // Always run on API routes.
    "/(api|trpc)(.*)",
  ],
};
