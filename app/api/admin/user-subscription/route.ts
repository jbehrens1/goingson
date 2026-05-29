import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import {
  patchSubscription,
  deleteSubscription,
  addSubscription,
  getStateForUserId,
} from "@/lib/newsletter/prefs";
import { DEFAULT_SUBSCRIPTION } from "@/lib/newsletter/types";

export const runtime = "nodejs";

// Admin endpoint for managing other users' newsletter subscriptions.
//
//   POST /api/admin/user-subscription
//     body: { userId: string; action: "list" | "patch" | "delete" | "add";
//             subscriptionId?: string; patch?: Partial<NewsletterSubscription>;
//             newSub?: Omit<NewsletterSubscription,"id"> }
//
// Owner/admin role required. The user-facing /api/account/subscription route
// uses the same underlying lib/newsletter/prefs functions, so any
// validation done there is mirrored here. Body fields are loosely typed in
// the API layer — Clerk's metadata is opaque JSON so excess fields go through
// harmlessly. Schema is enforced at the type layer.

export async function POST(req: Request) {
  try {
    await requireRole("admin");
  } catch (res) {
    if (res instanceof Response) return res;
    throw res;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
  const action = body?.action;
  if (!userId) {
    return NextResponse.json(
      { ok: false, error: "userId is required" },
      { status: 400 },
    );
  }

  try {
    if (action === "list") {
      const state = await getStateForUserId(userId);
      return NextResponse.json({ ok: true, state });
    }

    if (action === "patch") {
      const subscriptionId =
        typeof body.subscriptionId === "string" ? body.subscriptionId.trim() : "";
      if (!subscriptionId) {
        return NextResponse.json(
          { ok: false, error: "subscriptionId is required for patch" },
          { status: 400 },
        );
      }
      const patch = body.patch ?? {};
      if (typeof patch !== "object" || patch === null) {
        return NextResponse.json(
          { ok: false, error: "patch must be an object" },
          { status: 400 },
        );
      }
      const state = await patchSubscription(userId, subscriptionId, patch);
      return NextResponse.json({ ok: true, state });
    }

    if (action === "delete") {
      const subscriptionId =
        typeof body.subscriptionId === "string" ? body.subscriptionId.trim() : "";
      if (!subscriptionId) {
        return NextResponse.json(
          { ok: false, error: "subscriptionId is required for delete" },
          { status: 400 },
        );
      }
      const state = await deleteSubscription(userId, subscriptionId);
      return NextResponse.json({ ok: true, state });
    }

    if (action === "add") {
      const newSub = {
        ...DEFAULT_SUBSCRIPTION,
        name: "Untitled digest",
        ...(body.newSub ?? {}),
      };
      const result = await addSubscription(userId, newSub);
      return NextResponse.json({ ok: true, state: result.state, created: result.created });
    }

    return NextResponse.json(
      { ok: false, error: `Unknown action: ${action}` },
      { status: 400 },
    );
  } catch (err) {
    const msg = (err as Error).message;
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
