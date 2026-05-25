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

type MCEmbeddedTerm = {
  name?: string;
  slug?: string;
  taxonomy?: string;
};

type MCEvent = {
  id: number;
  slug: string;
  link: string;
  status?: string;
  title: { rendered: string };
  ACF?: MCAcf;
  acf?: MCAcf;
  /** Present when we request `?_embed=1`. Each inner array is one taxonomy's
   *  terms. TCAN exposes `event-type` (Performances / Screenings / Community
   *  / Education / Event Canceled / Event Postponed), `xdgp_genre` (Jazz,
   *  Folk, Theater, Drama, Documentary, …), and `venue`. */
  _embedded?: { "wp:term"?: MCEmbeddedTerm[][] };
};

// Taxonomies that signal the event isn't actually happening — drop these
// instead of carrying them into the feed.
const CANCELED_TERM_SLUGS = new Set([
  "event-canceled",
  "event-cancelled",
  "event-postponed",
  "canceled",
  "cancelled",
  "postponed",
]);

/** Extract human-readable taxonomy names from a `?_embed=1` MC event response.
 *  Ordering matters: more specific taxonomies (genre) come BEFORE coarser
 *  ones (event-type) so the platform-category mapper picks "Theater" over
 *  the generic "Performances" for a play. Venue terms are skipped — they're
 *  location info, not categorization signal. */
function extractTaxonomyTerms(ev: MCEvent): {
  terms: string[];
  canceled: boolean;
} {
  const groups = ev._embedded?.["wp:term"];
  if (!Array.isArray(groups)) return { terms: [], canceled: false };
  const byTax: Record<string, string[]> = {};
  let canceled = false;
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const term of group) {
      if (!term || typeof term !== "object") continue;
      const tax = term.taxonomy ?? "_unknown";
      const slug = term.slug;
      if (slug && CANCELED_TERM_SLUGS.has(slug)) canceled = true;
      if (tax === "venue") continue;
      const name = typeof term.name === "string" ? term.name.trim() : "";
      if (!name) continue;
      (byTax[tax] ??= []).push(name);
    }
  }
  // Ordering priority for the platform-tag mapper (first match wins):
  //   1. "Screenings" (when present in event-type) — it's a format, not a
  //      content type, and should always win film over genres like "Drama"
  //      (e.g. The Devil Wears Prada 2 is Drama + Screenings → we want film).
  //   2. Genre/sub-taxonomy ("Theater", "Jazz", "Blues") — specific signal
  //      that beats coarse event-type. E.g. plays at TCAN are tagged
  //      event-type=Performances + xdgp_genre=Theater → we want theater.
  //   3. Remaining event-type values ("Performances", "Community",
  //      "Education") — final fallback when genre didn't classify.
  //   4. Any other taxonomies on non-TCAN MC installs.
  const eventType = byTax["event-type"] ?? [];
  const screenings = eventType.filter((n) => /^screenings?$/i.test(n));
  const otherEventType = eventType.filter((n) => !/^screenings?$/i.test(n));
  const ordered = [
    ...screenings,
    ...(byTax["xdgp_genre"] ?? []),
    ...otherEventType,
    ...Object.entries(byTax)
      .filter(([k]) => k !== "xdgp_genre" && k !== "event-type")
      .flatMap(([, v]) => v),
  ];
  return { terms: ordered, canceled };
}

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

  let canceledCount = 0;
  while (pagesFetched < maxPages) {
    pagesFetched++;
    // _embed=1 inlines the taxonomy terms (event-type, genre) so we can
    // hand them to categorize() as platform tags. Roughly 3x response size,
    // but TCAN-style sites have ≤200 events so still small.
    const url = `${endpoint}?per_page=${perPage}&page=${page}&orderby=date&order=desc&_embed=1`;
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

      const { terms: categories, canceled } = extractTaxonomyTerms(ev);
      if (canceled) {
        canceledCount++;
        continue;
      }

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
          categories: categories.length ? categories : undefined,
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
  if (canceledCount > 0) {
    warnings.push(`Dropped ${canceledCount} event${canceledCount === 1 ? "" : "s"} flagged as canceled/postponed.`);
  }

  return { events, warnings };
};
