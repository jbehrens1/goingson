import * as cheerio from "cheerio";
import type { Adapter, AdapterResult, EventRecord } from "../types";
import { buildEvent, politeFetch, toIsoOrUndefined } from "../util";
import { extractJsonLdEvents, jsonLdImageUrl, jsonLdLocation } from "./jsonld";

// Adapter for sites whose static HTML embeds many Eventbrite widget IDs
// but doesn't otherwise expose event dates/details. Laugh Factory San
// Diego (laughfactory.com/san-diego) is the canonical case: 56 unique
// shows on the page, each rendered server-side with descriptions and
// comedian rosters, with the actual dates living in the embedded
// Eventbrite widget config (`eventId: '<id>'`) — and only there.
//
// Strategy: fetch the source page, extract every unique numeric eventId
// from the inline widget JS, then fetch the canonical Eventbrite page
// for each (https://www.eventbrite.com/e/<id>) and parse its JSON-LD
// schema.org/Event.
//
// config:
//   concurrency  parallel Eventbrite fetches (default 6)
//   eventIdPattern  optional regex override for finding IDs in the page

const DEFAULT_ID_PATTERN = /eventId\s*:\s*['"](\d{8,20})['"]/g;

export const eventbritePageAdapter: Adapter = async ({ source }): Promise<AdapterResult> => {
  const cfg = (source.config ?? {}) as {
    concurrency?: number;
    eventIdPattern?: string;
    defaultVenue?: string;
  };
  const concurrency = Math.max(1, Math.min(cfg.concurrency ?? 6, 16));
  const idRe = cfg.eventIdPattern ? new RegExp(cfg.eventIdPattern, "g") : DEFAULT_ID_PATTERN;

  const res = await politeFetch(source.url);
  if (!res.ok) {
    return { events: [], warnings: [`HTTP ${res.status} fetching ${source.url}`] };
  }
  const html = await res.text();

  const ids = new Set<string>();
  let m: RegExpExecArray | null;
  // Reset lastIndex in case the consumer passes a /g regex
  idRe.lastIndex = 0;
  while ((m = idRe.exec(html)) !== null) {
    if (m[1]) ids.add(m[1]);
  }
  if (ids.size === 0) {
    return {
      events: [],
      warnings: [
        `${source.id}: no Eventbrite event IDs found via ${idRe.source} on ${source.url}.`,
      ],
    };
  }

  const events: EventRecord[] = [];
  const warnings: string[] = [];
  const idArr = Array.from(ids);

  for (let i = 0; i < idArr.length; i += concurrency) {
    const batch = idArr.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (id) => {
        const ebUrl = `https://www.eventbrite.com/e/${id}`;
        try {
          const ebRes = await politeFetch(ebUrl);
          if (!ebRes.ok) return { id, ebUrl, warning: `HTTP ${ebRes.status} fetching ${ebUrl}` };
          const ebHtml = await ebRes.text();
          const $ = cheerio.load(ebHtml);
          const ldEvents = extractJsonLdEvents($);
          if (ldEvents.length === 0) {
            return { id, ebUrl, warning: `${source.id}: no JSON-LD Event at ${ebUrl}` };
          }
          return { id, ebUrl, ldEvents };
        } catch (e) {
          return { id, ebUrl, warning: `${source.id}: ${(e as Error).message} (${ebUrl})` };
        }
      }),
    );
    for (const r of results) {
      if (r.warning) {
        warnings.push(r.warning);
        continue;
      }
      for (const ev of r.ldEvents ?? []) {
        const start = toIsoOrUndefined(ev.startDate);
        if (!start) continue;
        const loc = jsonLdLocation(ev.location);
        events.push(
          buildEvent(source, {
            naturalKey: ev.identifier ?? r.id,
            title: ev.name ?? "Untitled",
            description: ev.description,
            url: ev.url ?? r.ebUrl,
            start,
            end: toIsoOrUndefined(ev.endDate),
            location: {
              ...loc,
              venue: loc.venue ?? cfg.defaultVenue,
              town: source.town,
            },
            imageUrl: jsonLdImageUrl(ev.image),
          }),
        );
      }
    }
  }

  return { events, warnings };
};
