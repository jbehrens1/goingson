// Server component shell — gates on admin/owner role and renders the client
// component below. The client component handles the discover/approve UI.

import { redirect } from "next/navigation";
import { authIsConfigured, getCurrentRole } from "@/lib/auth";
import { listRegions } from "@/lib/sources-config";
import { DiscoverClient } from "./DiscoverClient";

export const dynamic = "force-dynamic";

export default async function DiscoverPage() {
  if (!authIsConfigured()) {
    return (
      <main style={{ padding: "2rem" }}>
        <h1>Source discovery</h1>
        <p>Auth not configured — set up Clerk to use this page.</p>
      </main>
    );
  }
  const role = await getCurrentRole();
  if (role !== "admin" && role !== "owner") redirect("/sources");

  const regions = await listRegions();

  return (
    <main style={{ padding: "1.5rem", maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ marginBottom: "0.25rem" }}>Source discovery</h1>
      <p style={{ color: "var(--muted)", marginBottom: "1.5rem", fontSize: "0.95rem" }}>
        LLM-powered search for new local event sources we don&apos;t already have. Pick a
        region, run discovery, review the suggestions, and approve the ones you want.
        Approved sources are added <strong>disabled</strong> — visit{" "}
        <a href="/sources">/sources</a> to enable and tune them.
      </p>
      <DiscoverClient regions={regions} />
    </main>
  );
}
