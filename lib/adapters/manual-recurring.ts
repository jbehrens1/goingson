import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Adapter, AdapterResult, EventLocation, EventRecord } from "../types";
import { buildEvent, naiveToUtcIso } from "../util";
import { loadRegion } from "../region";

// "Manual recurring events" — for things that exist in the real world but
// aren't on a scrapeable web calendar (drop-in clubs, weekly classes, etc.).
// You list each weekly occurrence once with a weekday + time + venue + a few
// optional knobs; the adapter materializes the next N occurrences as events.
//
// Config file: `config/regions/<region>/recurring.json` (path configurable
// via the source's `config.file`). Schema:
//
// {
//   "events": [
//     {
//       "title": "...",
//       "description": "...",
//       "url": "...",
//       "venue": "...",
//       "town": "...",
//       "address": "...",
//       "weekday": "Mon" | "Tue" | ... | "Sun",
//       "startTime": "12:00",
//       "endTime": "15:00",            // optional
//       "category": "community",       // optional EventType override
//       "occurrences": 8,              // optional, defaults to source-wide
//       "startDate": "2026-05-01",     // optional season start (YYYY-MM-DD)
//       "endDate":   "2026-10-31",     // optional season end
//       "skipDates": ["2026-07-04"]    // optional
//     }
//   ]
// }

type RecurringEntry = {
  title: string;
  description?: string;
  url?: string;
  venue?: string;
  town?: string;
  address?: string;
  weekday: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
  startTime: string; // "HH:MM" 24-hour local time
  endTime?: string;
  category?: EventRecord["type"];
  occurrences?: number;
  startDate?: string; // YYYY-MM-DD
  endDate?: string;
  skipDates?: string[];
};

type RecurringFile = {
  $comment?: string;
  defaultOccurrences?: number;
  events: RecurringEntry[];
};

type ManualRecurringConfig = {
  file?: string;
  defaultOccurrences?: number;
};

const WEEKDAY_INDEX: Record<RecurringEntry["weekday"], number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function nextOccurrence(after: Date, weekday: number): Date {
  const d = new Date(after);
  d.setHours(0, 0, 0, 0);
  const offset = (weekday - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + offset);
  return d;
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export const manualRecurringAdapter: Adapter = async ({ source }): Promise<AdapterResult> => {
  const warnings: string[] = [];
  const region = (() => {
    try {
      return loadRegion();
    } catch {
      return null;
    }
  })();
  const tz = region?.config.timeZone ?? "America/New_York";

  const cfg = (source.config ?? {}) as ManualRecurringConfig;
  const filePath = path.isAbsolute(cfg.file ?? "")
    ? (cfg.file as string)
    : path.join(region?.regionDir ?? process.cwd(), cfg.file ?? "recurring.json");

  let parsed: RecurringFile;
  try {
    const raw = await readFile(filePath, "utf8");
    parsed = JSON.parse(raw) as RecurringFile;
  } catch (err) {
    return {
      events: [],
      warnings: [`Failed to read ${filePath}: ${(err as Error).message}`],
    };
  }

  const defaultN = cfg.defaultOccurrences ?? parsed.defaultOccurrences ?? 8;
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const events: EventRecord[] = [];
  for (const entry of parsed.events ?? []) {
    const weekdayIdx = WEEKDAY_INDEX[entry.weekday];
    if (weekdayIdx === undefined) {
      warnings.push(`Skipped "${entry.title}" — unknown weekday "${entry.weekday}"`);
      continue;
    }
    const [h, m] = entry.startTime.split(":").map((n) => parseInt(n, 10));
    if (Number.isNaN(h) || Number.isNaN(m)) {
      warnings.push(`Skipped "${entry.title}" — bad startTime "${entry.startTime}"`);
      continue;
    }

    const seasonStart = entry.startDate ? new Date(entry.startDate + "T00:00:00") : null;
    const seasonEnd = entry.endDate ? new Date(entry.endDate + "T23:59:59") : null;
    const skip = new Set(entry.skipDates ?? []);
    const target = entry.occurrences ?? defaultN;

    // Start from the later of today or the season start.
    let cursor = nextOccurrence(
      seasonStart && seasonStart > todayStart ? seasonStart : todayStart,
      weekdayIdx,
    );

    let made = 0;
    let attempts = 0;
    while (made < target && attempts < target * 4) {
      attempts++;
      if (seasonEnd && cursor > seasonEnd) break;
      const dateKey = ymd(cursor);
      if (!skip.has(dateKey)) {
        const naive = `${dateKey}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
        const startIso = naiveToUtcIso(naive, tz);
        let endIso: string | undefined;
        if (entry.endTime) {
          const [eh, em] = entry.endTime.split(":").map((n) => parseInt(n, 10));
          if (!Number.isNaN(eh) && !Number.isNaN(em)) {
            endIso = naiveToUtcIso(
              `${dateKey}T${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}:00`,
              tz,
            );
          }
        }

        const loc: EventLocation = {};
        if (entry.venue) loc.venue = entry.venue;
        if (entry.town) loc.town = entry.town;
        if (entry.address) loc.address = entry.address;

        events.push(
          buildEvent(source, {
            naturalKey: `${entry.title}::${dateKey}`,
            title: entry.title,
            description: entry.description,
            url: entry.url ?? source.url,
            start: startIso,
            end: endIso,
            location: Object.keys(loc).length ? loc : undefined,
            type: entry.category,
          }),
        );
        made++;
      }
      cursor.setDate(cursor.getDate() + 7);
    }
  }

  return { events, warnings };
};
