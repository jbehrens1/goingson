import type { Adapter, AdapterResult } from "../types";
import { buildEvent, politeFetch } from "../util";

// Squarespace exposes any "collection" page as JSON by appending
// ?format=json-pretty. For event-type collections (calendar pages), the
// upcoming events live in the `.upcoming[]` array with:
//   - title, fullUrl, excerpt
//   - startDate / endDate as Unix milliseconds
//   - location.{mapLat, mapLng, addressTitle, addressLine1, addressCountry, ...}
//   - assetUrl (cover image)
//   - body (HTML, often verbose)
//
// Confirmed working on:
//   provincetownlibrary.org/events/
//   wellfleetlibrary.org/events/
//   wellfleetpreservationhall.org/calendar/
//   castlehill.org/events/        (returns 0 when off-season)
//
// snowlibrary.org has no events collection at the obvious paths — the adapter
// will report an empty result with a warning.

type SquarespaceLocation = {
  mapLat?: number;
  mapLng?: number;
  markerLat?: number;
  markerLng?: number;
  addressTitle?: string;
  addressLine1?: string;
  addressLine2?: string;
  addressCountry?: string;
};

type SquarespaceEvent = {
  id: string;
  urlId?: string;
  fullUrl?: string;
  title?: string;
  excerpt?: string;
  body?: string;
  startDate?: number;
  endDate?: number;
  location?: SquarespaceLocation;
  assetUrl?: string;
  recordTypeLabel?: string;
};

type SquarespaceJson = {
  items?: SquarespaceEvent[];
  upcoming?: SquarespaceEvent[];
  past?: SquarespaceEvent[];
};

type SquarespaceConfig = {
  /** Path to the events collection page (defaults to /events/). */
  path?: string;
  defaultVenue?: string;
};

function stripHtml(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || undefined;
}

export const squarespaceEventsAdapter: Adapter = async ({ source }): Promise<AdapterResult> => {
  const warnings: string[] = [];
  const cfg = (source.config ?? {}) as SquarespaceConfig;
  const u = new URL(source.url);
  const path = cfg.path ?? "/events/";
  const slash = path.endsWith("/") ? "" : "/";
  const requestUrl = `${u.origin}${path}${slash}?format=json-pretty`;

  const res = await politeFetch(requestUrl, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    return { events: [], warnings: [`HTTP ${res.status} fetching ${requestUrl}`] };
  }
  let json: SquarespaceJson;
  try {
    json = (await res.json()) as SquarespaceJson;
  } catch (err) {
    return {
      events: [],
      warnings: [`JSON parse failed for ${requestUrl}: ${(err as Error).message}`],
    };
  }

  const upcoming = json.upcoming ?? [];
  // Some collection types (calendar grid) use .items instead of .upcoming.
  const candidates = upcoming.length > 0 ? upcoming : (json.items ?? []);

  if (candidates.length === 0) {
    warnings.push(
      `${source.id}: 0 upcoming events at ${requestUrl} (check if events collection exists or season is over).`,
    );
    return { events: [], warnings };
  }

  const events: ReturnType<typeof buildEvent>[] = [];
  for (const ev of candidates) {
    if (!ev.title || !ev.startDate) continue;
    const start = new Date(ev.startDate).toISOString();
    const end = ev.endDate ? new Date(ev.endDate).toISOString() : undefined;

    const loc = ev.location ?? {};
    const lat = loc.mapLat ?? loc.markerLat;
    const lon = loc.mapLng ?? loc.markerLng;
    const venue = loc.addressTitle || cfg.defaultVenue;
    const address = [loc.addressLine1, loc.addressLine2].filter(Boolean).join(", ");

    const fullUrl = ev.fullUrl
      ? ev.fullUrl.startsWith("http")
        ? ev.fullUrl
        : new URL(ev.fullUrl, source.url).toString()
      : source.url;

    events.push(
      buildEvent(source, {
        naturalKey: ev.id ?? ev.urlId ?? fullUrl,
        title: ev.title,
        description: stripHtml(ev.excerpt) ?? stripHtml(ev.body),
        url: fullUrl,
        start,
        end,
        location: {
          venue,
          town: source.town,
          address: address || undefined,
          lat,
          lon,
        },
        imageUrl: ev.assetUrl,
      }),
    );
  }

  return { events, warnings };
};
