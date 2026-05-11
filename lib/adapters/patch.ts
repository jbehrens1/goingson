import * as cheerio from "cheerio";
import type { Adapter, AdapterResult, EventRecord } from "../types";
import { buildEvent, politeFetch, toIsoOrUndefined } from "../util";

type PatchEvent = {
  id: string;
  title?: string;
  summary?: string;
  body?: string;
  displayDate?: string;
  canonicalUrl?: string;
  itemAlias?: string;
  ogImageUrl?: string;
  address?: {
    name?: string;
    streetAddress?: string;
    city?: string;
    region?: string;
    postalCode?: string;
  };
};

type NextData = {
  props?: {
    pageProps?: {
      mainContent?: {
        allEvents?: Record<string, PatchEvent[]>;
        promotedEvents?: Record<string, PatchEvent[]> | PatchEvent[];
      };
    };
  };
};

function stripHtml(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function flattenEvents(
  bucket: Record<string, PatchEvent[]> | PatchEvent[] | undefined,
): PatchEvent[] {
  if (!bucket) return [];
  if (Array.isArray(bucket)) return bucket;
  return Object.values(bucket).flat();
}

export const patchAdapter: Adapter = async ({ source }): Promise<AdapterResult> => {
  const warnings: string[] = [];
  const res = await politeFetch(source.url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    },
  });
  if (!res.ok) {
    return { events: [], warnings: [`HTTP ${res.status} fetching ${source.url}`] };
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  const raw = $('script#__NEXT_DATA__').first().text().trim();
  if (!raw) {
    return {
      events: [],
      warnings: [
        `${source.id}: no __NEXT_DATA__ on ${source.url}. Patch may have changed layout.`,
      ],
    };
  }

  let next: NextData;
  try {
    next = JSON.parse(raw) as NextData;
  } catch (err) {
    return { events: [], warnings: [`${source.id}: __NEXT_DATA__ JSON parse failed: ${(err as Error).message}`] };
  }

  const main = next.props?.pageProps?.mainContent;
  const all = [...flattenEvents(main?.allEvents), ...flattenEvents(main?.promotedEvents)];

  if (all.length === 0) {
    warnings.push(`${source.id}: no events found in __NEXT_DATA__.`);
  }

  const seen = new Set<string>();
  const events: EventRecord[] = [];
  for (const ev of all) {
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);

    const start = toIsoOrUndefined(ev.displayDate);
    if (!start) continue;
    const slug = ev.canonicalUrl ?? ev.itemAlias;
    const url = slug ? new URL(slug, "https://patch.com").toString() : source.url;
    const description = stripHtml(ev.summary) ?? stripHtml(ev.body);
    const venue = ev.address?.name?.trim() || undefined;
    const town = ev.address?.city?.trim() || source.town;
    const address = ev.address
      ? [ev.address.streetAddress, ev.address.city, ev.address.region]
          .filter(Boolean)
          .join(", ")
      : undefined;

    events.push(
      buildEvent(source, {
        naturalKey: ev.id,
        title: ev.title ?? "Untitled",
        description,
        url,
        start,
        location: { venue, town, address: address || undefined },
        imageUrl: ev.ogImageUrl,
      }),
    );
  }

  return { events, warnings };
};
