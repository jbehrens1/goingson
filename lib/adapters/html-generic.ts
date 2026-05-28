import * as cheerio from "cheerio";
import type { Adapter, AdapterResult } from "../types";
import { buildEvent, fetchSourceHtml, toIsoOrUndefined } from "../util";
import { extractJsonLdEvents, jsonLdImageUrl, jsonLdLocation } from "./jsonld";

type HtmlGenericConfig = {
  selectors?: {
    item?: string;
    title?: string;
    link?: string;
    start?: string;
    startAttr?: string;
    end?: string;
    endAttr?: string;
    description?: string;
    image?: string;
    imageAttr?: string;
  };
};

export const htmlGenericAdapter: Adapter = async ({ source }): Promise<AdapterResult> => {
  const warnings: string[] = [];
  const { html, status, viaHeadless } = await fetchSourceHtml(source.url, source);
  if (!html) {
    return {
      events: [],
      warnings: [`HTTP ${status ?? "?"} fetching ${source.url}`],
    };
  }
  if (viaHeadless) {
    warnings.push(`Fetched via headless browser (Browserless).`);
  }
  const $ = cheerio.load(html);

  const ldEvents = extractJsonLdEvents($);
  if (ldEvents.length > 0) {
    const events = ldEvents
      .map((ev) => {
        const start = toIsoOrUndefined(ev.startDate);
        if (!start) return null;
        const url = ev.url ?? source.url;
        const naturalKey = ev.identifier ?? `${ev.name}::${start}`;
        return buildEvent(source, {
          naturalKey,
          title: ev.name ?? "Untitled",
          description: ev.description,
          url,
          start,
          end: toIsoOrUndefined(ev.endDate),
          location: { ...jsonLdLocation(ev.location), town: source.town },
          imageUrl: jsonLdImageUrl(ev.image),
        });
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);
    return { events, warnings };
  }

  const cfg = (source.config ?? {}) as HtmlGenericConfig;
  const sel = cfg.selectors;
  if (!sel?.item || !sel.title || !sel.start) {
    return {
      events: [],
      warnings: [
        `${source.id}: no JSON-LD found and no CSS selectors configured. Add config.selectors {item,title,link,start,...} or switch adapter.`,
      ],
    };
  }

  const events: ReturnType<typeof buildEvent>[] = [];
  $(sel.item).each((_i, el) => {
    const node = $(el);
    const title = node.find(sel.title!).first().text().trim();
    const linkEl = sel.link ? node.find(sel.link).first() : node.find("a").first();
    const url = new URL(linkEl.attr("href") ?? "", source.url).toString();
    const startEl = node.find(sel.start!).first();
    const startRaw = sel.startAttr ? startEl.attr(sel.startAttr) : startEl.text().trim();
    const start = toIsoOrUndefined(startRaw);
    if (!title || !start) return;
    const description = sel.description ? node.find(sel.description).first().text().trim() : undefined;
    let imageUrl: string | undefined;
    if (sel.image) {
      const imgEl = node.find(sel.image).first();
      imageUrl = sel.imageAttr ? imgEl.attr(sel.imageAttr) : imgEl.attr("src");
    }
    let end: string | undefined;
    if (sel.end) {
      const endEl = node.find(sel.end).first();
      end = toIsoOrUndefined(sel.endAttr ? endEl.attr(sel.endAttr) : endEl.text().trim());
    }
    events.push(
      buildEvent(source, {
        naturalKey: url,
        title,
        description,
        url,
        start,
        end,
        location: source.town ? { town: source.town } : undefined,
        imageUrl,
      }),
    );
  });

  if (events.length === 0) {
    warnings.push(`${source.id}: selectors matched 0 events on ${source.url}.`);
  }
  return { events, warnings };
};
