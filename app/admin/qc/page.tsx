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
import type { SourceConfig } from "@/lib/types";

export const dynamic = "force-dynamic";

type SourceHealth = {
  count: number;
  warnings: string[];
  probe?: {
    candidates: Array<{
      confidence: "high" | "medium" | "low";
      verifiedCount: number;
      adapter: string;
      url: string;
      evidence: string;
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
  // intentionally-disabled ones).
  const zeroByRegion: Record<string, QcEntry[]> = {};
  const lowByRegion: Record<string, QcEntry[]> = {};

  for (const region of regions) {
    zeroByRegion[region] = [];
    lowByRegion[region] = [];
    const file = await readSources(region);
    for (const source of file.sources) {
      if (!source.enabled) continue;
      const count = await loadEventCount(region, source.id);
      const history = allHistory
        .filter((h) => h.regionId === region && h.sourceId === source.id)
        .slice(-20);
      const entry: QcEntry = {
        region,
        source,
        count,
        history,
        health: health[`${region}:${source.id}`],
      };
      if (count === 0) zeroByRegion[region].push(entry);
      else if (count >= 1 && count <= 5) lowByRegion[region].push(entry);
    }
  }

  const totalZero = Object.values(zeroByRegion).flat().length;
  const totalLow = Object.values(lowByRegion).flat().length;

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

      <section className="qc-section">
        <h2>
          🛑 0 events <span className="muted">· {totalZero}</span>
        </h2>
        {totalZero === 0 && (
          <p className="muted">No enabled sources are currently returning 0 events. 🎉</p>
        )}
        {regions.map((region) => {
          const list = zeroByRegion[region];
          if (list.length === 0) return null;
          return (
            <RegionGroup key={`zero-${region}`} region={region} entries={list} />
          );
        })}
      </section>

      <section className="qc-section">
        <h2>
          ⚠️ 1–5 events <span className="muted">· {totalLow}</span>
        </h2>
        {totalLow === 0 && (
          <p className="muted">Nothing in the low-yield bucket right now.</p>
        )}
        {regions.map((region) => {
          const list = lowByRegion[region];
          if (list.length === 0) return null;
          return <RegionGroup key={`low-${region}`} region={region} entries={list} />;
        })}
      </section>
    </main>
  );
}

function RegionGroup({ region, entries }: { region: string; entries: QcEntry[] }) {
  return (
    <details className="qc-region" open>
      <summary>
        <span className="qc-region-name">{region}</span>
        <span className="muted small">
          · {entries.length} source{entries.length === 1 ? "" : "s"}
        </span>
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
      </dl>
    </article>
  );
}
