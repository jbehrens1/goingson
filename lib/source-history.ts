// Per-source ingest history. One JSONL row per source per ingest run,
// appended at the end of every region's ingest. Capped to the most recent
// HISTORY_PER_SOURCE entries per source so the file doesn't grow unbounded.
//
// File: public/source-history.jsonl (gets committed by the daily cron)
//
// Use cases:
//   - QC dashboard: "show me how this source has trended over the last month"
//   - Spot the day a venue's count crashed (= the day their platform changed)
//   - Audit auto-probe auto-fixes (the adapter column tells the story)
//
// Schema:
//   ts          ISO timestamp of the ingest run
//   regionId    e.g. "lbi"
//   sourceId    e.g. "blackeyed-susans"
//   adapter     adapter the source was using at this ingest
//   url         URL the source was pointing at
//   count       number of events returned
//   warnings    warnings emitted (truncated to first 200 chars per warning)
//   error       error string if the adapter threw

import { promises as fs } from "node:fs";
import path from "node:path";

const HISTORY_FILE = "public/source-history.jsonl";
const HISTORY_PER_SOURCE = 60; // ~2 months at daily cron

export type HistoryRow = {
  ts: string;
  regionId: string;
  sourceId: string;
  adapter: string;
  url: string;
  count: number;
  warnings?: string[];
  error?: string;
};

export async function readHistory(rootDir: string): Promise<HistoryRow[]> {
  const file = path.join(rootDir, HISTORY_FILE);
  try {
    const raw = await fs.readFile(file, "utf8");
    const out: HistoryRow[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as HistoryRow);
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
 * Append new rows, then trim to keep at most HISTORY_PER_SOURCE entries per
 * (regionId, sourceId) pair. Writes the file back rewritten — small enough
 * (~75 sources × 60 rows ≈ 4500 lines ≈ 1MB) that a full rewrite per ingest
 * is fine.
 */
export async function appendHistory(
  rootDir: string,
  rows: HistoryRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const existing = await readHistory(rootDir);
  const all = existing.concat(rows);

  // Bucket by source key, keep newest HISTORY_PER_SOURCE per bucket.
  const byKey = new Map<string, HistoryRow[]>();
  for (const row of all) {
    const k = `${row.regionId}:${row.sourceId}`;
    const arr = byKey.get(k) ?? [];
    arr.push(row);
    byKey.set(k, arr);
  }
  const kept: HistoryRow[] = [];
  for (const arr of byKey.values()) {
    arr.sort((a, b) => a.ts.localeCompare(b.ts));
    kept.push(...arr.slice(-HISTORY_PER_SOURCE));
  }
  kept.sort((a, b) => a.ts.localeCompare(b.ts));

  const file = path.join(rootDir, HISTORY_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, kept.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

export function historyFilePath(): string {
  return HISTORY_FILE;
}
