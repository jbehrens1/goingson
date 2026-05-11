import type { Adapter, AdapterResult } from "../types";
import { buildEvent, naiveToUtcIso, politeFetch } from "../util";

// "My Calendar" WordPress plugin (mc_event post type) — exposed via standard
// WP REST as /wp-json/wp/v2/mc_event. Event dates live in ACF (Advanced Custom
// Fields). TCAN is the seed user of this adapter.
//
// `display_dates_sort` is typically an ISO date "YYYY-MM-DD" for concrete shows,
// or a free-text string ("May 1 - June 30", "Sep 25, 2026 | Member presale…")
// for ongoing exhibits / vague-date entries. We parse both.

type MCAcfImage = { url?: string };
type MCAcf = {
  short_desc?: string;
  long_desc?: string;
  cover_image?: MCAcfImage | false;
  calendar_image?: MCAcfImage | false;
  hide_event_from_calendar?: boolean;
  display_dates_long?: string;
  display_dates_short?: string;
  display_dates_sort?: string;
  vague_dates?: string;
};

type MCEvent = {
  id: number;
  slug: string;
  link: string;
  status?: string;
  title: { rendered: string };
  ACF?: MCAcf;
  acf?: MCAcf;
};

type WordpressMcConfig = {
  defaultVenue?: string;
  defaultTimeZone?: string; // IANA tz; falls back to region's timezone
};

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function stripHtml(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || undefined;
}

function parseTime(text: string | undefined): { hour: number; minute: number } | null {
  if (!text) return null;
  const m = text.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = m[3].toLowerCase();
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  return { hour: h, minute: min };
}

type YMD = { y: number; m: number; d: number };

function parseDateRange(
  sort: string | undefined,
  long: string | undefined,
): { start: YMD; end?: YMD } | null {
  // Case 1: sort is exact ISO date "YYYY-MM-DD"
  if (sort && /^\d{4}-\d{2}-\d{2}$/.test(sort)) {
    const [y, m, d] = sort.split("-").map(Number);
    return { start: { y, m, d } };
  }
  // Case 2: ISO date range "YYYY-MM-DD – YYYY-MM-DD" (en-dash or hyphen)
  for (const text of [sort, long]) {
    if (!text) continue;
    const r = text.match(/^(\d{4})-(\d{2})-(\d{2})\s*[–-]\s*(\d{4})-(\d{2})-(\d{2})/);
    if (r) {
      return {
        start: { y: +r[1], m: +r[2], d: +r[3] },
        end: { y: +r[4], m: +r[5], d: +r[6] },
      };
    }
  }
  // Case 3: "Mon DD, YYYY" anywhere in the text (single date, no range)
  for (const text of [sort, long]) {
    if (!text) continue;
    const m = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})\b/i);
    if (m) {
      return {
        start: {
          y: parseInt(m[3], 10),
          m: MONTHS[m[1].slice(0, 3).toLowerCase()],
          d: parseInt(m[2], 10),
        },
      };
    }
  }
  return null;
}

function ymdToNaive(ymd: YMD, hour = 0, minute = 0): string {
  return `${ymd.y}-${String(ymd.m).padStart(2, "0")}-${String(ymd.d).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}

export const wordpressMcAdapter: Adapter = async ({ source }): Promise<AdapterResult> => {
  const warnings: string[] = [];
  const u = new URL(source.url);
  const endpoint = `${u.origin}/wp-json/wp/v2/mc_event`;
  const cfg = (source.config ?? {}) as WordpressMcConfig;
  const tz = cfg.defaultTimeZone || "America/New_York";

  const events: ReturnType<typeof buildEvent>[] = [];
  const perPage = 100;
  let page = 1;
  let pagesFetched = 0;
  const maxPages = 5;

  while (pagesFetched < maxPages) {
    pagesFetched++;
    const url = `${endpoint}?per_page=${perPage}&page=${page}&orderby=date&order=desc`;
    const res = await politeFetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      // WP returns 400 when paging beyond the end. That's a clean stop.
      if (res.status === 400) break;
      return { events, warnings: [...warnings, `HTTP ${res.status} fetching ${url}`] };
    }
    const list = (await res.json()) as MCEvent[];
    if (!Array.isArray(list) || list.length === 0) break;

    const now = Date.now();
    let pastInPage = 0;
    for (const ev of list) {
      const acf = ev.ACF ?? ev.acf ?? {};
      if (acf.hide_event_from_calendar) continue;

      const range = parseDateRange(acf.display_dates_sort, acf.display_dates_long);
      if (!range) {
        warnings.push(`Skipped "${ev.title.rendered}" — unparseable date "${acf.display_dates_sort}"`);
        continue;
      }
      const time = parseTime(acf.display_dates_long ?? acf.display_dates_short);
      const startIso = naiveToUtcIso(
        ymdToNaive(range.start, time?.hour ?? 0, time?.minute ?? 0),
        tz,
      );
      const endIso = range.end ? naiveToUtcIso(ymdToNaive(range.end, 23, 59), tz) : undefined;

      // Skip events whose end (or start, if no end) is more than 12h in the past.
      const effectiveEnd = new Date(endIso ?? startIso).getTime();
      if (effectiveEnd < now - 12 * 3600_000) {
        pastInPage++;
        continue;
      }

      const image =
        acf.cover_image && typeof acf.cover_image === "object" ? acf.cover_image.url : undefined;
      const calImage =
        acf.calendar_image && typeof acf.calendar_image === "object" ? acf.calendar_image.url : undefined;

      events.push(
        buildEvent(source, {
          naturalKey: String(ev.id),
          title: stripHtml(ev.title.rendered) ?? "Untitled",
          description: stripHtml(acf.short_desc) ?? stripHtml(acf.long_desc),
          url: ev.link,
          start: startIso,
          end: endIso,
          allDay: !time,
          location: {
            venue: cfg.defaultVenue,
            town: source.town,
          },
          imageUrl: image ?? calImage,
        }),
      );
    }
    // If every event in the page was already past, no point fetching deeper.
    if (pastInPage === list.length) break;

    if (list.length < perPage) break;
    page++;
  }

  if (pagesFetched >= maxPages) {
    warnings.push(`Stopped after ${maxPages} pages — more events may exist.`);
  }

  return { events, warnings };
};
