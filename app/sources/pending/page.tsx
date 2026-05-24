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

  const file = await readPending(process.cwd());
  const regions = await listRegions();

  return (
    <main className="sources-page">
      <header>
        <h1>Pending venue suggestions</h1>
        <p className="muted">
          {file.pending.length} suggestion{file.pending.length === 1 ? "" : "s"} awaiting
          review. Approving moves the entry into the chosen region&rsquo;s sources.json;
          rejecting deletes it from the queue.
        </p>
      </header>
      <PendingList initial={file.pending} regions={regions} />
    </main>
  );
}
