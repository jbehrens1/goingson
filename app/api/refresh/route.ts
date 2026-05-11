import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { runIngest } from "@/lib/ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// On serverless hosts (Vercel/Cloudflare) the filesystem is read-only at
// runtime, so running the ingest would either silently fail or partially write.
// Detect those hosts and short-circuit with a friendly message — refreshes
// happen via the daily GitHub Actions workflow instead.
function isReadOnlyRuntime(): boolean {
  return (
    process.env.VERCEL === "1" ||
    process.env.CF_PAGES === "1" ||
    process.env.READONLY === "1"
  );
}

export async function POST() {
  if (isReadOnlyRuntime()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Live refresh is disabled in production. Events refresh automatically every morning via GitHub Actions.",
      },
      { status: 503 },
    );
  }

  const rootDir = process.cwd();
  try {
    const report = await runIngest({ rootDir, dryRun: false });
    const filePath = path.join(rootDir, "public", "events.json");
    const raw = await readFile(filePath, "utf8");
    const payload = JSON.parse(raw);
    return NextResponse.json({ ok: true, report, payload });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
