import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Adapter, AdapterResult, EventLocation, EventRecord } from "../types";
import { buildEvent, naiveToUtcIso } from "../util";
import { loadRegion } from "../region";

// "Manual one-off events" — for specific dated events that can't be reliably
// auto-scraped from their host (Cloudflare-blocked sites, class series with no
// public feed, anything you spot manually and want surfaced). Edit the JSON
// file, re-run `npm run ingest`, done.
//
// Config file: `config/regions/<region>/one-off.json` (path configurable via
// `config.file` on the source). Schema:
//
// {
//   "events": [
//     {
//       "title": "Mahjong Mondays! Class 1",
//       "description": "...",
//       "url": "https://...",
//       "venue": "Ten Trees Books",
//       "town": "Natick",
//       "address": "...",        // optional
//       "start": "2026-05-11T13:00:00",   // wall-clock time in region's tz
//       "end":   "2026-05-11T15:00:00",   // optional
//       "allDay": false,                  // optional
//       "category": "mahjong"             // optional EventType override
//     }
//   ]
// }

type OneOffEntry = {
  title: string;
  description?: string;
  url?: string;
  venue?: string;
  town?: string;
  address?: string;
  start: string;
  end?: string;
  allDay?: boolean;
  category?: EventRecord["type"];
};

type OneOffFile = {
  $comment?: string;
  events: OneOffEntry[];
};

type ManualOneoffConfig = {
  file?: string;
  keepPast?: boolean;
};

export const manualOneoffAdapter: Adapter = async ({
  source,
  regionId,
}): Promise<AdapterResult> => {
  const warnings: string[] = [];
  // Honor the active region passed via ctx, NOT the REGION env var — when the
  // all-regions sweep runs, env REGION is unset and loadRegion() falls back
  // to the default, breaking manual-oneoff files in non-default regions.
  const region = (() => {
    try {
      return loadRegion(process.cwd(), regionId);
    } catch {
      return null;
    }
  })();
  const tz = region?.config.timeZone ?? "America/New_York";

  const cfg = (source.config ?? {}) as ManualOneoffConfig;
  const filePath = path.isAbsolute(cfg.file ?? "")
    ? (cfg.file as string)
    : path.join(region?.regionDir ?? process.cwd(), cfg.file ?? "one-off.json");

  let parsed: OneOffFile;
  try {
    const raw = await readFile(filePath, "utf8");
    parsed = JSON.parse(raw) as OneOffFile;
  } catch (err) {
    return {
      events: [],
      warnings: [`Failed to read ${filePath}: ${(err as Error).message}`],
    };
  }

  const now = Date.now();
  const cutoff = now - 12 * 3600_000; // keep events that ended within last 12h
  const keepPast = cfg.keepPast === true;

  const events: EventRecord[] = [];
  for (const entry of parsed.events ?? []) {
    if (!entry.title || !entry.start) {
      warnings.push(`Skipped entry missing title or start: ${JSON.stringify(entry).slice(0, 80)}`);
      continue;
    }
    const startIso = naiveToUtcIso(entry.start, tz);
    const endIso = entry.end ? naiveToUtcIso(entry.end, tz) : undefined;

    if (!keepPast) {
      const effectiveEnd = new Date(endIso ?? startIso).getTime();
      if (effectiveEnd < cutoff) continue;
    }

    const loc: EventLocation = {};
    if (entry.venue) loc.venue = entry.venue;
    if (entry.town) loc.town = entry.town;
    if (entry.address) loc.address = entry.address;

    events.push(
      buildEvent(source, {
        naturalKey: `${entry.title}::${entry.start}`,
        title: entry.title,
        description: entry.description,
        url: entry.url ?? source.url,
        start: startIso,
        end: endIso,
        allDay: entry.allDay,
        location: Object.keys(loc).length ? loc : undefined,
        type: entry.category,
      }),
    );
  }

  return { events, warnings };
};
