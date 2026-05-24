// One-click unsubscribe handler. Verifies an HMAC token signed at send time
// (no login required) and flips the user's subscribed flag to false.
//
// Supports both GET (when a human clicks the link) AND POST (when Gmail or
// Apple Mail's native one-click Unsubscribe button fires per RFC 8058).

import { NextResponse } from "next/server";
import { savePrefsForUserId } from "@/lib/newsletter/prefs";
import { verifyUnsubscribeToken } from "@/lib/newsletter/token";

export const runtime = "nodejs";

async function handle(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const userId = url.searchParams.get("u");
  const token = url.searchParams.get("t");
  if (!userId || !token) {
    return new NextResponse("Missing token", { status: 400 });
  }
  if (!verifyUnsubscribeToken(userId, token)) {
    return new NextResponse("Invalid or expired token", { status: 403 });
  }
  try {
    await savePrefsForUserId(userId, { subscribed: false });
  } catch (err) {
    return new NextResponse(`Update failed: ${(err as Error).message}`, { status: 500 });
  }

  // For GET, render a tiny HTML confirmation. For POST (Gmail/Apple's native
  // button), return 200 with no body.
  if (req.method === "POST") {
    return new NextResponse(null, { status: 200 });
  }
  const manageUrl = new URL("/account", url.origin).toString();
  return new NextResponse(
    `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Unsubscribed · Goings On</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         max-width: 480px; margin: 4rem auto; padding: 1rem; color: #111418; line-height: 1.55; }
  h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }
  .muted { color: #5b6470; }
  a { color: #1d4ed8; }
</style>
</head><body>
<h1>You're unsubscribed.</h1>
<p>You won't receive any more Goings On newsletter emails.</p>
<p class="muted">Changed your mind? You can re-enable the newsletter any time on your
<a href="${manageUrl}">account page</a>.</p>
</body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
