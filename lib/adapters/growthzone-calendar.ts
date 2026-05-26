import * as cheerio from "cheerio";
import type { Adapter, AdapterResult } from "../types";
import { buildEvent, naiveToUtcIso, politeFetch } from "../util";

// GrowthZone (ChamberMaster) "Community Calendar" pages. Used by chambers of
// commerce: business.<chamber>.com/community-calendar or similar paths.
//
// Each event is a server-rendered card with schema.org microdata:
//   <div class="gz-events-card" itemscope itemtype="http://schema.org/Event">
//     <a class="gz-event-card-title" itemprop="url" href="...Details/...">Title</a>
//     <h5 class="gz-event-card-time">8:00 PM - 4:30 PM</h5>
//     <meta itemprop="startDate" content="5/23/2026 8:00:00 PM">
//     <meta itemprop="endDate" content="6/7/2026 4:30:00 PM">
//     <img itemprop="image" src="..." />
//   </div>
//
// GrowthZone also exposes per-event iCal at /community-calendar/ical?... but
// has no calendar-wide iCal export, so we parse the rendered HTML.

type GrowthZoneConfig = {
  /** IANA timezone for the calendar's wall-clock times. Defaults to
   *  America/New_York. */
  defaultTimeZone?: string;
  /** Fallback venue name when an event card doesn't list one. */
  defaultVenue?: string;
};

const MONTHS_NUM: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Parse a GrowthZone meta-itemprop date like "5/23/2026 8:00:00 PM" into a
 *  naive ISO string ("2026-05-23T20:00:00") suitable for naiveToUtcIso. */
function parseGzDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = raw
    .trim()
    .match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM))?$/i,
    );
  if (!m) return null;
  const [, mo, da, yr, hRaw, min, sec, ampm] = m;
  let h = hRaw ? parseInt(hRaw, 10) : 0;
  if (ampm) {
    const period = ampm.toUpperCase();
    if (period === "PM" && h < 12) h += 12;
    if (period === "AM" && h === 12) h = 0;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${yr}-${pad(parseInt(mo, 10))}-${pad(parseInt(da, 10))}T${pad(h)}:${min ?? "00"}:${sec ?? "00"}`;
}

export const growthzoneCalendarAdapter: Adapter = async ({
  source,
}): Promise<AdapterResult> => {
  const warnings: string[] = [];
  const cfg = (source.config ?? {}) as GrowthZoneConfig;
  const tz = cfg.defaultTimeZone || "America/New_York";

  const res = await politeFetch(source.url);
  if (!res.ok) {
    return {
      events: [],
      warnings: [`HTTP ${res.status} fetching ${source.url}`],
    };
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  const events: ReturnType<typeof buildEvent>[] = [];
  const seenIds = new Set<string>();

  // Each schema.org/Event microdata card.
  $('div[itemtype*="schema.org/Event"]').each((_i, el) => {
    const node = $(el);
    // Prefer the schema.org-marked <a itemprop="url">, fall back to the
    // .gz-event-card-title class if microdata is missing.
    let titleEl = node.find('[itemprop="url"]').first();
    if (titleEl.length === 0) {
      titleEl = node.find(".gz-event-card-title").first();
    }
    const title = titleEl.text().trim();
    const url = titleEl.attr("href") ?? source.url;
    if (!title) return;

    const startRaw = node.find('meta[itemprop="startDate"]').attr("content");
    const endRaw = node.find('meta[itemprop="endDate"]').attr("content");
    const startNaive = parseGzDate(startRaw);
    if (!startNaive) {
      warnings.push(`Skipped "${title}" — unparseable startDate "${startRaw}"`);
      return;
    }
    const startIso = naiveToUtcIso(startNaive, tz);
    const endNaive = parseGzDate(endRaw ?? undefined);
    const endIso = endNaive ? naiveToUtcIso(endNaive, tz) : undefined;

    const imageUrl =
      node.find('[itemprop="image"]').first().attr("src") ?? undefined;
    const description =
      node.find('[itemprop="description"]').first().text().trim() || undefined;

    // Location: GrowthZone cards sometimes carry an itemprop="location" with
    // nested name/address. When absent, fall back to the configured default.
    const locationName =
      node.find('[itemprop="location"] [itemprop="name"]').first().text().trim() ||
      node
        .find('[itemprop="location"] [itemprop="streetAddress"]')
        .first()
        .text()
        .trim() ||
      undefined;
    const venue = locationName || cfg.defaultVenue;

    // Natural key: use the Details slug from the URL when present, else the
    // title + date string. Dedupe against same-card-duplicated markup (the
    // card image is also wrapped in a Details link).
    const slugMatch = url.match(/\/Details\/([^?#]+)/);
    const naturalKey = slugMatch
      ? slugMatch[1]
      : `${title.toLowerCase().replace(/\s+/g, "-")}::${startIso}`;
    if (seenIds.has(naturalKey)) return;
    seenIds.add(naturalKey);

    events.push(
      buildEvent(source, {
        naturalKey,
        title,
        description,
        url,
        start: startIso,
        end: endIso,
        location: { venue, town: source.town },
        imageUrl,
      }),
    );
  });

  return { events, warnings };
};
