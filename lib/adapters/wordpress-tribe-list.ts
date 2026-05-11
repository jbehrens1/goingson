import * as cheerio from "cheerio";
import type { Adapter, AdapterResult, EventRecord } from "../types";
import { buildEvent, politeFetch, toIsoOrUndefined } from "../util";
import { extractJsonLdEvents, jsonLdImageUrl, jsonLdLocation } from "./jsonld";

// Companion to `wordpress-tribe`. Use this when a Tribe Events Calendar site's
// REST API is locked down or returns an incomplete subset of events, but the
// public list view (/calendar/list/) renders JSON-LD `Event` schema for each
// visible event. We paginate `/calendar/list/page/N/` until no new events,
// then aggregate.
//
// Confirmed working on: bostonjcc.org (REST exposes only featured events;
// list pages show the full calendar).

type WPTribeListConfig = {
  // Path under the site root that lists events. Defaults to "/calendar/list/".
  // Override if a site uses a different slug (e.g. "/events/list/").
  basePath?: string;
  maxPages?: number;
};

function listUrl(siteRoot: string, basePath: string, page: number): string {
  const origin = new URL(siteRoot).origin;
  const base = basePath.startsWith("/") ? basePath : `/${basePath}`;
  const slash = base.endsWith("/") ? "" : "/";
  return page === 1 ? `${origin}${base}${slash}` : `${origin}${base}${slash}page/${page}/`;
}

export const wordpressTribeListAdapter: Adapter = async ({ source }): Promise<AdapterResult> => {
  const warnings: string[] = [];
  const cfg = (source.config ?? {}) as WPTribeListConfig;
  const basePath = cfg.basePath ?? "/calendar/list/";
  const maxPages = cfg.maxPages ?? 8;

  const seenIds = new Set<string>();
  const events: EventRecord[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = listUrl(source.url, basePath, page);
    const res = await politeFetch(url);
    if (!res.ok) {
      if (page === 1) {
        return { events, warnings: [`HTTP ${res.status} fetching ${url}`] };
      }
      break;
    }
    const html = await res.text();
    const $ = cheerio.load(html);
    const ldEvents = extractJsonLdEvents($);
    if (ldEvents.length === 0) break;

    let addedThisPage = 0;
    for (const ev of ldEvents) {
      const start = toIsoOrUndefined(ev.startDate);
      if (!start || !ev.name) continue;
      const eventUrl = ev.url ?? source.url;
      const naturalKey = ev.identifier ?? `${ev.name}::${start}`;
      const dedupId = `${eventUrl}::${start}`;
      if (seenIds.has(dedupId)) continue;
      seenIds.add(dedupId);

      const loc = jsonLdLocation(ev.location);
      events.push(
        buildEvent(source, {
          naturalKey,
          title: ev.name.replace(/&#0?38;/g, "&"),
          description:
            typeof ev.description === "string" ? ev.description : undefined,
          url: eventUrl,
          start,
          end: toIsoOrUndefined(ev.endDate),
          location: { ...loc, town: loc.address?.split(",")[1]?.trim() ?? source.town },
          imageUrl: jsonLdImageUrl(ev.image),
        }),
      );
      addedThisPage++;
    }

    // Stop early if a page produced no new events (Tribe sometimes loops back).
    if (addedThisPage === 0) break;
  }

  if (events.length === 0) {
    warnings.push(
      `${source.id}: no JSON-LD events found on ${listUrl(source.url, basePath, 1)}.`,
    );
  }

  return { events, warnings };
};
