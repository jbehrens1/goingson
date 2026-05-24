import { NextResponse } from "next/server";
import { currentUser } from "@clerk/nextjs/server";
import { requireRole } from "@/lib/auth";
import { commitFileToGitHub } from "@/lib/github-commit";
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

  // 2) Remove from pending and commit
  const nextPending = {
    ...pendingFile,
    pending: pendingFile.pending.filter((p) => p.id !== suggestionId),
  };
  const commitPending = await commitFileToGitHub({
    path: pendingFilePath(),
    content: serializePending(nextPending),
    message: `pending: remove "${item.name}" (approved)`,
    authorName: user?.fullName ?? reviewer,
    authorEmail: reviewer.includes("@") ? reviewer : "noreply@goingson.co",
  });
  if (!commitPending.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: `Source added but pending removal failed: ${commitPending.error}`,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, sourceId: newId });
}
