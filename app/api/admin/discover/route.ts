// POST /api/admin/discover
// Body: { region: "lbi" | "metrowest" | "outercape" }
// Returns: { ok: true, requestId, workflowRunUrl }
//
// Admin/owner only. Dispatches the discover.yml workflow on GitHub Actions
// (no time budget there, unlike Vercel's 60s cap). The workflow runs the
// Claude-powered discovery, then commits the results JSON to
// public/discover/<requestId>.json. The admin UI then polls
// /api/admin/discover/status?requestId=... until the file appears.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { dispatchDiscoverWorkflow } from "@/lib/github-dispatch";

export const runtime = "nodejs";
// We're only dispatching a workflow now — fast. Default function timeout is fine.
export const maxDuration = 15;

function generateRequestId(): string {
  // 20260526T140333-a1b2c3 — sortable + unique
  const now = new Date();
  const iso = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${iso}-${rand}`;
}

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

  const requestId = generateRequestId();
  const dispatched = await dispatchDiscoverWorkflow({ region, requestId });
  if (!dispatched.ok) {
    return NextResponse.json(
      { ok: false, error: dispatched.error ?? "Failed to dispatch workflow" },
      { status: 500 },
    );
  }

  const repo = process.env.GITHUB_REPO ?? "";
  return NextResponse.json({
    ok: true,
    requestId,
    region,
    workflowRunUrl: repo ? `https://github.com/${repo}/actions/workflows/discover.yml` : undefined,
  });
}
