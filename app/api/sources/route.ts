import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { commitFileToGitHub } from "@/lib/github-commit";
import { dispatchIngestWorkflow } from "@/lib/github-dispatch";
import {
  listRegions,
  readSources,
  serializeSources,
  sourcesFilePath,
  validateSources,
} from "@/lib/sources-config";
import type { SourceConfig } from "@/lib/types";
import { currentUser } from "@clerk/nextjs/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    await requireRole("admin");
  } catch (res) {
    if (res instanceof Response) return res;
    throw res;
  }

  let body: { region?: string; sources?: SourceConfig[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const region = body.region;
  if (!region || !/^[a-z0-9][a-z0-9-]*$/.test(region)) {
    return NextResponse.json({ ok: false, error: "Invalid region" }, { status: 400 });
  }
  const regions = await listRegions();
  if (!regions.includes(region)) {
    return NextResponse.json(
      { ok: false, error: `Unknown region "${region}"` },
      { status: 400 },
    );
  }

  const errors = validateSources(body.sources);
  if (errors.length > 0) {
    return NextResponse.json(
      { ok: false, error: "Validation failed", details: errors },
      { status: 400 },
    );
  }

  // Preserve the $comment from the original file so that documentation about
  // the region's source list survives editor round-trips.
  const existing = await readSources(region);
  const serialized = serializeSources({
    $comment: existing.$comment,
    sources: body.sources as SourceConfig[],
  });

  const user = await currentUser();
  const editor =
    user?.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ??
    user?.emailAddresses[0]?.emailAddress ??
    user?.id ??
    "unknown";

  const result = await commitFileToGitHub({
    path: sourcesFilePath(region),
    content: serialized,
    message: `sources: ${editor} edited ${region} via /sources`,
    authorName: user?.fullName ?? editor,
    authorEmail: editor.includes("@") ? editor : "noreply@metrowest-events.local",
  });

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error ?? "Commit failed" },
      { status: 500 },
    );
  }

  // Trigger an immediate re-ingest of the edited region so the live events
  // JSON reflects the new source config in ~2 min instead of waiting for the
  // next daily cron tick. Non-fatal: if dispatch fails (e.g. token lacks
  // Actions:RW), we still report the commit succeeded so the admin can
  // re-trigger manually from the Actions tab.
  const dispatch = await dispatchIngestWorkflow({
    regionId: region,
    reason: `${editor} edited ${region}`,
  });

  return NextResponse.json({
    ok: true,
    commitSha: result.commitSha,
    rescan: dispatch.ok
      ? { triggered: true }
      : { triggered: false, error: dispatch.error },
  });
}
