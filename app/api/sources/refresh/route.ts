// POST /api/sources/refresh
// Body: { regionId: string, sourceId: string }
//
// Admin/owner only. Dispatches the ingest workflow with INGEST_ONLY=<sourceId>
// so the runner re-fetches just one source and commits the refreshed events
// JSON. Lets admins iterate on a single venue without waiting for the daily
// cron or kicking off a full-region ingest.

import { NextResponse } from "next/server";
import { currentUser } from "@clerk/nextjs/server";
import { requireRole } from "@/lib/auth";
import { dispatchIngestWorkflow } from "@/lib/github-dispatch";
import { readSources } from "@/lib/sources-config";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function POST(req: Request) {
  try {
    await requireRole("admin");
  } catch (res) {
    if (res instanceof Response) return res;
    throw res;
  }

  let body: { regionId?: string; sourceId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const regionId = (body.regionId ?? "").trim();
  const sourceId = (body.sourceId ?? "").trim();
  if (!regionId || !/^[a-z0-9-]+$/.test(regionId)) {
    return NextResponse.json(
      { ok: false, error: "regionId required (lowercase id)" },
      { status: 400 },
    );
  }
  if (!sourceId || !/^[a-z0-9-]+$/.test(sourceId)) {
    return NextResponse.json(
      { ok: false, error: "sourceId required (lowercase id)" },
      { status: 400 },
    );
  }

  // Sanity check: source actually exists in that region's sources.json.
  // Catches typos before they manifest as a workflow-error 2 minutes later.
  const sourcesFile = await readSources(regionId);
  const source = sourcesFile.sources.find((s) => s.id === sourceId);
  if (!source) {
    return NextResponse.json(
      { ok: false, error: `Source "${sourceId}" not found in region "${regionId}"` },
      { status: 404 },
    );
  }

  const user = await currentUser();
  const reviewer =
    user?.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)
      ?.emailAddress ??
    user?.emailAddresses[0]?.emailAddress ??
    user?.id ??
    "admin";

  const dispatched = await dispatchIngestWorkflow({
    regionId,
    onlySource: sourceId,
    reason: `${reviewer} refreshed ${source.name}`,
  });
  if (!dispatched.ok) {
    return NextResponse.json(
      { ok: false, error: dispatched.error ?? "Failed to dispatch workflow" },
      { status: 500 },
    );
  }

  const repo = process.env.GITHUB_REPO ?? "";
  return NextResponse.json({
    ok: true,
    sourceId,
    regionId,
    workflowRunUrl: repo
      ? `https://github.com/${repo}/actions/workflows/ingest.yml`
      : undefined,
  });
}
