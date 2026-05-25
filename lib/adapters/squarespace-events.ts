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
  /** Squarespace stores collection categories + tags as string arrays.
   *  Most venues leave these empty, but when populated they're high-quality
   *  hints (e.g. "Concert", "Theater") that beat title regex. */
  categories?: string[];
  tags?: string[];
};

type SquarespaceJson = {
  items?: SquarespaceEvent[];
  upcoming?: SquarespaceEvent[];
  past?: SquarespaceEvent[];
};

type SquarespaceConfig = {
  /** Path to the events collection page (defaults to /events/). */
  path?: string;
  /** Optional list of additional collection paths to aggregate (e.g. Castle
   *  Hill keeps workshops at /all-workshops and concerts at /special-events). */
  paths?: string[];
  defaultVenue?: string;
};

function stripHtml(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || undefined;
}

// Squarespace shows a default map pin when the venue never set a location.
// These are the well-known defaults; if mapLat/Lng matches, ignore the coords
// and let the geocoder resolve from the address instead.
const SQUARESPACE_DEFAULTS: Array<{ lat: number; lon: number }> = [
  { lat: 37.2232823, lon: -95.7102394 }, // continental US center
  { lat: 40.7207559, lon: -74.0007613 }, // Manhattan (some templates)
  { lat: 38.7945952, lon: -106.5348379 }, // Salida, CO (another template default)
];

function isSquarespaceDefaultLocation(lat: number, lon: number): boolean {
  return SQUARESPACE_DEFAULTS.some(
    (d) => Math.abs(lat - d.lat) < 0.05 && Math.abs(lon - d.lon) < 0.05,
  );
}

export const squarespaceEventsAdapter: Adapter = async ({ source }): Promise<AdapterResult> => {
  const warnings: string[] = [];
  const cfg = (source.config ?? {}) as SquarespaceConfig;
  const u = new URL(source.url);

  // Aggregate one OR multiple collection paths. Cf. Castle Hill, which keeps
  // workshops and special-events in separate Squarespace collections.
  const pathList = cfg.paths && cfg.paths.length > 0 ? cfg.paths : [cfg.path ?? "/events/"];
  const candidates: SquarespaceEvent[] = [];
  const seenIds = new Set<string>();

  for (const rawPath of pathList) {
    const slash = rawPath.endsWith("/") ? "" : "/";
    const requestUrl = `${u.origin}${rawPath}${slash}?format=json-pretty`;
    const res = await politeFetch(requestUrl, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      warnings.push(`HTTP ${res.status} fetching ${requestUrl}`);
      continue;
    }
    let json: SquarespaceJson;
    try {
      json = (await res.json()) as SquarespaceJson;
    } catch (err) {
      warnings.push(`JSON parse failed for ${requestUrl}: ${(err as Error).message}`);
      continue;
    }
    const upcoming = json.upcoming ?? [];
    const items = json.items ?? [];
    const past = json.past ?? [];
    // Prefer upcoming, then items, then past. Past is included as a fallback
    // because some Squarespace events collections (esp. small venues that
    // forget to publish next-month dates promptly) return everything in
    // past[] — but the data is still real and includes today's show. The
    // events page filters by date so old shows don't pollute the default view.
    const pageItems =
      upcoming.length > 0 ? upcoming : items.length > 0 ? items : past;
    if (pageItems.length === 0) {
      warnings.push(
        `${source.id}: 0 events at ${requestUrl} (check if events collection exists or season is over).`,
      );
      continue;
    }
    for (const it of pageItems) {
      const key = it.id ?? it.urlId ?? it.fullUrl;
      if (key && seenIds.has(key)) continue;
      if (key) seenIds.add(key);
      candidates.push(it);
    }
  }

  if (candidates.length === 0) {
    return { events: [], warnings };
  }

  const events: ReturnType<typeof buildEvent>[] = [];
  for (const ev of candidates) {
    if (!ev.title || !ev.startDate) continue;
    const start = new Date(ev.startDate).toISOString();
    const end = ev.endDate ? new Date(ev.endDate).toISOString() : undefined;

    const loc = ev.location ?? {};
    let lat = loc.mapLat ?? loc.markerLat;
    let lon = loc.mapLng ?? loc.markerLng;
    // Drop Squarespace's default map pin so the geocoder can resolve the
    // real address (e.g. Wellfleet Library leaves the default Kansas pin).
    if (lat != null && lon != null && isSquarespaceDefaultLocation(lat, lon)) {
      lat = undefined;
      lon = undefined;
    }
    const venue = loc.addressTitle || cfg.defaultVenue;
    const address = [loc.addressLine1, loc.addressLine2].filter(Boolean).join(", ");

    const fullUrl = ev.fullUrl
      ? ev.fullUrl.startsWith("http")
        ? ev.fullUrl
        : new URL(ev.fullUrl, source.url).toString()
      : source.url;

    const cats = [
      ...(Array.isArray(ev.categories) ? ev.categories : []),
      ...(Array.isArray(ev.tags) ? ev.tags : []),
    ].filter((c): c is string => typeof c === "string");
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
        categories: cats.length ? cats : undefined,
      }),
    );
  }

  return { events, warnings };
};
