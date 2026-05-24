import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getPrefsForUserId, savePrefsForUserId } from "@/lib/newsletter/prefs";
import { listRegions } from "@/lib/sources-config";
import { EVENT_TYPES, type EventType } from "@/lib/categorize";
import {
  LOOKAHEAD_MAX,
  LOOKAHEAD_MIN,
  type NewsletterPrefs,
  type Schedule,
  type SurpriseLevel,
} from "@/lib/newsletter/types";

export const runtime = "nodejs";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });
  const prefs = await getPrefsForUserId(userId);
  return NextResponse.json({ ok: true, prefs });
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });

  let body: Partial<NewsletterPrefs>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  // Validate every field we accept; reject anything we don't recognize.
  const patch: Partial<NewsletterPrefs> = {};
  if (typeof body.subscribed === "boolean") patch.subscribed = body.subscribed;
  if (typeof body.region === "string") {
    const regions = await listRegions();
    if (!regions.includes(body.region)) {
      return NextResponse.json(
        { ok: false, error: `Unknown region "${body.region}"` },
        { status: 400 },
      );
    }
    patch.region = body.region;
  }
  if (body.schedule === "daily" || body.schedule === "weekly") {
    patch.schedule = body.schedule as Schedule;
  } else if (body.schedule !== undefined) {
    return NextResponse.json(
      { ok: false, error: "schedule must be daily or weekly" },
      { status: 400 },
    );
  }
  if (typeof body.lookaheadDays === "number") {
    const n = Math.round(body.lookaheadDays);
    if (n < LOOKAHEAD_MIN || n > LOOKAHEAD_MAX) {
      return NextResponse.json(
        {
          ok: false,
          error: `lookaheadDays must be between ${LOOKAHEAD_MIN} and ${LOOKAHEAD_MAX}`,
        },
        { status: 400 },
      );
    }
    patch.lookaheadDays = n;
  }
  if (Array.isArray(body.types)) {
    const valid = (EVENT_TYPES as readonly string[]).slice();
    patch.types = body.types.filter((t): t is EventType => valid.includes(t));
  }
  if (Array.isArray(body.venues)) {
    patch.venues = body.venues.filter((v): v is string => typeof v === "string").slice(0, 200);
  }
  if (body.center === null) {
    patch.center = undefined;
  } else if (
    body.center &&
    typeof body.center.lat === "number" &&
    typeof body.center.lon === "number" &&
    typeof body.center.label === "string"
  ) {
    patch.center = {
      lat: body.center.lat,
      lon: body.center.lon,
      label: body.center.label.slice(0, 200),
    };
  }
  if (body.radiusMi === null || body.radiusMi === undefined) {
    if ("radiusMi" in body) patch.radiusMi = undefined;
  } else if (typeof body.radiusMi === "number" && body.radiusMi > 0 && body.radiusMi < 500) {
    patch.radiusMi = body.radiusMi;
  }
  if (["never", "sometimes", "often"].includes(body.surprise ?? "")) {
    patch.surprise = body.surprise as SurpriseLevel;
  }

  const next = await savePrefsForUserId(userId, patch);
  return NextResponse.json({ ok: true, prefs: next });
}
