// Newsletter subscription CRUD. The /account page calls these endpoints to
// list, add, update, and delete the signed-in user's subscriptions.
//
// GET                  → current state (list of subscriptions)
// POST                 → add a new subscription (body = NewsletterSubscription
//                        without id; server assigns one). Returns the created
//                        subscription + new state.
// PATCH { id, patch }  → update an existing subscription by id
// DELETE { id }        → remove a subscription by id

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  addSubscription,
  deleteSubscription,
  getStateForUserId,
  patchSubscription,
} from "@/lib/newsletter/prefs";
import { listRegions } from "@/lib/sources-config";
import { EVENT_TYPES, type EventType } from "@/lib/categorize";
import {
  DEFAULT_SUBSCRIPTION,
  LOOKAHEAD_MAX,
  LOOKAHEAD_MIN,
  type NewsletterSubscription,
  type Schedule,
  type SurpriseLevel,
} from "@/lib/newsletter/types";

export const runtime = "nodejs";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });
  }
  const state = await getStateForUserId(userId);
  return NextResponse.json({ ok: true, state });
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });
  }
  let body: Partial<NewsletterSubscription>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const validated = await validateSubscription(body, { newSub: true });
  if ("ok" in validated) {
    return NextResponse.json(validated, { status: 400 });
  }
  try {
    const result = await addSubscription(
      userId,
      validated.sub as Omit<NewsletterSubscription, "id">,
    );
    return NextResponse.json({ ok: true, created: result.created, state: result.state });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 400 },
    );
  }
}

export async function PATCH(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });
  }
  let body: { id?: string; patch?: Partial<NewsletterSubscription> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.id) {
    return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  }
  const validated = await validateSubscription(body.patch ?? {}, { newSub: false });
  if ("ok" in validated) {
    return NextResponse.json(validated, { status: 400 });
  }
  const state = await patchSubscription(userId, body.id, validated.sub);
  return NextResponse.json({ ok: true, state });
}

export async function DELETE(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });
  }
  let body: { id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.id) {
    return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  }
  const state = await deleteSubscription(userId, body.id);
  return NextResponse.json({ ok: true, state });
}

/**
 * Validate + normalize incoming body. When `newSub` is true, applies
 * DEFAULT_SUBSCRIPTION to missing fields and requires region.
 */
type Validated =
  | { sub: Partial<NewsletterSubscription> }
  | { ok: false; error: string };

async function validateSubscription(
  body: Partial<NewsletterSubscription>,
  { newSub }: { newSub: boolean },
): Promise<Validated> {
  const out: Partial<NewsletterSubscription> = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return { ok: false, error: "name must be a non-empty string" };
    }
    out.name = body.name.trim().slice(0, 100);
  }
  if (body.region !== undefined) {
    const regions = await listRegions();
    if (typeof body.region !== "string" || !regions.includes(body.region)) {
      return { ok: false, error: `Unknown region "${body.region}"` };
    }
    out.region = body.region;
  }
  if (body.schedule !== undefined) {
    if (body.schedule !== "daily" && body.schedule !== "weekly") {
      return { ok: false, error: "schedule must be daily or weekly" };
    }
    out.schedule = body.schedule as Schedule;
  }
  if (body.lookaheadDays !== undefined) {
    const n =
      typeof body.lookaheadDays === "number"
        ? Math.round(body.lookaheadDays)
        : Number.NaN;
    if (!Number.isFinite(n) || n < LOOKAHEAD_MIN || n > LOOKAHEAD_MAX) {
      return {
        ok: false,
        error: `lookaheadDays must be between ${LOOKAHEAD_MIN} and ${LOOKAHEAD_MAX}`,
      };
    }
    out.lookaheadDays = n;
  }
  if (Array.isArray(body.types)) {
    const valid = (EVENT_TYPES as readonly string[]).slice();
    out.types = body.types.filter((t): t is EventType => valid.includes(t));
  }
  if (Array.isArray(body.venues)) {
    out.venues = body.venues
      .filter((v): v is string => typeof v === "string")
      .slice(0, 200);
  }
  if (body.center === null) {
    out.center = undefined;
  } else if (
    body.center &&
    typeof body.center.lat === "number" &&
    typeof body.center.lon === "number" &&
    typeof body.center.label === "string"
  ) {
    out.center = {
      lat: body.center.lat,
      lon: body.center.lon,
      label: body.center.label.slice(0, 200),
    };
  }
  if (body.radiusMi === null) {
    out.radiusMi = undefined;
  } else if (
    typeof body.radiusMi === "number" &&
    body.radiusMi > 0 &&
    body.radiusMi < 500
  ) {
    out.radiusMi = body.radiusMi;
  }
  if (
    typeof body.surprise === "string" &&
    ["never", "sometimes", "often"].includes(body.surprise)
  ) {
    out.surprise = body.surprise as SurpriseLevel;
  }

  if (newSub) {
    if (!out.region) {
      return { ok: false, error: "region required for new subscription" };
    }
    if (!out.name) out.name = `${out.region} ${out.schedule ?? "weekly"} digest`;
    return { sub: { ...DEFAULT_SUBSCRIPTION, ...out } };
  }
  return { sub: out };
}
