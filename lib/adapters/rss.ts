import Parser from "rss-parser";
import type { Adapter, AdapterResult } from "../types";
import { buildEvent, toIsoOrUndefined } from "../util";

const parser = new Parser({
  headers: {
    "User-Agent":
      "metrowest-events/0.1 (+https://github.com/jbehrens/metrowest-events) - personal aggregator",
  },
});

export const rssAdapter: Adapter = async ({ source }): Promise<AdapterResult> => {
  const warnings: string[] = [];
  let feed;
  try {
    feed = await parser.parseURL(source.url);
  } catch (err) {
    return { events: [], warnings: [`RSS parse failed: ${(err as Error).message}`] };
  }

  const events = (feed.items ?? [])
    .map((item) => {
      const start = toIsoOrUndefined(item.isoDate ?? item.pubDate);
      if (!start) {
        warnings.push(`Skipping RSS item without date: ${item.title ?? item.link}`);
        return null;
      }
      const url = item.link ?? source.url;
      const naturalKey = item.guid ?? item.link ?? `${item.title}::${start}`;
      return buildEvent(source, {
        naturalKey,
        title: item.title ?? "Untitled",
        description: item.contentSnippet ?? item.content,
        url,
        start,
        location: source.town ? { town: source.town } : undefined,
      });
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  return { events, warnings };
};
