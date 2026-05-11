import type { Adapter, AdapterResult } from "../types";
import { buildEvent, politeFetch, toIsoOrUndefined } from "../util";

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
};

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

function stripHtml(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || undefined;
}

export const wordpressTribeAdapter: Adapter = async ({ source }): Promise<AdapterResult> => {
  const warnings: string[] = [];
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
      const startIso = toIsoOrUndefined(ev.utc_start_date ?? ev.start_date);
      if (!startIso) {
        warnings.push(`Skipped event ${ev.id} (no start date)`);
        continue;
      }
      const venue = firstVenue(ev.venue);
      const image = ev.image && typeof ev.image === "object" ? ev.image.url : undefined;
      events.push(
        buildEvent(source, {
          naturalKey: String(ev.id),
          title: stripHtml(ev.title) ?? "Untitled",
          description: stripHtml(ev.description ?? ev.excerpt),
          url: ev.url,
          start: startIso,
          end: toIsoOrUndefined(ev.utc_end_date ?? ev.end_date),
          allDay: !!ev.all_day,
          location: {
            venue: venue?.venue,
            town: venue?.city ?? source.town,
            address: venue
              ? [venue.address, venue.city, venue.state].filter(Boolean).join(", ") || undefined
              : undefined,
          },
          imageUrl: image,
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
