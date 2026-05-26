// POST /api/admin/discover/add
// Body: {
//   region: "lbi",
//   sources: [{ name, url, suggestedAdapter, town?, kind?, rationale? }, ...]
// }
// Returns: { ok: true, added: N, commitSha }
//
// Admin/owner only. Appends each approved candidate to the region's
// sources.json (DISABLED by default — the admin should enable per source
// after reviewing/probing). Commits via the GitHub API so changes persist
// past Vercel's read-only filesystem.

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
import { slugifyId } from "@/lib/pending-sources";
import type { AdapterType, SourceConfig } from "@/lib/types";

export const runtime = "nodejs";

type IncomingSource = {
  name?: string;
  url?: string;
  suggestedAdapter?: string;
  town?: string;
  kind?: string;
  rationale?: string;
};

export async function POST(req: Request) {
  try {
    await requireRole("admin");
  } catch (res) {
    if (res instanceof Response) return res;
    throw res;
  }

  let body: { region?: string; sources?: IncomingSource[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const region = (body.region ?? "").trim();
  if (!region || !/^[a-z0-9-]+$/.test(region)) {
    return NextResponse.json({ ok: false, error: "region required" }, { status: 400 });
  }
  const incoming = Array.isArray(body.sources) ? body.sources : [];
  if (incoming.length === 0) {
    return NextResponse.json({ ok: false, error: "sources[] required" }, { status: 400 });
  }
  if (incoming.length > 50) {
    return NextResponse.json(
      { ok: false, error: "Too many sources at once (max 50)" },
      { status: 400 },
    );
  }

  // Validate each
  const sourcesFile = await readSources(region);
  const existingIds = new Set(sourcesFile.sources.map((s) => s.id));
  const existingHosts = new Set(
    sourcesFile.sources
      .map((s) => safeHost(s.url))
      .filter((h): h is string => !!h),
  );
  const toAdd: SourceConfig[] = [];
  const rejected: Array<{ name?: string; reason: string }> = [];

  for (const raw of incoming) {
    if (!raw.name || !raw.url) {
      rejected.push({ name: raw.name, reason: "missing name or url" });
      continue;
    }
    try {
      new URL(raw.url);
    } catch {
      rejected.push({ name: raw.name, reason: "invalid url" });
      continue;
    }
    const host = safeHost(raw.url);
    if (host && existingHosts.has(host)) {
      rejected.push({ name: raw.name, reason: "duplicate hostname already in sources" });
      continue;
    }
    const adapter =
      raw.suggestedAdapter && VALID_ADAPTERS.includes(raw.suggestedAdapter as AdapterType)
        ? (raw.suggestedAdapter as AdapterType)
        : "html-generic";
    const id = slugifyId(raw.name, existingIds);
    existingIds.add(id);
    if (host) existingHosts.add(host);
    toAdd.push({
      id,
      name: raw.name.trim(),
      // Disabled by default — admin should review the probe + URL before
      // enabling, and may want to set defaultEventType / titleRules first.
      enabled: false,
      adapter,
      url: raw.url.trim(),
      town: raw.town?.trim() || undefined,
      category: raw.kind?.trim() || undefined,
      notes: [
        `Discovered via /admin/discover.`,
        raw.rationale?.trim(),
      ]
        .filter(Boolean)
        .join(" "),
      config: {},
    });
  }

  if (toAdd.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No valid sources to add", rejected },
      { status: 400 },
    );
  }

  const nextSources = {
    ...sourcesFile,
    sources: [...sourcesFile.sources, ...toAdd],
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

  const commit = await commitFileToGitHub({
    path: sourcesFilePath(region),
    content: serializeSources(nextSources),
    message: `sources: discovery batch (${toAdd.length} candidates) → ${region} (${reviewer})`,
    authorName: user?.fullName ?? reviewer,
    authorEmail: reviewer.includes("@") ? reviewer : "noreply@goingson.co",
  });
  if (!commit.ok) {
    return NextResponse.json(
      { ok: false, error: commit.error ?? "commit failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    added: toAdd.length,
    rejected,
    addedIds: toAdd.map((s) => s.id),
    commitSha: commit.commitSha,
  });
}

function safeHost(u: string): string | null {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}
