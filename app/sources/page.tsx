import { promises as fs } from "node:fs";
import path from "node:path";
import { getCurrentRole, authIsConfigured } from "@/lib/auth";
import { listRegions, readSources } from "@/lib/sources-config";
import type { SourceConfig } from "@/lib/types";
import { SourcesEditor } from "./SourcesEditor";

export const dynamic = "force-dynamic";

type RegionEventSummary = Record<string, { count: number; generatedAt?: string }>;

async function loadRegionEventCounts(regions: string[]): Promise<RegionEventSummary> {
  const out: RegionEventSummary = {};
  for (const region of regions) {
    const file = path.join(process.cwd(), "public", `events.${region}.json`);
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as {
        events: Array<{ source: { id: string } }>;
        generatedAt: string;
      };
      const counts: Record<string, number> = {};
      for (const ev of parsed.events) counts[ev.source.id] = (counts[ev.source.id] ?? 0) + 1;
      for (const [sid, count] of Object.entries(counts)) {
        out[`${region}:${sid}`] = { count, generatedAt: parsed.generatedAt };
      }
    } catch {
      // missing region payload — leave counts empty
    }
  }
  return out;
}

export default async function SourcesPage() {
  const configured = authIsConfigured();
  const role = configured ? await getCurrentRole() : null;
  const canEdit = role === "admin" || role === "owner";

  const regions = await listRegions();
  const eventCounts = await loadRegionEventCounts(regions);

  const perRegion: Array<{ region: string; sources: SourceConfig[] }> = [];
  for (const region of regions) {
    const file = await readSources(region);
    perRegion.push({ region, sources: file.sources });
  }

  return (
    <main className="sources-page">
      <header>
        <h1>Sources</h1>
        <p className="muted">
          Every event source configured for the daily ingest, grouped by region. Counts
          reflect the last ingest run.
        </p>
        {!configured && (
          <p className="hint hint-error">
            Auth is not configured (missing Clerk env vars). Editing is disabled until
            Clerk is set up.
          </p>
        )}
        {configured && !role && (
          <p className="hint">Sign in to see your role. Admins and owners can edit sources.</p>
        )}
        {configured && role === "regular" && (
          <p className="hint">You&rsquo;re signed in as <strong>regular</strong>. Editing requires admin or owner.</p>
        )}
      </header>

      {perRegion.map(({ region, sources }) => (
        <section key={region} className="sources-region">
          <h2>
            {region} <span className="muted">· {sources.length} sources</span>
          </h2>
          <SourcesEditor
            region={region}
            initialSources={sources}
            eventCounts={Object.fromEntries(
              Object.entries(eventCounts)
                .filter(([k]) => k.startsWith(`${region}:`))
                .map(([k, v]) => [k.slice(region.length + 1), v.count]),
            )}
            canEdit={canEdit}
          />
        </section>
      ))}
    </main>
  );
}
