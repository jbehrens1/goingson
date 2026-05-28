import type { Adapter, AdapterResult, EventRecord } from "../types";
import { buildEvent, naiveToUtcIso, politeFetch } from "../util";

// Adapter for Shopify-hosted comedy clubs / event venues that expose their
// shows as products in a collection. American Comedy Co. (Gaslamp, SD) is
// the canonical case: each show is a product like "Jamie Kennedy LIVE!
// [THU]" in the /collections/shows collection, with the show date+time
// described in plain prose inside body_html.
//
// Strategy: fetch /collections/<handle>/products.json (Shopify exposes
// this publicly on every store, up to 250 products per request), then
// extract the show date+time from a regex over body_html and title.
//
// Date patterns we try, in order (all case-insensitive):
//   "SHOWTIME: Thursday, June 25 @ 8:00 (doors open @ 7:15)"
//   "Thursday, June 25 @ 8:00"
//   "June 25 @ 8:00 PM"
//   "June 25, 2026 @ 8:00 PM"
//   "June 25 at 8 PM"
//
// config:
//   collectionHandle  default "shows"
//   defaultVenue      e.g. "American Comedy Co."
//   defaultTimeZone   IANA tz, default America/New_York
//   limit             products per page, default 250 (Shopify max)

const MONTH_MAP: Record<string, number> = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sept: 8, sep: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

type ShopifyProduct = {
  id: number;
  title: string;
  handle: string;
  body_html: string;
  published_at?: string;
  updated_at?: string;
  vendor?: string;
  product_type?: string;
  tags?: string[];
  images?: Array<{ src: string }>;
};

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function parseShowDateTime(
  haystack: string,
  now: Date,
): { year: number; month: number; day: number; hour: number; minute: number } | undefined {
  // Try "Month Day, Year @ H[:MM] AM/PM" first (most explicit)
  let m = haystack.match(
    /(january|february|march|april|may|june|july|august|september|sept|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?\s*(?:@|at)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i,
  );
  if (m) {
    const month = MONTH_MAP[m[1].toLowerCase()];
    const day = parseInt(m[2], 10);
    const year = m[3] ? parseInt(m[3], 10) : inferYear(now, month, day);
    let hour = parseInt(m[4], 10);
    const minute = m[5] ? parseInt(m[5], 10) : 0;
    const ampm = (m[6] ?? "").toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    else if (ampm === "am" && hour === 12) hour = 0;
    // No AM/PM and hour 1-11 → assume evening show (PM)
    else if (!ampm && hour >= 1 && hour <= 11) hour += 12;
    return { year, month, day, hour, minute };
  }
  // Try "Day, Month Date @ H[:MM]" (e.g. "Thursday, June 25 @ 8:00")
  m = haystack.match(
    /(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+(january|february|march|april|may|june|july|august|september|sept|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\s*(?:@|at)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i,
  );
  if (m) {
    const month = MONTH_MAP[m[1].toLowerCase()];
    const day = parseInt(m[2], 10);
    const year = inferYear(now, month, day);
    let hour = parseInt(m[3], 10);
    const minute = m[4] ? parseInt(m[4], 10) : 0;
    const ampm = (m[5] ?? "").toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    else if (ampm === "am" && hour === 12) hour = 0;
    else if (!ampm && hour >= 1 && hour <= 11) hour += 12;
    return { year, month, day, hour, minute };
  }
  return undefined;
}

function inferYear(now: Date, month: number, day: number): number {
  let year = now.getFullYear();
  const candidate = new Date(year, month, day, 12, 0, 0);
  const daysPast = (now.getTime() - candidate.getTime()) / 86_400_000;
  if (daysPast > 30) year += 1;
  return year;
}

function naiveString(d: { year: number; month: number; day: number; hour: number; minute: number }): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.year}-${pad(d.month + 1)}-${pad(d.day)}T${pad(d.hour)}:${pad(d.minute)}:00`;
}

export const shopifyProductsAdapter: Adapter = async ({ source }): Promise<AdapterResult> => {
  const cfg = (source.config ?? {}) as {
    collectionHandle?: string;
    defaultVenue?: string;
    defaultTimeZone?: string;
    limit?: number;
  };
  const handle = cfg.collectionHandle ?? "shows";
  const tz = cfg.defaultTimeZone ?? "America/New_York";
  const limit = Math.max(1, Math.min(cfg.limit ?? 250, 250));

  // Normalize the base URL — strip any trailing /collections/* path
  const base = source.url.replace(/\/+$/, "").replace(/\/collections\/.*$/, "");
  const apiUrl = `${base}/collections/${handle}/products.json?limit=${limit}`;

  const res = await politeFetch(apiUrl);
  if (!res.ok) {
    return { events: [], warnings: [`HTTP ${res.status} fetching ${apiUrl}`] };
  }
  let data: { products: ShopifyProduct[] };
  try {
    data = (await res.json()) as { products: ShopifyProduct[] };
  } catch (e) {
    return { events: [], warnings: [`${source.id}: failed to parse Shopify JSON: ${(e as Error).message}`] };
  }
  const products = data.products ?? [];
  if (products.length === 0) {
    return { events: [], warnings: [`${source.id}: Shopify collection ${handle} returned 0 products`] };
  }

  const events: EventRecord[] = [];
  const warnings: string[] = [];
  const now = new Date();

  for (const p of products) {
    const titleText = p.title ?? "";
    const bodyText = stripHtml(p.body_html ?? "");
    const haystack = `${titleText}\n${bodyText}`;
    const parsed = parseShowDateTime(haystack, now);
    if (!parsed) {
      warnings.push(`${source.id}: couldn't parse show date for "${titleText}"`);
      continue;
    }
    const start = naiveToUtcIso(naiveString(parsed), tz);
    const productUrl = `${base}/products/${p.handle}`;
    events.push(
      buildEvent(source, {
        naturalKey: productUrl,
        title: titleText.replace(/\s*\[[^\]]+\]\s*$/, "").trim() || titleText,
        description: bodyText.slice(0, 500),
        url: productUrl,
        start,
        location: cfg.defaultVenue ? { venue: cfg.defaultVenue, town: source.town } : undefined,
        imageUrl: p.images?.[0]?.src,
      }),
    );
  }

  return { events, warnings };
};
