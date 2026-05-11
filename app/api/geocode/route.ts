import { NextResponse } from "next/server";
import { geocode } from "@/lib/geocode";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  if (!q) {
    return NextResponse.json({ ok: false, error: "missing q" }, { status: 400 });
  }
  const result = await geocode(q, { rootDir: process.cwd(), applyRegionBias: true });
  if (!result) {
    return NextResponse.json({ ok: false, error: "no result" }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    lat: result.lat,
    lon: result.lon,
    displayName: result.displayName,
    cached: result.cached,
  });
}
