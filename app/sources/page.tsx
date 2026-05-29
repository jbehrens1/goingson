import { promises as fs } from "node:fs";
import path from "node:path";
import { redirect } from "next/navigation";
import { getCurrentRole, authIsConfigured } from "@/lib/auth";
import { listRegions, readSources } from "@/lib/sources-config";
import type { SourceConfig } from "@/lib/types";
import { SourcesEditor, type SourceHealth } from "./SourcesEditor";

export const dynamic = "force-dynamic";

type RegionEventSummary = Record<string, { count: number; generatedAt?: string }>;

async function loadSourceHealth(): Promise<Record<string, SourceHealth>> {
  const file = path.join(process.cwd(), "public", "source-health.json");
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as {
      sources: Record<string, SourceHealth>;
    };
    return parsed.sources ?? {};
  } catch {
    return {};
  }
}

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

  // Sources is an admin-only page now (moved out of the top-nav and into
  // the Admin dropdown). When Clerk is configured, redirect non-admin
  // viewers home. The dev/local mode (no Clerk) still renders so the page
  // is usable during initial setup.
  if (configured && !canEdit) {
    redirect("/");
  }

  const regions = await listRegions();
  const eventCounts = await loadRegionEventCounts(regions);
  const sourceHealth = await loadSourceHealth();

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
      </header>

      {perRegion.map(({ region, sources }) => {
        const counts = Object.fromEntries(
          Object.entries(eventCounts)
            .filter(([k]) => k.startsWith(`${region}:`))
            .map(([k, v]) => [k.slice(region.length + 1), v.count]),
        );
        const totalEvents = Object.values(counts).reduce<number>(
          (a, b) => a + (b as number),
          0,
        );
        const enabledSources = sources.filter((s) => s.enabled);
        const enabled = enabledSources.length;

        // Per-region health stats surfaced in the collapsed accordion summary
        // so admins can spot trouble regions at a glance without expanding.
        // Each badge is conditionally rendered (only when count > 0) so
        // well-functioning regions stay clean.
        //
        //   lowYield: enabled sources with <5 events. Matches the
        //     LOW_YIELD_THRESHOLD that triggers a probe at ingest time.
        //   zeroYield: enabled sources with exactly 0. Subset of lowYield;
        //     called out separately because they're the most urgent.
        //   autoFixed: sources where the probe auto-applied an adapter
        //     swap on the most recent ingest. Worth reviewing but not
        //     broken — keeps the admin in the loop on automation.
        //   probeLeads: sources where the probe surfaced candidate fixes
        //     but didn't auto-apply (low/medium confidence). These are
        //     the next-best targets for manual review.
        let lowYield = 0;
        let zeroYield = 0;
        let autoFixed = 0;
        let probeLeads = 0;
        for (const s of enabledSources) {
          const c = counts[s.id] ?? 0;
          if (c === 0) zeroYield++;
          if (c < 5) lowYield++;
          const h = sourceHealth[`${region}:${s.id}`];
          if (h?.probe?.autoApplied) autoFixed++;
          if (h?.probe?.candidates && h.probe.candidates.length > 0 && !h.probe.autoApplied) {
            probeLeads++;
          }
        }
        // Average events per *enabled* source. Gives a rough "health
        // score" so the admin can compare regions ("MetroWest averages
        // 12 events per source, Coachella averages 6").
        const avgEvents = enabled > 0 ? Math.round(totalEvents / enabled) : 0;

        return (
          <details key={region} className="sources-region">
            <summary>
              <span className="sources-region-name">{region}</span>
              <span className="muted small">
                · {enabled}/{sources.length} enabled · {totalEvents.toLocaleString()} events
                {enabled > 0 ? ` · ~${avgEvents} avg/source` : ""}
              </span>
              {lowYield > 0 && (
                <span
                  className="sources-region-badge sources-region-badge-warn"
                  title={`${zeroYield} returned 0; ${lowYield - zeroYield} returned 1-4. Threshold matches LOW_YIELD_THRESHOLD.`}
                >
                  {lowYield} low-yield
                </span>
              )}
              {probeLeads > 0 && (
                <span
                  className="sources-region-badge sources-region-badge-info"
                  title="Probe found candidate fixes but didn't auto-apply (low/medium confidence). Manual review recommended."
                >
                  {probeLeads} probe lead{probeLeads === 1 ? "" : "s"}
                </span>
              )}
              {autoFixed > 0 && (
                <span
                  className="sources-region-badge sources-region-badge-ok"
                  title="Sources where the probe auto-applied an adapter swap on the most recent ingest. Worth a glance to confirm the swap was correct."
                >
                  {autoFixed} auto-fixed
                </span>
              )}
            </summary>
            <SourcesEditor
              region={region}
              initialSources={sources}
              eventCounts={counts}
              health={Object.fromEntries(
                Object.entries(sourceHealth)
                  .filter(([k]) => k.startsWith(`${region}:`))
                  .map(([k, v]) => [k.slice(region.length + 1), v]),
              )}
              canEdit={canEdit}
            />
          </details>
        );
      })}
    </main>
  );
}
