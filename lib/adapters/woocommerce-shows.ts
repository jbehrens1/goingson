import * as cheerio from "cheerio";
import type { Adapter, AdapterResult, EventRecord } from "../types";
import { buildEvent, naiveToUtcIso, politeFetch } from "../util";

// Adapter for WooCommerce-based comedy clubs / venues that sell each show
// as a product, with the show date exposed in a `<p class="event-date">`
// or similar element on the category/listing page. Grand Comedy Club
// (Escondido) is the canonical case: /product-category/comedyevents/
// renders 20+ product cards, each with:
//
//   <a href="https://.../product/<slug>/">…</a>
//   <span class="product-title">Erik Griffin -  $17</span>
//   <p class="box-excerpt is-small">7:00 pm $12 – A GRAND NIGHT OF COMEDY…</p>
//   <p class="event-date">Upcoming Shows: 06/25/2026</p>
//
// We extract title + link + date (from p.event-date, stripping the
// "Upcoming Shows:" prefix) + showtime (best-effort from box-excerpt
// prose) + description (the box-excerpt text).
//
// config:
//   itemSelector       default 'li.product, .product, .product-card'
//   titleSelector      default '.product-title, .woocommerce-loop-product__title, h2, h3'
//   linkSelector       default 'a[href*="/product/"]'
//   dateSelector       default 'p.event-date'
//   dateTextPattern    regex to extract MM/DD/YYYY (default extracts first match)
//   descriptionSelector default 'p.box-excerpt'
//   defaultVenue
//   defaultTimeZone    default America/New_York
//   defaultHour        when prose has no time, default 20 (8 PM)

const TIME_RE = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;

function parseTimeFromProse(prose: string, defaultHour = 20): { hour: number; minute: number } {
  // Look for the FIRST time pattern with explicit AM/PM, else first numeric
  const explicitMatch = prose.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  const fallback = !explicitMatch ? prose.match(TIME_RE) : null;
  const m = explicitMatch ?? fallback;
  if (!m) return { hour: defaultHour, minute: 0 };
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = (m[3] ?? "").toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  else if (ampm === "am" && hour === 12) hour = 0;
  else if (!ampm && hour >= 1 && hour <= 11) hour += 12;
  return { hour, minute };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export const woocommerceShowsAdapter: Adapter = async ({ source }): Promise<AdapterResult> => {
  const cfg = (source.config ?? {}) as {
    itemSelector?: string;
    titleSelector?: string;
    linkSelector?: string;
    dateSelector?: string;
    dateTextPattern?: string;
    descriptionSelector?: string;
    defaultVenue?: string;
    defaultTimeZone?: string;
    defaultHour?: number;
  };
  const itemSel = cfg.itemSelector ?? "li.product, .product, .product-card";
  const titleSel =
    cfg.titleSelector ?? ".product-title, .woocommerce-loop-product__title, h2, h3";
  const linkSel = cfg.linkSelector ?? 'a[href*="/product/"]';
  const dateSel = cfg.dateSelector ?? "p.event-date";
  const descSel = cfg.descriptionSelector ?? "p.box-excerpt";
  const dateRe = cfg.dateTextPattern
    ? new RegExp(cfg.dateTextPattern)
    : /(\d{1,2})\/(\d{1,2})\/(\d{4})/;
  const tz = cfg.defaultTimeZone ?? "America/New_York";
  const defaultHour = cfg.defaultHour ?? 20;

  const res = await politeFetch(source.url);
  if (!res.ok) {
    return { events: [], warnings: [`HTTP ${res.status} fetching ${source.url}`] };
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  const items = $(itemSel);
  if (items.length === 0) {
    return {
      events: [],
      warnings: [
        `${source.id}: no items matched ${itemSel} on ${source.url}. The page structure may have changed.`,
      ],
    };
  }

  const events: EventRecord[] = [];
  const warnings: string[] = [];
  const seenUrls = new Set<string>();

  items.each((_i, el) => {
    const $item = $(el);
    const title = $item.find(titleSel).first().text().trim();
    const linkHref = $item.find(linkSel).first().attr("href");
    if (!title || !linkHref) return;
    const url = new URL(linkHref, source.url).toString();
    if (seenUrls.has(url)) return;
    seenUrls.add(url);

    const dateText = $item.find(dateSel).first().text().trim();
    const dm = dateText.match(dateRe);
    if (!dm) {
      warnings.push(`${source.id}: couldn't parse date "${dateText}" for "${title}"`);
      return;
    }
    const month = parseInt(dm[1], 10);
    const day = parseInt(dm[2], 10);
    const year = parseInt(dm[3], 10);
    if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(year)) return;

    const description = $item.find(descSel).first().text().trim();
    const { hour, minute } = parseTimeFromProse(description, defaultHour);

    const naive = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00`;
    const start = naiveToUtcIso(naive, tz);

    events.push(
      buildEvent(source, {
        naturalKey: url,
        title,
        description: description || undefined,
        url,
        start,
        location: cfg.defaultVenue ? { venue: cfg.defaultVenue, town: source.town } : undefined,
      }),
    );
  });

  if (events.length === 0 && warnings.length === 0) {
    warnings.push(`${source.id}: matched ${items.length} items but extracted 0 events`);
  }
  return { events, warnings };
};
