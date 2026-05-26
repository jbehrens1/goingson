import type { Adapter, AdapterResult } from "../types";
import { buildEvent, politeFetch, toIsoOrUndefined } from "../util";

// Tribe REST returns `utc_start_date` / `utc_end_date` as naive UTC strings
// like "2026-05-11 17:30:00" with no trailing Z. `new Date()` parses unmarked
// strings as LOCAL time, which produces wrong ISO timestamps when ingest runs
// in a non-UTC timezone (e.g. a dev machine in ET). Force UTC interpretation.
function parseUtcNaive(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(t)) {
    return new Date(t.replace(" ", "T") + "Z").toISOString();
  }
  return toIsoOrUndefined(s);
}

// The Events Calendar (Tribe) plugin exposes a REST API at
// `/wp-json/tribe/events/v1/events`. This adapter is generic — point any
// source's `url` at the site root or events page; we'll derive the REST URL.

type TribeVenue = {
  venue?: string;
  city?: string;
  address?: string;
  state?: string;
  zip?: string;
};

type TribeTerm = { name?: string; slug?: string };

type TribeEvent = {
  id: number;
  url: string;
  title: string;
  description?: string;
  excerpt?: string;
  slug: string;
  image?: { url?: string } | false | null;
  all_day?: boolean;
  start_date?: string;
  end_date?: string;
  utc_start_date?: string;
  utc_end_date?: string;
  timezone?: string;
  venue?: TribeVenue | TribeVenue[] | [];
  categories?: TribeTerm[];
  tags?: TribeTerm[];
};

function termNames(terms: TribeTerm[] | undefined): string[] | undefined {
  if (!terms?.length) return undefined;
  const names = terms.map((t) => t.name).filter((n): n is string => !!n);
  return names.length ? names : undefined;
}

type TribePage = {
  events?: TribeEvent[];
  total?: number;
  total_pages?: number;
  next_rest_url?: string;
};

function tribeEndpoint(sourceUrl: string): string {
  // Allow source.url to be either the events page, the site root, or the
  // REST endpoint itself. We derive the REST URL from the site origin.
  const u = new URL(sourceUrl);
  return `${u.origin}/wp-json/tribe/events/v1/events`;
}

function firstVenue(v: TribeEvent["venue"]): TribeVenue | undefined {
  if (!v) return undefined;
  if (Array.isArray(v)) return v[0];
  return v;
}

function decodeEntities(s: string): string {
  // Tribe REST sometimes returns titles/venues with raw HTML numeric entities
  // (`&#8211;`, `&#8217;`, `&amp;`) — that's e.g. Payomet's "Payomet &#8211;
  // Performing Arts Center" venue string, which would otherwise show literally
  // and fragment the venue dropdown into duplicates.
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    // Numeric entities (decimal): &#8211; etc.
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    // Numeric entities (hex): &#x2014; etc.
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    });
}

function stripHtml(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return (
    decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() ||
    undefined
  );
}

type WordpressTribeConfig = {
  defaultVenue?: string;
};

export const wordpressTribeAdapter: Adapter = async ({ source }): Promise<AdapterResult> => {
  const warnings: string[] = [];
  const cfg = (source.config ?? {}) as WordpressTribeConfig;
  const endpoint = tribeEndpoint(source.url);

  // Tribe defaults to "today onward". Provide an explicit window so we get
  // sites that may have date-range gating; cap at 2 years out.
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCFullYear(end.getUTCFullYear() + 2);

  const params = new URLSearchParams({
    per_page: "50",
    page: "1",
    start_date: start.toISOString().slice(0, 19).replace("T", " "),
    end_date: end.toISOString().slice(0, 19).replace("T", " "),
    status: "publish",
  });

  const events: ReturnType<typeof buildEvent>[] = [];
  let nextUrl: string | undefined = `${endpoint}?${params}`;
  let pagesFetched = 0;
  const maxPages = 10;

  while (nextUrl && pagesFetched < maxPages) {
    pagesFetched++;
    const res = await politeFetch(nextUrl, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      return { events, warnings: [...warnings, `HTTP ${res.status} fetching ${nextUrl}`] };
    }
    const json = (await res.json()) as TribePage;
    for (const ev of json.events ?? []) {
      const startIso = parseUtcNaive(ev.utc_start_date) ?? toIsoOrUndefined(ev.start_date);
      if (!startIso) {
        warnings.push(`Skipped event ${ev.id} (no start date)`);
        continue;
      }
      const venue = firstVenue(ev.venue);
      const image = ev.image && typeof ev.image === "object" ? ev.image.url : undefined;
      // Tribe exposes categories (taxonomy = tribe_events_cat) and tags. Some
      // sites populate categories ("Concert", "Theater"), others populate tags
      // ("live music"). Pass both through to categorize() as platform hints.
      const cats = [
        ...(termNames(ev.categories) ?? []),
        ...(termNames(ev.tags) ?? []),
      ];
      events.push(
        buildEvent(source, {
          naturalKey: String(ev.id),
          title: stripHtml(ev.title) ?? "Untitled",
          description: stripHtml(ev.description ?? ev.excerpt),
          url: ev.url,
          start: startIso,
          end: parseUtcNaive(ev.utc_end_date) ?? toIsoOrUndefined(ev.end_date),
          allDay: !!ev.all_day,
          location: {
            // Decode HTML entities in venue name too — Tribe REST returns
            // e.g. "Payomet &#8211; Performing Arts Center" verbatim, which
            // would otherwise duplicate the venue in the venue dropdown.
            venue: venue?.venue
              ? decodeEntities(venue.venue)
              : cfg.defaultVenue,
            town: venue?.city ?? source.town,
            address: venue
              ? [venue.address, venue.city, venue.state].filter(Boolean).join(", ") || undefined
              : undefined,
          },
          imageUrl: image,
          categories: cats.length ? cats : undefined,
        }),
      );
    }
    nextUrl = json.next_rest_url || undefined;
  }

  if (pagesFetched >= maxPages && nextUrl) {
    warnings.push(`Stopped after ${maxPages} pages — more events may exist.`);
  }

  return { events, warnings };
};
