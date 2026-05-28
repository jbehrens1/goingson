import * as cheerio from "cheerio";
import type { Adapter, AdapterResult, EventRecord } from "../types";
import { buildEvent, politeFetch, toIsoOrUndefined } from "../util";
import { extractJsonLdEvents, jsonLdImageUrl, jsonLdLocation } from "./jsonld";

// Adapter for venues whose ticketing runs on events.leapevents.com (the
// "Leap" platform). The Comedy Store La Jolla is the canonical case:
// thecomedystore.com/la-jolla/calendar embeds 20+ <a href="https://events
// .leapevents.com/event/<slug>"> links and nothing else parseable. Each
// individual event page on events.leapevents.com exposes a complete
// schema.org/Event JSON-LD with name, startDate, endDate, location, image.
//
// Strategy: fetch the list page, regex out events.leapevents.com/event/*
// URLs, fetch each in bounded parallel, parse JSON-LD.
//
// config:
//   linkPattern  optional override for the URL regex (defaults to
//                events.leapevents.com/event/* + the source's own domain
//                if it also hosts /event/ pages)
//   concurrency  parallel fetches (default 6)
//   defaultVenue used when JSON-LD location is missing

const DEFAULT_PATTERN = /https?:\/\/events\.leapevents\.com\/event\/[A-Za-z0-9_-]+/g;

export const leapeventsListAdapter: Adapter = async ({ source }): Promise<AdapterResult> => {
  const cfg = (source.config ?? {}) as {
    linkPattern?: string;
    concurrency?: number;
    defaultVenue?: string;
  };
  const linkRe = cfg.linkPattern ? new RegExp(cfg.linkPattern, "g") : DEFAULT_PATTERN;
  const concurrency = Math.max(1, Math.min(cfg.concurrency ?? 6, 16));

  const listRes = await politeFetch(source.url);
  if (!listRes.ok) {
    return { events: [], warnings: [`HTTP ${listRes.status} fetching ${source.url}`] };
  }
  const listHtml = await listRes.text();

  const urls = Array.from(new Set(listHtml.match(linkRe) ?? []));
  if (urls.length === 0) {
    return {
      events: [],
      warnings: [
        `${source.id}: no event links matched ${linkRe.source} on ${source.url}. Check that the list URL is correct and the platform is still events.leapevents.com.`,
      ],
    };
  }

  const events: EventRecord[] = [];
  const warnings: string[] = [];

  // Run fetches in batches of `concurrency` to be polite.
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (eventUrl) => {
        try {
          const res = await politeFetch(eventUrl);
          if (!res.ok) return { eventUrl, warning: `HTTP ${res.status} fetching ${eventUrl}` };
          const html = await res.text();
          const $ = cheerio.load(html);
          const ldEvents = extractJsonLdEvents($);
          if (ldEvents.length === 0) {
            return { eventUrl, warning: `${source.id}: no JSON-LD Event at ${eventUrl}` };
          }
          return { eventUrl, ldEvents };
        } catch (e) {
          return { eventUrl, warning: `${source.id}: ${(e as Error).message} (${eventUrl})` };
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
        events.push(
          buildEvent(source, {
            naturalKey: ev.identifier ?? r.eventUrl,
            title: ev.name ?? "Untitled",
            description: ev.description,
            url: ev.url ?? r.eventUrl,
            start,
            end: toIsoOrUndefined(ev.endDate),
            location: {
              ...jsonLdLocation(ev.location),
              venue: jsonLdLocation(ev.location).venue ?? cfg.defaultVenue,
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
