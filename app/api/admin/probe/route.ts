import { NextResponse } from "next/server";
import path from "node:path";
import { requireRole } from "@/lib/auth";
import { loadRegion } from "@/lib/region";
import { loadSources } from "@/lib/ingest";
import { probeSource } from "@/lib/probe";

export const runtime = "nodejs";

// Admin-triggered re-probe. Forces "deep" mode regardless of source history
// so admins can manually re-investigate a source that historically yielded
// nothing (or a source that's broken in a new way and the regular probe
// wouldn't dig deep enough). Streams the full ProbeResult back as JSON so
// the UI can render every attempted URL inline.
//
// POST /api/admin/probe
// body: { regionId: string; sourceId: string; mode?: "light" | "deep" }
//
// Roles: admin or owner.

export async function POST(req: Request) {
  try {
    await requireRole("admin");
  } catch (res) {
    if (res instanceof Response) return res;
    throw res;
  }

  let body: { regionId?: string; sourceId?: string; mode?: "light" | "deep" };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const regionId = body.regionId?.trim();
  const sourceId = body.sourceId?.trim();
  const mode: "light" | "deep" = body.mode === "light" ? "light" : "deep";
  if (!regionId || !sourceId) {
    return NextResponse.json(
      { ok: false, error: "regionId and sourceId are required" },
      { status: 400 },
    );
  }

  const rootDir = process.cwd();
  try {
    loadRegion(rootDir, regionId); // throws if region unknown
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Unknown region: ${regionId}` },
      { status: 404 },
    );
  }

  const { sources } = await loadSources(rootDir, regionId);
  const source = sources.find((s) => s.id === sourceId);
  if (!source) {
    return NextResponse.json(
      { ok: false, error: `Unknown source: ${sourceId}` },
      { status: 404 },
    );
  }

  // Re-probe is bounded by the LOW_YIELD_THRESHOLD inside probeSource itself,
  // but we want to surface EVERY attempt, so we just call it directly.
  const startedAt = Date.now();
  const result = await probeSource(source, mode);
  const durationMs = Date.now() - startedAt;

  return NextResponse.json({
    ok: true,
    regionId,
    sourceId,
    mode,
    durationMs,
    result,
  });
}
