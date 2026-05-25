import path from "node:path";
import { promises as fs } from "node:fs";
import { redirect } from "next/navigation";
import { authIsConfigured, getCurrentRole } from "@/lib/auth";
import { readPending } from "@/lib/pending-sources";
import { listRegions } from "@/lib/sources-config";
import { PendingList } from "./PendingList";

export const dynamic = "force-dynamic";

export default async function PendingPage() {
  if (!authIsConfigured()) {
    return (
      <main className="sources-page">
        <h1>Pending suggestions</h1>
        <p className="hint hint-error">Auth is not configured.</p>
      </main>
    );
  }
  const role = await getCurrentRole();
  if (role !== "admin" && role !== "owner") {
    redirect("/sources");
  }

  // Defensive: file read can fail if the bundle didn't include the JSON.
  // Surface the error in the UI instead of silently rendering an empty list.
  let pending: Awaited<ReturnType<typeof readPending>>["pending"] = [];
  let loadError: string | null = null;
  const cwd = process.cwd();
  const expectedPath = path.join(cwd, "config/pending-sources.json");
  let fileExists = false;
  try {
    await fs.access(expectedPath);
    fileExists = true;
  } catch {
    /* file genuinely doesn't exist on disk in the deployed bundle */
  }
  try {
    const file = await readPending(cwd);
    pending = file.pending;
  } catch (err) {
    loadError = (err as Error).message;
  }

  const regions = await listRegions();

  return (
    <main className="sources-page">
      <header>
        <h1>Pending venue suggestions</h1>
        <p className="muted">
          {pending.length} suggestion{pending.length === 1 ? "" : "s"} awaiting review.
          Approving moves the entry into the chosen region&rsquo;s sources.json;
          rejecting deletes it from the queue.
        </p>
        {(loadError || !fileExists) && (
          <details className="hint hint-error" style={{ marginTop: "0.5rem" }}>
            <summary>
              {loadError
                ? "Couldn't load pending list"
                : "Pending file isn't in the deployed bundle"}
            </summary>
            <pre style={{ whiteSpace: "pre-wrap", marginTop: "0.5rem" }}>
              cwd: {cwd}
              {"\n"}expected: {expectedPath}
              {"\n"}file exists on disk: {String(fileExists)}
              {loadError ? `\nread error: ${loadError}` : ""}
            </pre>
          </details>
        )}
      </header>
      <PendingList initial={pending} regions={regions} />
    </main>
  );
}
