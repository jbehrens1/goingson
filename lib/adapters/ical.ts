import nodeIcal from "node-ical";
import type { Adapter, AdapterResult, EventRecord } from "../types";
import { buildEvent, naiveToUtcIso, politeFetch, toIsoOrUndefined } from "../util";

type IcalConfig = {
  /** Fallback venue name when an event has no LOCATION field — covers cases
   *  like Tockify-hosted iCals where ~15% of events ship with no location. */
  defaultVenue?: string;
  /** Regex patterns matched (case-insensitive) against trimmed SUMMARY. Any
   *  event whose title matches is dropped. Useful for venues whose Google
   *  Calendar mixes operating-hours entries ("Bistro Open") with real events. */
  excludeTitlePatterns?: string[];
};

// RRULE expansion horizon. node-ical's `rrule.between()` needs an explicit
// upper bound — without one a weekly-forever rule would generate thousands
// of occurrences. Two years forward matches what the calendar widgets show
// and keeps the events file at a sane size. Lower bound goes 60 days back so
// we don't lose "this week" recurring events when ingest starts mid-week.
const RRULE_HORIZON_DAYS_BACK = 60;
const RRULE_HORIZON_DAYS_FORWARD = 730;

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
  let expandedRrule = 0;
  const horizonStart = new Date(Date.now() - RRULE_HORIZON_DAYS_BACK * 86_400_000);
  const horizonEnd = new Date(Date.now() + RRULE_HORIZON_DAYS_FORWARD * 86_400_000);
  const events: EventRecord[] = [];

  for (const c of Object.values(parsed)) {
    if (c.type !== "VEVENT") continue;
    const vev = c as nodeIcal.VEvent;

    const summary = String(vev.summary ?? "Untitled event").trim();
    if (excludeRegexes.some((r) => r && r.test(summary))) {
      droppedByFilter++;
      continue;
    }

    // Build a list of (start, end) tuples to emit. For one-off events that's
    // a single tuple. For RRULE-bearing events we expand via rrule.between
    // and apply EXDATE/recurrences overrides.
    const occurrences = collectOccurrences(vev, horizonStart, horizonEnd, warnings);
    if (occurrences.length === 0) continue;
    if (occurrences.length > 1) expandedRrule += occurrences.length - 1;

    const url = (typeof vev.url === "string" ? vev.url : undefined) ?? source.url;
    const venue =
      (vev.location && String(vev.location).trim()) || cfg.defaultVenue || undefined;
    const rawCats = (vev as unknown as { categories?: unknown }).categories;
    const categories = Array.isArray(rawCats)
      ? rawCats.filter((c): c is string => typeof c === "string")
      : typeof rawCats === "string"
        ? [rawCats]
        : undefined;
    const description =
      typeof vev.description === "string" ? vev.description : undefined;

    for (const occ of occurrences) {
      // Natural key combines UID + the occurrence's start so each instance of
      // a recurring event gets a distinct deduplication key. Without this,
      // every Tuesday Shorty Long show would collide on the same UID and only
      // one would survive `makeEventId()`'s sha1 hash.
      const naturalKey = vev.uid
        ? `${vev.uid}::${occ.start.toISOString()}`
        : `${summary}::${occ.start.toISOString()}`;

      events.push(
        buildEvent(source, {
          naturalKey,
          title: occ.title ?? summary,
          description: occ.description ?? description,
          url,
          start: occ.start.toISOString(),
          end: occ.end ? occ.end.toISOString() : undefined,
          allDay: vev.datetype === "date",
          location: venue
            ? { venue, town: source.town }
            : source.town
              ? { town: source.town }
              : undefined,
          categories,
        }),
      );
    }
  }

  if (droppedByFilter > 0) {
    warnings.push(
      `ical: dropped ${droppedByFilter} events matching excludeTitlePatterns`,
    );
  }
  if (expandedRrule > 0) {
    warnings.push(`ical: expanded ${expandedRrule} extra occurrences from RRULE`);
  }
  return { events, warnings };
};

type Occurrence = {
  start: Date;
  end?: Date;
  /** Per-instance override (RECURRENCE-ID) title — falls back to master. */
  title?: string;
  description?: string;
};

/** Compute every occurrence of a VEVENT within [from, to]. For one-off
 *  events the result is a single-element array. For RRULE-bearing events
 *  we call rrule.between and apply EXDATE (skipped dates) + recurrences
 *  (per-instance overrides published as their own VEVENTs with the same
 *  UID and a RECURRENCE-ID matching one of the rrule's occurrences). */
function collectOccurrences(
  vev: nodeIcal.VEvent,
  from: Date,
  to: Date,
  warnings: string[],
): Occurrence[] {
  const masterStart = toDate(vev.start);
  if (!masterStart) {
    warnings.push(`Skipping event without start: ${vev.summary ?? vev.uid}`);
    return [];
  }
  const masterEnd = toDate(vev.end);
  const duration =
    masterEnd && masterStart ? masterEnd.getTime() - masterStart.getTime() : 0;

  // No rrule: one-off event, emit as-is.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rrule = (vev as any).rrule;
  if (!rrule || typeof rrule.between !== "function") {
    return [{ start: masterStart, end: masterEnd }];
  }

  // EXDATE entries (dates the recurrence skips, e.g. holiday week off)
  // come keyed by ISO-y-m-d string in node-ical's parse output.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exdateMap = (vev as any).exdate as Record<string, unknown> | undefined;
  // RECURRENCE-ID overrides: separate VEVENTs republished with the same UID
  // and a recurrenceid referencing the date being overridden.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recurrences = (vev as any).recurrences as
    | Record<string, nodeIcal.VEvent>
    | undefined;

  // When DTSTART has a TZID (e.g. "America/New_York"), node-ical's rrule
  // returns each occurrence as a Date whose UTC components are the wall-clock
  // time in that TZ — NOT the absolute moment. That makes "Tue 9 PM ET" come
  // back as the JS Date for "2026-07-08T01:00:00Z" expressed wrong: the
  // returned Date.toISOString() reads "2026-07-08T01:00:00.000Z" which is
  // really 5 PM ET, not 9 PM. We have to reinterpret each occurrence as a
  // wall-clock-in-tzid string and convert to a true UTC instant.
  // (One-off events stored as TZID-anchored DTSTART are handled correctly
  // by node-ical's parser; this fix is specific to rrule expansion.)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tzid = (vev.start as any)?.tz ?? (vev.start as any)?.tzid;

  const dates: Date[] = rrule.between(from, to, true);
  const out: Occurrence[] = [];
  for (const raw of dates) {
    const occStart = tzid ? reinterpretWallClock(raw, tzid) : raw;
    // Check EXDATE — keys are like "2026-07-21" or sometimes the full ISO.
    if (exdateMap) {
      const ymd = occStart.toISOString().slice(0, 10);
      if (
        Object.keys(exdateMap).some(
          (k) => k.startsWith(ymd) || ymd === k.slice(0, 10),
        )
      ) {
        continue;
      }
    }
    // Check recurrence override — keys match against the date string of the
    // RECURRENCE-ID. node-ical normalizes to YYYY-MM-DD prefix.
    const override = recurrences
      ? findRecurrenceOverride(recurrences, occStart)
      : undefined;
    if (override) {
      const ovStart = toDate(override.start);
      if (!ovStart) continue; // override has no start — skip safely
      out.push({
        start: ovStart,
        end: toDate(override.end) ?? undefined,
        title:
          typeof override.summary === "string"
            ? override.summary.trim()
            : undefined,
        description:
          typeof override.description === "string"
            ? override.description
            : undefined,
      });
    } else {
      out.push({
        start: occStart,
        end: duration > 0 ? new Date(occStart.getTime() + duration) : undefined,
      });
    }
  }
  return out;
}

/** Treat a Date as wall-clock-in-tzid (i.e. its UTC components are the
 *  intended wall-clock time in tzid) and return the true UTC instant.
 *  Workaround for node-ical's rrule returning TZID-anchored occurrences
 *  as "wall-clock-as-UTC" rather than absolute moments. */
function reinterpretWallClock(d: Date, tzid: string): Date {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  const naive = `${y}-${m}-${day}T${hh}:${mm}:${ss}`;
  return new Date(naiveToUtcIso(naive, tzid));
}

function findRecurrenceOverride(
  recurrences: Record<string, nodeIcal.VEvent>,
  occurrence: Date,
): nodeIcal.VEvent | undefined {
  const ymd = occurrence.toISOString().slice(0, 10);
  for (const [key, val] of Object.entries(recurrences)) {
    if (key.startsWith(ymd) || ymd === key.slice(0, 10)) return val;
  }
  return undefined;
}

/** Coerce node-ical's `start`/`end` (Date or string) to a real Date. */
function toDate(v: unknown): Date | undefined {
  if (!v) return undefined;
  if (v instanceof Date) return v;
  const iso = toIsoOrUndefined(v);
  return iso ? new Date(iso) : undefined;
}
