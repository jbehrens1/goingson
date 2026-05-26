// GET /api/admin/discover/status?requestId=<id>
//
// Polled by the admin UI while a discovery workflow is running. Reads
// the result JSON directly from GitHub raw content (bypassing Vercel's
// deploy cycle, which would otherwise delay results by 1-2 min). Returns
// the result payload once the workflow commits it; returns
// { ok: true, status: "pending" } until then.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function GET(req: Request) {
  try {
    await requireRole("admin");
  } catch (res) {
    if (res instanceof Response) return res;
    throw res;
  }

  const url = new URL(req.url);
  const requestId = (url.searchParams.get("requestId") ?? "").trim();
  if (!requestId || !/^[A-Za-z0-9_-]+$/.test(requestId)) {
    return NextResponse.json({ ok: false, error: "requestId required" }, { status: 400 });
  }

  const repo = process.env.GITHUB_REPO;
  if (!repo) {
    return NextResponse.json(
      { ok: false, error: "GITHUB_REPO not configured" },
      { status: 500 },
    );
  }

  const rawUrl = `https://raw.githubusercontent.com/${repo}/main/public/discover/${requestId}.json`;
  const token = process.env.GITHUB_TOKEN;

  // Private repos need authentication; public repos work without. Send the
  // token if we have one so the same code works either way.
  const headers: Record<string, string> = {
    "User-Agent": "goingson-editor",
    // Cache-bust raw.githubusercontent.com which caches aggressively (5+ min).
    "Cache-Control": "no-cache",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${rawUrl}?t=${Date.now()}`, { headers, cache: "no-store" });
  if (res.status === 404) {
    return NextResponse.json({ ok: true, status: "pending" });
  }
  if (!res.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: `Failed to fetch result file: HTTP ${res.status}`,
      },
      { status: 500 },
    );
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Result file is not valid JSON" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, status: "complete", result: payload });
}
