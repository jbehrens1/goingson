import type { Adapter, AdapterResult } from "../types";
import { buildEvent, naiveToUtcIso, politeFetch } from "../util";

// "GeoDirectory" WordPress plugin (geodirectory.com). Exposes a clean REST
// namespace at /wp-json/geodir/v2/events. Each event includes:
//   - start_date.raw / start_time.raw / end_date.raw / end_time.raw
//     (naive local strings — interpret in defaultTimeZone, default America/New_York)
//   - start_datetime.raw / end_datetime.raw — convenience naive ISO
//   - all_day (0|1)
//   - recurring (bool) + event_dates.recurring_dates (string[] of dates)
//   - venue, street, city, region, zip, latitude, longitude
//   - default_category {id,name,slug} + post_category[] {id,name,slug}
//   - featured_image
//
// For recurring events, we expand each date in `recurring_dates` into a
// separate event sharing the same start/end times. For one-offs, we use
// start_datetime directly. Times are wall-clock in the venue's timezone,
// so we run them through naiveToUtcIso() to land on correct UTC.

type GdRendered<T = string> = { raw?: T; rendered?: T } | T | undefined;

type GdCategory = { id?: number; name?: string; slug?: string };

type GdEvent = {
  id: number;
  link: string;
  title: GdRendered;
  content?: GdRendered;
  start_date?: GdRendered;
  end_date?: GdRendered;
  start_time?: GdRendered;
  end_time?: GdRendered;
  start_datetime?: GdRendered;
  end_datetime?: GdRendered;
  all_day?: number | boolean;
  recurring?: boolean;
  event_dates?: {
    recurring?: boolean;
    recurring_dates?: string[];
    start_date?: string;
    end_date?: string;
    start_time?: string;
    end_time?: string;
    all_day?: number | boolean;
  };
  street?: string;
  city?: string;
  region?: string;
  zip?: string;
  venue?: string;
  latitude?: string | number;
  longitude?: string | number;
  default_category?: GdCategory | string | number;
  post_category?: GdCategory[];
  post_tags?: GdCategory[];
  featured_image?: { src?: string; full?: { src?: string } } | unknown[];
};

type WordpressGeodirConfig = {
  /** IANA timezone for the source. Naive times in the REST response are
   *  interpreted as wall-clock in this zone. Defaults to America/New_York. */
  defaultTimeZone?: string;
  /** Optional venue name fallback when an event has no `venue` field. */
  defaultVenue?: string;
  /** Max pages to fetch (100 events/page). Default 12 (~1200 events). */
  maxPages?: number;
};

function getRaw(v: GdRendered): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "object") {
    const o = v as { raw?: string; rendered?: string };
    if (typeof o.raw === "string" && o.raw.trim()) return o.raw.trim();
    if (typeof o.rendered === "string" && o.rendered.trim()) return o.rendered.trim();
  }
  return undefined;
}

function stripHtml(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || undefined;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8217;/g, "’")
    .replace(/&#8220;/g, "“")
    .replace(/&#8221;/g, "”")
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—");
}

function categoryNames(ev: GdEvent): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (n: unknown) => {
    if (typeof n === "string") {
      const k = n.trim();
      if (k && !seen.has(k.toLowerCase())) {
        seen.add(k.toLowerCase());
        out.push(k);
      }
    }
  };
  if (ev.default_category && typeof ev.default_category === "object") {
    push((ev.default_category as GdCategory).name);
  }
  for (const c of ev.post_category ?? []) push(c?.name);
  for (const t of ev.post_tags ?? []) push(t?.name);
  return out;
}

/** Combine a date (YYYY-MM-DD) + optional time (HH:MM) into a naive ISO
 *  string suitable for naiveToUtcIso(). Falls back to midnight when no time. */
function combineDateTime(dateRaw: string | undefined, timeRaw: string | undefined): string | null {
  if (!dateRaw) return null;
  const d = dateRaw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const t = (timeRaw ?? "").trim();
  const hhmm = /^\d{1,2}:\d{2}$/.test(t)
    ? t.length === 4
      ? `0${t}`
      : t
    : "00:00";
  return `${d}T${hhmm}:00`;
}

function imageUrl(ev: GdEvent): string | undefined {
  const fi = ev.featured_image;
  if (!fi || Array.isArray(fi)) return undefined; // [] when missing
  if (typeof fi === "object") {
    const o = fi as { src?: string; full?: { src?: string } };
    return o.full?.src ?? o.src;
  }
  return undefined;
}

export const wordpressGeodirAdapter: Adapter = async ({ source }): Promise<AdapterResult> => {
  const warnings: string[] = [];
  const cfg = (source.config ?? {}) as WordpressGeodirConfig;
  const tz = cfg.defaultTimeZone || "America/New_York";
  const maxPages = Math.max(1, Math.min(20, cfg.maxPages ?? 12));

  const u = new URL(source.url);
  const endpoint = `${u.origin}/wp-json/geodir/v2/events`;

  const events: ReturnType<typeof buildEvent>[] = [];
  let page = 1;
  const perPage = 100;
  const cutoff = Date.now() - 24 * 3600_000; // drop events ending >24h ago

  while (page <= maxPages) {
    const url = `${endpoint}?per_page=${perPage}&page=${page}`;
    const res = await politeFetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      // 400 == past last page on some setups
      if (res.status === 400) break;
      warnings.push(`HTTP ${res.status} fetching ${url}`);
      break;
    }
    let list: GdEvent[];
    try {
      list = (await res.json()) as GdEvent[];
    } catch (err) {
      warnings.push(`JSON parse failed for ${url}: ${(err as Error).message}`);
      break;
    }
    if (!Array.isArray(list) || list.length === 0) break;

    for (const ev of list) {
      const titleRaw = stripHtml(getRaw(ev.title)) ?? "Untitled";
      const title = decodeEntities(titleRaw);
      const description = decodeEntities(stripHtml(getRaw(ev.content)) ?? "");
      const dateStartRaw = getRaw(ev.start_date) ?? ev.event_dates?.start_date;
      const dateEndRaw = getRaw(ev.end_date) ?? ev.event_dates?.end_date ?? dateStartRaw;
      const timeStartRaw = getRaw(ev.start_time) ?? ev.event_dates?.start_time;
      const timeEndRaw = getRaw(ev.end_time) ?? ev.event_dates?.end_time;
      const allDay = !!ev.all_day || !!ev.event_dates?.all_day;

      const venue =
        (ev.venue && String(ev.venue).trim()) ||
        cfg.defaultVenue ||
        undefined;
      const town = ev.city?.trim() || source.town;
      const address = [ev.street, ev.city, ev.region, ev.zip].filter(Boolean).join(", ");
      const lat =
        typeof ev.latitude === "string" ? parseFloat(ev.latitude) : ev.latitude;
      const lon =
        typeof ev.longitude === "string" ? parseFloat(ev.longitude) : ev.longitude;
      const cats = categoryNames(ev);
      const image = imageUrl(ev);

      // Each occurrence (one-off OR each entry in recurring_dates) becomes its
      // own EventRecord with a unique naturalKey.
      const dates: string[] = [];
      const rdates = ev.event_dates?.recurring_dates;
      if (ev.recurring && Array.isArray(rdates) && rdates.length > 0) {
        for (const d of rdates) {
          if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) dates.push(d);
        }
      } else if (dateStartRaw) {
        dates.push(dateStartRaw);
      }

      if (dates.length === 0) {
        warnings.push(`Skipped ${ev.id} (${title}) — no resolvable date`);
        continue;
      }

      for (const d of dates) {
        const naiveStart = combineDateTime(d, allDay ? undefined : timeStartRaw);
        if (!naiveStart) continue;
        const startIso = naiveToUtcIso(naiveStart, tz);
        const endNaive = combineDateTime(
          // If recurring, assume same-day end; else honor dateEndRaw when set.
          ev.recurring ? d : dateEndRaw ?? d,
          allDay ? undefined : timeEndRaw,
        );
        const endIso = endNaive ? naiveToUtcIso(endNaive, tz) : undefined;

        // Drop entries whose end (or start if no end) is >24h in the past.
        const refIso = endIso ?? startIso;
        if (new Date(refIso).getTime() < cutoff) continue;

        events.push(
          buildEvent(source, {
            naturalKey: `${ev.id}::${d}`,
            title,
            description: description || undefined,
            url: ev.link,
            start: startIso,
            end: endIso,
            allDay,
            location: {
              venue,
              town,
              address: address || undefined,
              lat: typeof lat === "number" && !Number.isNaN(lat) ? lat : undefined,
              lon: typeof lon === "number" && !Number.isNaN(lon) ? lon : undefined,
            },
            imageUrl: image,
            categories: cats.length ? cats : undefined,
          }),
        );
      }
    }

    if (list.length < perPage) break;
    page++;
  }

  if (page > maxPages) {
    warnings.push(`Stopped after ${maxPages} pages — more events may exist.`);
  }

  return { events, warnings };
};
