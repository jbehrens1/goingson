// Quality-control dashboard for admins/owners. Surfaces sources that are
// returning suspiciously low event counts, grouped by region and broken into
// two buckets (0 events, 1-5 events). For each source shows:
//   - Current adapter + URL + town + notes
//   - Recent ingest history (adapter changes + count over time) — the "did
//     this break recently or was it never working" story
//   - Latest probe findings (what the auto-probe tried, if anything)
//   - Quick links to visit the venue and edit in /sources

import { readFile } from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import { redirect } from "next/navigation";
import { authIsConfigured, getCurrentRole } from "@/lib/auth";
import { listRegions, readSources } from "@/lib/sources-config";
import { readHistory, type HistoryRow } from "@/lib/source-history";
import {
  ALL_REGIONS_KEY,
  readIngestHistory,
  type IngestHistoryRow,
} from "@/lib/ingest-history";
import type { SourceConfig } from "@/lib/types";
import { ReprobeButton } from "./ReprobeButton";

export const dynamic = "force-dynamic";

type SourceHealth = {
  count: number;
  warnings: string[];
  probe?: {
    mode?: "light" | "deep";
    candidates: Array<{
      confidence: "high" | "medium" | "low";
      verifiedCount: number;
      adapter: string;
      url: string;
      evidence: string;
    }>;
    /** Every URL/adapter pair the probe actually attempted. */
    attempts?: Array<{
      url: string;
      adapter: string;
      count: number;
      note?: string;
    }>;
    autoApplied?: {
      from: { adapter: string; url: string };
      to: { adapter: string; url: string };
      reason: string;
      newCount: number;
    };
  };
};

type QcEntry = {
  region: string;
  source: SourceConfig;
  count: number;
  history: HistoryRow[];
  health?: SourceHealth;
};

// Per-region health snapshot computed across ALL enabled sources in the
// region — same numbers as the /sources accordion. Surfaced on the QC
// region summaries so an admin can see overall region health while the
// section is still collapsed, without bouncing between QC and /sources.
type RegionStats = {
  enabled: number;
  total: number;
  totalEvents: number;
  avgEvents: number;
  lowYield: number;
  zeroYield: number;
  autoFixed: number;
  probeLeads: number;
};

async function loadEventCount(region: string, sourceId: string): Promise<number> {
  try {
    const file = path.join(process.cwd(), "public", `events.${region}.json`);
    const raw = await readFile(file, "utf8");
    const data = JSON.parse(raw) as { events: Array<{ source: { id: string } }> };
    return data.events.filter((e) => e.source.id === sourceId).length;
  } catch {
    return 0;
  }
}

async function loadHealth(): Promise<Record<string, SourceHealth>> {
  try {
    const raw = await readFile(
      path.join(process.cwd(), "public", "source-health.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { sources: Record<string, SourceHealth> };
    return parsed.sources ?? {};
  } catch {
    return {};
  }
}

export default async function QcPage() {
  if (!authIsConfigured()) {
    return (
      <main className="sources-page">
        <h1>Quality Control</h1>
        <p className="hint hint-error">Auth is not configured.</p>
      </main>
    );
  }
  const role = await getCurrentRole();
  if (role !== "admin" && role !== "owner") redirect("/sources");

  const regions = await listRegions();
  const allHistory = await readHistory(process.cwd());
  const health = await loadHealth();

  // Build the bucketed entries — only ENABLED sources (no point flagging
  // intentionally-disabled ones). Same pass also computes per-region
  // health stats across ALL enabled sources, mirroring the badges shown
  // in /sources so the QC page tells the same story at a glance.
  const zeroByRegion: Record<string, QcEntry[]> = {};
  const lowByRegion: Record<string, QcEntry[]> = {};
  const statsByRegion: Record<string, RegionStats> = {};

  for (const region of regions) {
    zeroByRegion[region] = [];
    lowByRegion[region] = [];
    const file = await readSources(region);
    let enabled = 0;
    let totalEvents = 0;
    let lowYield = 0;
    let zeroYield = 0;
    let autoFixed = 0;
    let probeLeads = 0;
    for (const source of file.sources) {
      if (!source.enabled) continue;
      enabled++;
      const count = await loadEventCount(region, source.id);
      totalEvents += count;
      if (count === 0) zeroYield++;
      if (count < 5) lowYield++;
      const h = health[`${region}:${source.id}`];
      if (h?.probe?.autoApplied) autoFixed++;
      if (h?.probe?.candidates && h.probe.candidates.length > 0 && !h.probe.autoApplied) {
        probeLeads++;
      }
      const history = allHistory
        .filter((h) => h.regionId === region && h.sourceId === source.id)
        .slice(-20);
      const entry: QcEntry = {
        region,
        source,
        count,
        history,
        health: h,
      };
      if (count === 0) zeroByRegion[region].push(entry);
      else if (count >= 1 && count <= 5) lowByRegion[region].push(entry);
    }
    statsByRegion[region] = {
      enabled,
      total: file.sources.length,
      totalEvents,
      avgEvents: enabled > 0 ? Math.round(totalEvents / enabled) : 0,
      lowYield,
      zeroYield,
      autoFixed,
      probeLeads,
    };
  }

  const totalZero = Object.values(zeroByRegion).flat().length;
  const totalLow = Object.values(lowByRegion).flat().length;

  // Recent ingest timing for the "How long is the cron taking" panel.
  const ingestHistory = await readIngestHistory(process.cwd());
  // Show overall-sweep rows from most recent → oldest, capped at 15.
  const recentRuns = ingestHistory
    .filter((r) => r.regionId === ALL_REGIONS_KEY)
    .slice(-15)
    .reverse();
  const perRegionByTs = new Map<string, IngestHistoryRow[]>();
  for (const r of ingestHistory) {
    if (r.regionId === ALL_REGIONS_KEY) continue;
    const arr = perRegionByTs.get(r.ts) ?? [];
    arr.push(r);
    perRegionByTs.set(r.ts, arr);
  }

  return (
    <main className="sources-page qc-page">
      <header>
        <h1>Quality Control</h1>
        <p className="muted">
          Enabled sources sorted into review buckets by how many events they
          actually returned on the last ingest. Look for adapter mismatches,
          venues that changed platforms, or seasonal venues that just haven&rsquo;t
          published the next month yet.
        </p>
        <p className="muted small">
          {totalZero} returning 0 events · {totalLow} returning 1–5 events ·
          history goes back ~60 ingests (≈2 months at daily cadence)
        </p>
      </header>

      <details className="qc-section">
        <summary>
          <span className="qc-section-title">⏱ Recent ingest runs</span>{" "}
          <span className="muted">· {recentRuns.length}</span>
        </summary>
        {recentRuns.length === 0 ? (
          <p className="muted">
            No ingest runs tracked yet. The next time the daily cron runs (or you
            edit a source and trigger a re-scan) this table will populate.
          </p>
        ) : (
          <table className="sources-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Duration</th>
                <th>Events</th>
                <th>Sources</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {recentRuns.map((run) => {
                const perRegion = perRegionByTs.get(run.ts) ?? [];
                const notes: string[] = [];
                if (run.autoFixes) notes.push(`${run.autoFixes} auto-fix${run.autoFixes === 1 ? "" : "es"}`);
                if (run.dropped?.closure) notes.push(`${run.dropped.closure} closures dropped`);
                if (run.dropped?.past) notes.push(`${run.dropped.past.toLocaleString()} past events dropped`);
                if (run.dropped?.outOfRegion) notes.push(`${run.dropped.outOfRegion} out-of-region`);
                return (
                  <tr key={run.ts}>
                    <td className="muted small">
                      <time dateTime={run.ts}>{formatRelativeTime(run.ts)}</time>
                      <br />
                      <span style={{ opacity: 0.55 }}>{run.ts.slice(0, 16).replace("T", " ")}</span>
                    </td>
                    <td className="sources-count-cell">
                      <strong>{formatDuration(run.durationMs)}</strong>
                      {perRegion.length > 0 && (
                        <details className="qc-history" style={{ marginTop: "0.25rem" }}>
                          <summary>per-region</summary>
                          <ul style={{ margin: "0.3rem 0", padding: 0, listStyle: "none", fontSize: "0.78rem" }}>
                            {perRegion.map((r) => (
                              <li key={r.regionId}>
                                {r.regionId}: <strong>{formatDuration(r.durationMs)}</strong>
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </td>
                    <td className="sources-count-cell">{run.eventCount.toLocaleString()}</td>
                    <td className="sources-count-cell">{run.sourceCount}</td>
                    <td className="muted small">{notes.join(" · ")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </details>

      <details className="qc-section">
        <summary>
          <span className="qc-section-title">🛑 0 events</span>{" "}
          <span className="muted">· {totalZero}</span>
        </summary>
        {totalZero === 0 && (
          <p className="muted">No enabled sources are currently returning 0 events. 🎉</p>
        )}
        {regions.map((region) => {
          const list = zeroByRegion[region];
          if (list.length === 0) return null;
          return (
            <RegionGroup
              key={`zero-${region}`}
              region={region}
              entries={list}
              stats={statsByRegion[region]}
            />
          );
        })}
      </details>

      <details className="qc-section">
        <summary>
          <span className="qc-section-title">⚠️ 1–5 events</span>{" "}
          <span className="muted">· {totalLow}</span>
        </summary>
        {totalLow === 0 && (
          <p className="muted">Nothing in the low-yield bucket right now.</p>
        )}
        {regions.map((region) => {
          const list = lowByRegion[region];
          if (list.length === 0) return null;
          return (
            <RegionGroup
              key={`low-${region}`}
              region={region}
              entries={list}
              stats={statsByRegion[region]}
            />
          );
        })}
      </details>
    </main>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 90) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 60_000) return "just now";
  const min = Math.round(diffMs / 60_000);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 36) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  return `${day} day${day === 1 ? "" : "s"} ago`;
}

function RegionGroup({
  region,
  entries,
  stats,
}: {
  region: string;
  entries: QcEntry[];
  stats?: RegionStats;
}) {
  // Same conditional badges as /sources — only render when non-zero
  // so healthy regions stay clean. Numbers are computed across ALL
  // enabled sources in the region (not just this bucket's entries),
  // so the badges read consistently between /sources and /admin/qc.
  return (
    <details className="qc-region">
      <summary>
        <span className="qc-region-name">{region}</span>
        <span className="muted small">
          · {entries.length} source{entries.length === 1 ? "" : "s"} in this bucket
          {stats && stats.enabled > 0 && (
            <>
              {" · "}
              {stats.enabled} enabled · {stats.totalEvents.toLocaleString()} events ·
              ~{stats.avgEvents} avg/source
            </>
          )}
        </span>
        {stats && stats.lowYield > 0 && (
          <span
            className="sources-region-badge sources-region-badge-warn"
            title={`${stats.zeroYield} returned 0; ${stats.lowYield - stats.zeroYield} returned 1-4. Threshold matches LOW_YIELD_THRESHOLD.`}
          >
            {stats.lowYield} low-yield
          </span>
        )}
        {stats && stats.probeLeads > 0 && (
          <span
            className="sources-region-badge sources-region-badge-info"
            title="Probe found candidate fixes but didn't auto-apply (low/medium confidence). Manual review recommended."
          >
            {stats.probeLeads} probe lead{stats.probeLeads === 1 ? "" : "s"}
          </span>
        )}
        {stats && stats.autoFixed > 0 && (
          <span
            className="sources-region-badge sources-region-badge-ok"
            title="Sources where the probe auto-applied an adapter swap on the most recent ingest. Worth a glance to confirm the swap was correct."
          >
            {stats.autoFixed} auto-fixed
          </span>
        )}
      </summary>
      <div className="qc-entries">
        {entries.map((e) => (
          <QcCard key={`${e.region}-${e.source.id}`} entry={e} />
        ))}
      </div>
    </details>
  );
}

function QcCard({ entry }: { entry: QcEntry }) {
  const region = entry.region;
  const { source, count, history, health } = entry;

  // History trend: distinct (adapter, count) transitions for spotting
  // "this used to work" moments.
  const lastNonZero = [...history].reverse().find((h) => h.count > 0);
  const adapterChanges: HistoryRow[] = [];
  let prevAdapter: string | undefined;
  for (const h of history) {
    if (h.adapter !== prevAdapter) {
      adapterChanges.push(h);
      prevAdapter = h.adapter;
    }
  }

  return (
    <article className="qc-card">
      <header className="qc-card-head">
        <div>
          <h3>
            {source.name}{" "}
            <span className="muted small">· {source.id}</span>
          </h3>
          <p className="muted small">
            <code>{source.adapter}</code>
            {source.town ? ` · ${source.town}` : ""}
            {source.category ? ` · ${source.category}` : ""}
          </p>
        </div>
        <div className="qc-card-actions">
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="ghost-btn"
          >
            Visit venue ↗
          </a>
          <Link href="/sources" className="ghost-btn">
            Edit in /sources
          </Link>
          <ReprobeButton regionId={region} sourceId={source.id} />
        </div>
      </header>

      <dl className="qc-grid">
        <dt>URL</dt>
        <dd>
          <a href={source.url} target="_blank" rel="noopener noreferrer">
            {source.url}
          </a>
        </dd>

        <dt>Current count</dt>
        <dd>
          <strong>{count}</strong> events on last ingest
          {lastNonZero && lastNonZero.count > count && (
            <span className="muted small">
              {" "}
              · last had {lastNonZero.count} on {lastNonZero.ts.slice(0, 10)}
            </span>
          )}
        </dd>

        {source.notes && (
          <>
            <dt>Notes</dt>
            <dd className="qc-notes">{source.notes}</dd>
          </>
        )}

        {history.length > 0 && (
          <>
            <dt>History</dt>
            <dd>
              <details className="qc-history">
                <summary>
                  {history.length} ingest{history.length === 1 ? "" : "s"} tracked
                  {adapterChanges.length > 1 && (
                    <span className="muted small">
                      {" "}
                      · {adapterChanges.length} adapter change
                      {adapterChanges.length === 2 ? "" : "s"}
                    </span>
                  )}
                </summary>
                <table className="qc-history-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Adapter</th>
                      <th>Count</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...history].reverse().map((h, i) => {
                      const adapterChanged =
                        i < history.length - 1 &&
                        history[history.length - 2 - i]?.adapter !== h.adapter;
                      return (
                        <tr key={h.ts} className={h.count === 0 ? "row-disabled" : ""}>
                          <td className="muted small">{h.ts.slice(0, 10)}</td>
                          <td>
                            <code>{h.adapter}</code>
                            {adapterChanged && (
                              <span className="qc-changed-badge" title="Adapter changed from previous run">
                                changed
                              </span>
                            )}
                          </td>
                          <td className="sources-count-cell">{h.count}</td>
                          <td className="muted small">
                            {h.error && <span className="hint-error">{h.error}</span>}
                            {h.warnings?.[0] && <span>{h.warnings[0]}</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </details>
            </dd>
          </>
        )}

        {health?.probe?.candidates && health.probe.candidates.length > 0 && (
          <>
            <dt>Probe findings</dt>
            <dd>
              <ul className="qc-probe-list">
                {health.probe.candidates.slice(0, 5).map((c, i) => (
                  <li key={i}>
                    <strong>
                      {c.adapter} · {c.verifiedCount} events
                    </strong>{" "}
                    <span
                      className={`health-badge health-${c.confidence === "high" ? "fixed" : "low"}`}
                    >
                      {c.confidence}
                    </span>
                    <br />
                    <span className="muted small">{c.evidence}</span>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}

        {health?.probe?.autoApplied && (
          <>
            <dt>Auto-fixed</dt>
            <dd>
              <span className="health-badge health-fixed">auto-fixed</span>{" "}
              <span className="muted small">{health.probe.autoApplied.reason}</span>
            </dd>
          </>
        )}

        {/* Tried paths: full audit of what the probe touched. Useful for
         *  proving effort on a source that still yielded zero ("we tried
         *  20 paths and got 0 from each") and for spotting one path that
         *  almost worked. Collapsed by default to avoid drowning the page. */}
        {health?.probe?.attempts && health.probe.attempts.length > 0 && (
          <>
            <dt>Tried paths</dt>
            <dd>
              <details className="qc-attempts">
                <summary>
                  {health.probe.attempts.length} attempt
                  {health.probe.attempts.length === 1 ? "" : "s"}
                  {health.probe.mode ? ` (${health.probe.mode} mode)` : ""}
                  {" — "}
                  {health.probe.attempts.filter((a) => a.count > 0).length} produced events
                </summary>
                <table className="qc-attempts-table">
                  <thead>
                    <tr>
                      <th>Count</th>
                      <th>Adapter</th>
                      <th>URL</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {health.probe.attempts
                      .slice()
                      .sort((a, b) => b.count - a.count)
                      .map((a, i) => (
                        <tr key={i} className={a.count === 0 ? "muted-row" : ""}>
                          <td className="sources-count-cell">{a.count}</td>
                          <td><code className="small">{a.adapter}</code></td>
                          <td className="qc-attempt-url">
                            <a href={a.url} target="_blank" rel="noopener noreferrer">
                              {a.url}
                            </a>
                          </td>
                          <td className="muted small">{a.note ?? ""}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </details>
            </dd>
          </>
        )}
      </dl>
    </article>
  );
}
