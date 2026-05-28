import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { commitFileToGitHub } from "@/lib/github-commit";
import { listRegions } from "@/lib/sources-config";
import {
  pendingFilePath,
  readPending,
  serializePending,
  type PendingSuggestion,
} from "@/lib/pending-sources";
import { probeSource } from "@/lib/probe";
import type { SourceConfig } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: "Sign-in required" }, { status: 401 });
  }

  let body: {
    name?: string;
    url?: string;
    town?: string;
    regionId?: string;
    notes?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const name = body.name?.trim();
  const url = body.url?.trim();
  const regionId = body.regionId?.trim();
  if (!name || !url || !regionId) {
    return NextResponse.json(
      { ok: false, error: "name, url, and regionId are required" },
      { status: 400 },
    );
  }
  try {
    new URL(url);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid URL" }, { status: 400 });
  }
  const regions = await listRegions();
  if (!regions.includes(regionId)) {
    return NextResponse.json(
      { ok: false, error: `Unknown region "${regionId}"` },
      { status: 400 },
    );
  }

  // Run a best-effort probe against the URL so admin sees what we'd auto-wire
  // up. Use a stub source so probe doesn't reach for missing config.
  const stubSource: SourceConfig = {
    id: "pending",
    name,
    enabled: false,
    adapter: "html-generic",
    url,
    town: body.town,
  };
  let probeFindings: PendingSuggestion["probe"];
  try {
    const { candidates } = await probeSource(stubSource);
    probeFindings = {
      candidates: candidates.slice(0, 5).map((c) => ({
        confidence: c.confidence,
        verifiedCount: c.verifiedCount,
        adapter: c.adapter,
        url: c.url,
        config: c.config,
        evidence: c.evidence,
      })),
    };
  } catch (err) {
    probeFindings = { candidates: [] };
    console.error("probe failed for suggestion:", (err as Error).message);
  }

  const user = await currentUser();
  const submitter =
    user?.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)
      ?.emailAddress ??
    user?.emailAddresses[0]?.emailAddress ??
    userId;

  const suggestion: PendingSuggestion = {
    id: crypto.randomUUID(),
    submittedAt: new Date().toISOString(),
    submittedBy: submitter,
    name,
    url,
    town: body.town?.trim() || undefined,
    regionId,
    notes: body.notes?.trim() || undefined,
    probe: probeFindings,
  };

  const file = await readPending(process.cwd());
  // Reject obvious duplicates (same URL already queued or already a source —
  // sources-side dedupe happens at approval time, so just URL match here).
  if (
    file.pending.some(
      (p) => p.url.toLowerCase() === suggestion.url.toLowerCase(),
    )
  ) {
    return NextResponse.json(
      { ok: false, error: "This URL is already queued for review." },
      { status: 409 },
    );
  }
  file.pending.push(suggestion);

  const commit = await commitFileToGitHub({
    path: pendingFilePath(),
    content: serializePending(file),
    message: `suggest: ${submitter} added "${name}" (${regionId})`,
    authorName: user?.fullName ?? submitter,
    authorEmail: submitter.includes("@") ? submitter : "noreply@goingson.co",
  });
  if (!commit.ok) {
    return NextResponse.json(
      { ok: false, error: commit.error ?? "Commit failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    id: suggestion.id,
    probe: probeFindings,
  });
}
