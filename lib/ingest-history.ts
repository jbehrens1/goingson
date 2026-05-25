// Per-run ingest history. One row per region per ingest, plus a summary
// row tagged with regionId="__all__" for the full sweep. Used by the
// /admin/qc dashboard to surface "how long is the cron taking" + spot
// regressions over time.
//
// File: public/ingest-history.jsonl (gets committed by the daily cron).

import { promises as fs } from "node:fs";
import path from "node:path";

const HISTORY_FILE = "public/ingest-history.jsonl";
const MAX_RUNS = 60; // ~2 months at daily cadence

export type IngestHistoryRow = {
  /** ISO timestamp at the START of this region's ingest (or the start of
   *  the full sweep for the "__all__" summary row). */
  ts: string;
  /** Region id, or "__all__" for the multi-region summary row. */
  regionId: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Total events kept after closure + region filters. */
  eventCount: number;
  /** Number of enabled sources processed. */
  sourceCount: number;
  /** Per-filter drop counts. */
  dropped?: {
    closure?: number;
    outOfRegion?: number;
    past?: number;
  };
  /** Probe auto-fix count (sources whose adapter+url got rewritten this run). */
  autoFixes?: number;
};

export async function readIngestHistory(rootDir: string): Promise<IngestHistoryRow[]> {
  const file = path.join(rootDir, HISTORY_FILE);
  try {
    const raw = await fs.readFile(file, "utf8");
    const out: IngestHistoryRow[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as IngestHistoryRow);
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Append new rows and cap the file at MAX_RUNS *runs* (counted by unique
 * ts at the "__all__" summary row).
 */
export async function appendIngestHistory(
  rootDir: string,
  rows: IngestHistoryRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const existing = await readIngestHistory(rootDir);
  const all = [...existing, ...rows];

  // Cap by run count. Group by run ts (assumes same startedAt for all rows
  // of a single run — true because runAllRegions assigns one timestamp).
  const runTs = [...new Set(all.map((r) => r.ts))].sort();
  const keepTs = new Set(runTs.slice(-MAX_RUNS));
  const kept = all.filter((r) => keepTs.has(r.ts));
  kept.sort((a, b) => a.ts.localeCompare(b.ts));

  const file = path.join(rootDir, HISTORY_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, kept.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

export const ALL_REGIONS_KEY = "__all__";
