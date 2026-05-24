import { NextResponse } from "next/server";
import { currentUser } from "@clerk/nextjs/server";
import { requireRole } from "@/lib/auth";
import { commitFileToGitHub } from "@/lib/github-commit";
import {
  pendingFilePath,
  readPending,
  serializePending,
} from "@/lib/pending-sources";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    await requireRole("admin");
  } catch (res) {
    if (res instanceof Response) return res;
    throw res;
  }

  let body: { suggestionId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.suggestionId) {
    return NextResponse.json(
      { ok: false, error: "suggestionId required" },
      { status: 400 },
    );
  }

  const file = await readPending(process.cwd());
  const item = file.pending.find((p) => p.id === body.suggestionId);
  if (!item) {
    return NextResponse.json(
      { ok: false, error: "Suggestion not found" },
      { status: 404 },
    );
  }

  const next = {
    ...file,
    pending: file.pending.filter((p) => p.id !== body.suggestionId),
  };

  const user = await currentUser();
  const reviewer =
    user?.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)
      ?.emailAddress ??
    user?.emailAddresses[0]?.emailAddress ??
    user?.id ??
    "unknown";

  const commit = await commitFileToGitHub({
    path: pendingFilePath(),
    content: serializePending(next),
    message: `pending: rejected "${item.name}" (${reviewer})`,
    authorName: user?.fullName ?? reviewer,
    authorEmail: reviewer.includes("@") ? reviewer : "noreply@goingson.co",
  });
  if (!commit.ok) {
    return NextResponse.json(
      { ok: false, error: commit.error ?? "Commit failed" },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
