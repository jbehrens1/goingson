import { NextResponse } from "next/server";
import { currentUser } from "@clerk/nextjs/server";
import { requireRole } from "@/lib/auth";
import { commitFileToGitHub } from "@/lib/github-commit";
import { dispatchIngestWorkflow } from "@/lib/github-dispatch";
import {
  readSources,
  serializeSources,
  sourcesFilePath,
  validateSources,
  VALID_ADAPTERS,
} from "@/lib/sources-config";
import {
  pendingFilePath,
  readPending,
  serializePending,
  slugifyId,
} from "@/lib/pending-sources";
import type { AdapterType, SourceConfig } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    await requireRole("admin");
  } catch (res) {
    if (res instanceof Response) return res;
    throw res;
  }

  let body: {
    suggestionId?: string;
    override?: {
      adapter?: string;
      url?: string;
      config?: Record<string, unknown>;
    };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const { suggestionId, override } = body;
  if (!suggestionId) {
    return NextResponse.json(
      { ok: false, error: "suggestionId required" },
      { status: 400 },
    );
  }
  if (
    !override?.adapter ||
    !VALID_ADAPTERS.includes(override.adapter as AdapterType)
  ) {
    return NextResponse.json(
      { ok: false, error: "Invalid adapter override" },
      { status: 400 },
    );
  }
  if (!override.url) {
    return NextResponse.json({ ok: false, error: "URL required" }, { status: 400 });
  }
  try {
    new URL(override.url);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid URL" }, { status: 400 });
  }

  // Find the suggestion in pending.json
  const pendingFile = await readPending(process.cwd());
  const item = pendingFile.pending.find((p) => p.id === suggestionId);
  if (!item) {
    return NextResponse.json(
      { ok: false, error: "Suggestion not found" },
      { status: 404 },
    );
  }

  // Build the SourceConfig for the target region, assigning a unique id slug.
  const sourcesFile = await readSources(item.regionId);
  const existingIds = new Set(sourcesFile.sources.map((s) => s.id));
  const newId = slugifyId(item.name, existingIds);

  const newSource: SourceConfig = {
    id: newId,
    name: item.name,
    enabled: true,
    adapter: override.adapter as AdapterType,
    url: override.url,
    town: item.town,
    notes: [
      `Added via /suggest by ${item.submittedBy} on ${item.submittedAt.slice(0, 10)}.`,
      item.notes,
    ]
      .filter(Boolean)
      .join(" "),
    ...(override.config ? { config: override.config } : {}),
  };

  const nextSources = {
    ...sourcesFile,
    sources: [...sourcesFile.sources, newSource],
  };
  const errors = validateSources(nextSources.sources);
  if (errors.length > 0) {
    return NextResponse.json(
      { ok: false, error: "Validation failed", details: errors },
      { status: 400 },
    );
  }

  const user = await currentUser();
  const reviewer =
    user?.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)
      ?.emailAddress ??
    user?.emailAddresses[0]?.emailAddress ??
    user?.id ??
    "unknown";

  // 1) Commit the new source into the region's sources.json
  const commitSource = await commitFileToGitHub({
    path: sourcesFilePath(item.regionId),
    content: serializeSources(nextSources),
    message: `sources: approved suggestion "${item.name}" → ${item.regionId} (${reviewer})`,
    authorName: user?.fullName ?? reviewer,
    authorEmail: reviewer.includes("@") ? reviewer : "noreply@goingson.co",
  });
  if (!commitSource.ok) {
    return NextResponse.json(
      { ok: false, error: commitSource.error ?? "sources.json commit failed" },
      { status: 500 },
    );
  }

  // 2) Remove from pending and commit. The first commit already succeeded
  //    (source is live in sources.json), so a failure here shouldn't fail
  //    the whole approve — that just leaves the user with a wrong-looking
  //    pending list and no recourse. Retry once with a fresh SHA read; if
  //    it still fails, return 200 with a `pendingRemoval` warning so the UI
  //    can surface it.
  let pendingRemoval: { ok: boolean; error?: string } = { ok: true };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const freshPendingFile =
      attempt === 1 ? pendingFile : await readPending(process.cwd());
    const stillThere = freshPendingFile.pending.some(
      (p) => p.id === suggestionId,
    );
    if (!stillThere) {
      // Someone (maybe a parallel approve) already removed it. Done.
      pendingRemoval = { ok: true };
      break;
    }
    const nextPending = {
      ...freshPendingFile,
      pending: freshPendingFile.pending.filter((p) => p.id !== suggestionId),
    };
    const result = await commitFileToGitHub({
      path: pendingFilePath(),
      content: serializePending(nextPending),
      message: `pending: remove "${item.name}" (approved)`,
      authorName: user?.fullName ?? reviewer,
      authorEmail: reviewer.includes("@") ? reviewer : "noreply@goingson.co",
    });
    if (result.ok) {
      pendingRemoval = { ok: true };
      break;
    }
    pendingRemoval = { ok: false, error: result.error };
    // Brief backoff before retry — covers transient SHA-conflict races
    // (when ingest cron or another admin commit lands between our reads).
    if (attempt === 1) await new Promise((r) => setTimeout(r, 600));
  }

  // Kick off an immediate ingest of the target region so the newly approved
  // source's events show up on the live site in ~2 min. Reason is passed
  // through GitHub workflow_dispatch inputs — its content is plumbed into
  // bash via an env var (not interpolated), so quotes here are safe.
  const dispatch = await dispatchIngestWorkflow({
    regionId: item.regionId,
    reason: `${reviewer} approved "${item.name}"`,
  });

  return NextResponse.json({
    ok: true,
    sourceId: newId,
    pendingRemoval,
    rescan: dispatch.ok
      ? { triggered: true }
      : { triggered: false, error: dispatch.error },
  });
}
