import type { Adapter, AdapterResult, EventRecord } from "../types";
import { buildEvent, politeFetch } from "../util";

// Ticketmaster Discovery API adapter for venues whose direct websites are
// either bot-blocked (McCallum behind Kemo) or backed by Ticketmaster
// ticketing (Morongo, Fantasy Springs, Agua Caliente). Requires a free
// API key from https://developer.ticketmaster.com/ exposed as
// TICKETMASTER_API_KEY. When the env var is missing the adapter yields
// zero events with a warning — it does NOT throw, so a missing key
// doesn't break an all-regions ingest run.
//
// Source config shape:
//
//   {
//     "id": "...",
//     "adapter": "ticketmaster",
//     "url": "https://www.example.com/",   (display only, not fetched)
//     "config": {
//       "venueId": "KovZpZAEFlAA",         (preferred — exact match)
//       "keyword": "Pappy Harriets",       (fallback — fuzzy, may need dedup)
//       "size": 100,                       (optional — default 100, max 200)
//       "countryCode": "US"                (optional — default US)
//     }
//   }
//
// Either venueId or keyword is required. venueId is much more precise;
// use keyword only when you don't know the ID. To find a venueId, set
// TICKETMASTER_API_KEY and hit:
//   https://app.ticketmaster.com/discovery/v2/venues?apikey=KEY&keyword=Morongo
// then pick the right `.id` from the response.

type TmAttraction = { name?: string };
type TmVenue = {
  id?: string;
  name?: string;
  city?: { name?: string };
  state?: { stateCode?: string };
  address?: { line1?: string };
  postalCode?: string;
};
type TmClassification = {
  segment?: { name?: string };
  genre?: { name?: string };
  subGenre?: { name?: string };
};
type TmEvent = {
  id: string;
  name: string;
  url?: string;
  info?: string;
  pleaseNote?: string;
  dates?: {
    start?: {
      dateTime?: string;       // ISO 8601 UTC, e.g. "2026-07-04T03:00:00Z"
      localDate?: string;      // YYYY-MM-DD (venue-local)
      localTime?: string;      // HH:MM:SS (venue-local)
      noSpecificTime?: boolean;
    };
    end?: { dateTime?: string };
    timezone?: string;
    status?: { code?: string };
  };
  classifications?: TmClassification[];
  _embedded?: {
    venues?: TmVenue[];
    attractions?: TmAttraction[];
  };
};

type TmPage = {
  _embedded?: { events?: TmEvent[] };
  page?: { totalElements?: number; totalPages?: number; number?: number };
};

export const ticketmasterAdapter: Adapter = async (ctx): Promise<AdapterResult> => {
  const cfg = (ctx.source.config ?? {}) as {
    venueId?: string;
    keyword?: string;
    size?: number;
    countryCode?: string;
  };
  const apiKey = process.env.TICKETMASTER_API_KEY?.trim();

  if (!apiKey) {
    return {
      events: [],
      warnings: [
        `${ctx.source.id}: TICKETMASTER_API_KEY env var not set — adapter disabled. Get a free key at https://developer.ticketmaster.com/ then set the env var.`,
      ],
    };
  }
  if (!cfg.venueId && !cfg.keyword) {
    return {
      events: [],
      warnings: [
        `${ctx.source.id}: ticketmaster adapter needs either config.venueId or config.keyword`,
      ],
    };
  }

  const size = Math.min(cfg.size ?? 100, 200);
  const params = new URLSearchParams({
    apikey: apiKey,
    size: String(size),
    countryCode: cfg.countryCode ?? "US",
    sort: "date,asc",
  });
  if (cfg.venueId) params.set("venueId", cfg.venueId);
  if (cfg.keyword) params.set("keyword", cfg.keyword);

  const url = `https://app.ticketmaster.com/discovery/v2/events.json?${params.toString()}`;
  const res = await politeFetch(url);
  if (!res.ok) {
    const body = await res.text();
    return {
      events: [],
      warnings: [
        `${ctx.source.id}: Ticketmaster API HTTP ${res.status}: ${body.slice(0, 200)}`,
      ],
    };
  }
  const json = (await res.json()) as TmPage;
  const tmEvents = json._embedded?.events ?? [];

  const events: EventRecord[] = [];
  const warnings: string[] = [];

  for (const ev of tmEvents) {
    const start = ev.dates?.start?.dateTime;
    if (!start) {
      // No exact time published — skip rather than guess. TM uses this for
      // "TBA" shows where the venue hasn't confirmed timing yet.
      continue;
    }
    const end = ev.dates?.end?.dateTime;
    const venue = ev._embedded?.venues?.[0];
    const venueName = venue?.name;
    const town = venue?.city?.name;
    const address = venue?.address?.line1;

    // Compose a description from the optional `info` / `pleaseNote` fields
    // plus the headlining attractions and genre, when available.
    const attractions = (ev._embedded?.attractions ?? [])
      .map((a) => a.name)
      .filter((n): n is string => !!n);
    const cls = ev.classifications?.[0];
    const genrePieces = [cls?.genre?.name, cls?.subGenre?.name]
      .filter((s): s is string => !!s && s !== "Undefined");
    const descLines = [
      ev.info,
      ev.pleaseNote,
      attractions.length ? `With: ${attractions.join(", ")}` : undefined,
      genrePieces.length ? genrePieces.join(" / ") : undefined,
    ].filter((s): s is string => !!s);
    const description = descLines.length ? descLines.join("\n\n") : undefined;

    events.push(
      buildEvent(ctx.source, {
        naturalKey: ev.id,
        title: ev.name,
        description,
        url: ev.url ?? ctx.source.url,
        start,
        end,
        location: venueName ? { venue: venueName, address, town } : undefined,
      }),
    );
  }

  // Surface total/dropped counts so the user can tell if pagination is needed.
  const total = json.page?.totalElements ?? tmEvents.length;
  if (tmEvents.length < total) {
    warnings.push(
      `${ctx.source.id}: returned ${tmEvents.length} of ${total} total — bump config.size (max 200) or implement pagination`,
    );
  }

  return { events, warnings };
};
