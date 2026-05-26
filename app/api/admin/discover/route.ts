// POST /api/admin/discover
// Body: { region: "lbi" | "metrowest" | "outercape" }
// Returns: { candidates: DiscoveredCandidate[], proposedCount, usage? }
//
// Admin/owner only. Runs the Claude-powered discovery and returns suggestions
// for admin review. Does NOT modify any source config — the admin reviews and
// then POSTs approved candidates to /api/admin/discover/add.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { discoverSourcesForRegion } from "@/lib/discover";

export const runtime = "nodejs";
// Claude + web search + tool use can take 30-60s. Stay at 60s so Vercel Hobby
// tier accepts the function. On Pro you can raise to 300.
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    await requireRole("admin");
  } catch (res) {
    if (res instanceof Response) return res;
    throw res;
  }

  let body: { region?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const region = (body.region ?? "").trim();
  if (!region || !/^[a-z0-9-]+$/.test(region)) {
    return NextResponse.json(
      { ok: false, error: "region required (lowercase id)" },
      { status: 400 },
    );
  }

  try {
    const result = await discoverSourcesForRegion(region);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg.includes("ANTHROPIC_API_KEY") ? "ANTHROPIC_API_KEY missing in env" : msg },
      { status: 500 },
    );
  }
}
