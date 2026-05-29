// Server-side loaders for region-scoped option lists used by the newsletter
// subscription editors (both user-facing /account and admin /admin). Reads
// from the deployed events files + curated config — same approach as
// app/account/page.tsx originally did inline; lifted here so /admin can
// reuse without duplicating the JSON parsing.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { EventRecord } from "./types";

/** Distinct venue names that appear in each region's ingested events. */
export async function loadVenuesByRegion(
  rootDir: string,
  regions: string[],
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const r of regions) {
    try {
      const file = path.join(rootDir, "public", `events.${r}.json`);
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as { events: EventRecord[] };
      const venues = new Set<string>();
      for (const e of parsed.events) {
        const v = e.location?.venue?.trim();
        if (v) venues.add(v);
      }
      out[r] = [...venues].sort();
    } catch {
      out[r] = [];
    }
  }
  return out;
}

/** Distinct town names: union of (a) curated config/regions/<id>/towns.json
 *  and (b) town strings on actual ingested events. Sorted alphabetically. */
export async function loadTownsByRegion(
  rootDir: string,
  regions: string[],
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const r of regions) {
    const towns = new Set<string>();
    // Curated town list (towns.json)
    try {
      const tFile = path.join(rootDir, "config/regions", r, "towns.json");
      const tRaw = await readFile(tFile, "utf8");
      const tParsed = JSON.parse(tRaw) as { towns?: Array<{ name?: string }> };
      for (const t of tParsed.towns ?? []) {
        if (t.name) towns.add(t.name.trim());
      }
    } catch {
      /* no towns.json — fall back to ingested-events scan only */
    }
    // Ingested-events scan
    try {
      const eFile = path.join(rootDir, "public", `events.${r}.json`);
      const eRaw = await readFile(eFile, "utf8");
      const eParsed = JSON.parse(eRaw) as { events: EventRecord[] };
      for (const e of eParsed.events) {
        const t = e.location?.town?.trim();
        if (t) towns.add(t);
      }
    } catch {
      /* no events file yet */
    }
    out[r] = [...towns].sort();
  }
  return out;
}
