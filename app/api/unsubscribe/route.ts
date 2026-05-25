// One-click unsubscribe — scoped to ONE subscription (not the whole user
// account). Verifies an HMAC token signed at send time (no login required),
// removes that specific subscription.
//
// Supports GET (human clicks the link) and POST (Gmail/Apple native button).
// URL shape: /api/unsubscribe?u=<userId>&s=<subId>&t=<token>

import { NextResponse } from "next/server";
import { deleteSubscription, getStateForUserId } from "@/lib/newsletter/prefs";
import { verifyUnsubscribeToken } from "@/lib/newsletter/token";

export const runtime = "nodejs";

async function handle(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const userId = url.searchParams.get("u");
  const subId = url.searchParams.get("s");
  const token = url.searchParams.get("t");
  if (!userId || !subId || !token) {
    return new NextResponse("Missing token", { status: 400 });
  }
  if (!verifyUnsubscribeToken(userId, subId, token)) {
    return new NextResponse("Invalid or expired token", { status: 403 });
  }

  let removedName: string | undefined;
  try {
    const before = await getStateForUserId(userId);
    removedName = before.subscriptions.find((s) => s.id === subId)?.name;
    await deleteSubscription(userId, subId);
  } catch (err) {
    return new NextResponse(`Update failed: ${(err as Error).message}`, { status: 500 });
  }

  if (req.method === "POST") return new NextResponse(null, { status: 200 });

  const manageUrl = new URL("/account", url.origin).toString();
  const label = removedName ? `<strong>${escapeHtml(removedName)}</strong>` : "that subscription";
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
<p>${label} has been removed. Any other Goings On newsletters you subscribe to will keep arriving.</p>
<p class="muted">Manage all your subscriptions on your <a href="${manageUrl}">account page</a>.</p>
</body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
