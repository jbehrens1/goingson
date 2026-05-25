import nodeIcal from "node-ical";
import type { Adapter, AdapterResult } from "../types";
import { buildEvent, politeFetch, toIsoOrUndefined } from "../util";

type IcalConfig = {
  /** Fallback venue name when an event has no LOCATION field — covers cases
   *  like Tockify-hosted iCals where ~15% of events ship with no location. */
  defaultVenue?: string;
  /** Regex patterns matched (case-insensitive) against trimmed SUMMARY. Any
   *  event whose title matches is dropped. Useful for venues whose Google
   *  Calendar mixes operating-hours entries ("Bistro Open") with real events. */
  excludeTitlePatterns?: string[];
};

export const icalAdapter: Adapter = async ({ source }): Promise<AdapterResult> => {
  const warnings: string[] = [];
  const cfg = (source.config ?? {}) as IcalConfig;
  const excludeRegexes = (cfg.excludeTitlePatterns ?? []).map((p) => {
    try {
      return new RegExp(p, "i");
    } catch {
      warnings.push(`ical: invalid excludeTitlePatterns regex "${p}" — skipping`);
      return null;
    }
  });
  const res = await politeFetch(source.url);
  if (!res.ok) {
    return { events: [], warnings: [`HTTP ${res.status} fetching ${source.url}`] };
  }
  const text = await res.text();

  let parsed: Record<string, nodeIcal.CalendarComponent>;
  try {
    parsed = nodeIcal.sync.parseICS(text);
  } catch (err) {
    return { events: [], warnings: [`iCal parse failed: ${(err as Error).message}`] };
  }

  let droppedByFilter = 0;
  const events = Object.values(parsed)
    .filter((c): c is nodeIcal.VEvent => c.type === "VEVENT")
    .map((vev) => {
      const summary = String(vev.summary ?? "Untitled event").trim();
      if (excludeRegexes.some((r) => r && r.test(summary))) {
        droppedByFilter++;
        return null;
      }
      const start = toIsoOrUndefined(vev.start);
      if (!start) {
        warnings.push(`Skipping event without start: ${vev.summary ?? vev.uid}`);
        return null;
      }
      const url = (typeof vev.url === "string" ? vev.url : undefined) ?? source.url;
      const naturalKey = vev.uid ?? `${vev.summary}::${start}`;
      const venue =
        (vev.location && String(vev.location).trim()) || cfg.defaultVenue || undefined;
      // node-ical parses CATEGORIES into a string[] (or sometimes a single
      // string for one-value entries). Normalize to string[] so categorize
      // can use them as platform tags (e.g. iCal "Concert" → live-music).
      const rawCats = (vev as unknown as { categories?: unknown }).categories;
      const categories = Array.isArray(rawCats)
        ? rawCats.filter((c): c is string => typeof c === "string")
        : typeof rawCats === "string"
          ? [rawCats]
          : undefined;
      return buildEvent(source, {
        naturalKey,
        title: summary,
        description: typeof vev.description === "string" ? vev.description : undefined,
        url,
        start,
        end: toIsoOrUndefined(vev.end),
        allDay: vev.datetype === "date",
        location: venue
          ? { venue, town: source.town }
          : source.town
            ? { town: source.town }
            : undefined,
        categories,
      });
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  if (droppedByFilter > 0) {
    warnings.push(
      `ical: dropped ${droppedByFilter} events matching excludeTitlePatterns`,
    );
  }
  return { events, warnings };
};
