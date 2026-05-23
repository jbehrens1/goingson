import type { Adapter, AdapterResult } from "../types";
import { buildEvent, naiveToUtcIso, politeFetch } from "../util";

// "Modern Events Calendar" (MEC) WordPress plugin exposes events at
// /wp-json/wp/v2/mec-events. Unlike Tribe, MEC doesn't include a structured
// start_date in the WP REST envelope — the event date is embedded as freeform
// text in `content.rendered` like "Thursday, June 25 | 6:00-7:00 p.m.".
// This adapter parses that pattern and infers the year.

type MecEvent = {
  id: number;
  slug: string;
  link: string;
  status?: string;
  title: { rendered: string };
  content?: { rendered?: string };
  excerpt?: { rendered?: string };
  featured_img?: string | { url?: string };
};

type WordpressMecConfig = {
  defaultVenue?: string;
  defaultTimeZone?: string;
  maxPages?: number;
};

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

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
    .replace(/&#8221;/g, "”");
}

function inferYearMonthDay(text: string): { y: number; m: number; d: number } | null {
  // 1) Day-of-week + month + day, optional year: "Thursday, June 25, 2026" or "Thursday, June 25"
  const re =
    /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+([A-Za-z]{3,9})\s+(\d{1,2})(?:,?\s+(\d{4}))?/i;
  const m = text.match(re);
  if (m) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (!month) return null;
    const day = parseInt(m[2], 10);
    const year = m[3] ? parseInt(m[3], 10) : pickFutureYear(month, day);
    return { y: year, m: month, d: day };
  }
  // 2) "Month DD, YYYY" or "Month DD"
  const re2 = /\b([A-Za-z]{3,9})\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/;
  const m2 = text.match(re2);
  if (m2 && MONTHS[m2[1].slice(0, 3).toLowerCase()]) {
    const month = MONTHS[m2[1].slice(0, 3).toLowerCase()];
    const day = parseInt(m2[2], 10);
    const year = m2[3] ? parseInt(m2[3], 10) : pickFutureYear(month, day);
    return { y: year, m: month, d: day };
  }
  return null;
}

function pickFutureYear(month: number, day: number): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const y = today.getFullYear();
  const candidate = new Date(y, month - 1, day);
  return candidate.getTime() < today.getTime() ? y + 1 : y;
}

function parseTime(text: string | undefined): { hour: number; minute: number } | null {
  if (!text) return null;
  const m = text.match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3].toLowerCase().replace(/\./g, "");
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  return { hour: h, minute: min };
}

export const wordpressMecAdapter: Adapter = async ({ source }): Promise<AdapterResult> => {
  const warnings: string[] = [];
  const u = new URL(source.url);
  const endpoint = `${u.origin}/wp-json/wp/v2/mec-events`;
  const cfg = (source.config ?? {}) as WordpressMecConfig;
  const tz = cfg.defaultTimeZone || "America/New_York";

  const events: ReturnType<typeof buildEvent>[] = [];
  const perPage = 100;
  const maxPages = cfg.maxPages ?? 3;
  let page = 1;
  const now = Date.now();
  const cutoff = now - 12 * 3600_000;

  while (page <= maxPages) {
    const url = `${endpoint}?per_page=${perPage}&page=${page}&orderby=date&order=desc`;
    const res = await politeFetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      if (res.status === 400) break; // past end
      return { events, warnings: [...warnings, `HTTP ${res.status} fetching ${url}`] };
    }
    const list = (await res.json()) as MecEvent[];
    if (!Array.isArray(list) || list.length === 0) break;

    let pastInPage = 0;
    for (const ev of list) {
      const title = decodeEntities(stripHtml(ev.title?.rendered) ?? "Untitled");
      const contentText = stripHtml(ev.content?.rendered) ?? "";
      const excerpt = stripHtml(ev.excerpt?.rendered);
      const haystack = `${contentText} ${excerpt ?? ""}`;

      const ymd = inferYearMonthDay(haystack);
      if (!ymd) {
        warnings.push(`Skipped "${title}" — no parseable date in content/excerpt`);
        continue;
      }
      const time = parseTime(haystack);
      const naive = `${ymd.y}-${String(ymd.m).padStart(2, "0")}-${String(ymd.d).padStart(2, "0")}T${
        time ? `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}` : "00:00"
      }:00`;
      const startIso = naiveToUtcIso(naive, tz);

      if (new Date(startIso).getTime() < cutoff) {
        pastInPage++;
        continue;
      }

      const image =
        typeof ev.featured_img === "string"
          ? ev.featured_img
          : (ev.featured_img && typeof ev.featured_img === "object"
              ? ev.featured_img.url
              : undefined);

      events.push(
        buildEvent(source, {
          naturalKey: String(ev.id),
          title,
          description: excerpt,
          url: ev.link,
          start: startIso,
          allDay: !time,
          location: {
            venue: cfg.defaultVenue,
            town: source.town,
          },
          imageUrl: image,
        }),
      );
    }

    // The REST orders by post date desc — once we're past the cutoff we can stop.
    if (pastInPage === list.length) break;
    if (list.length < perPage) break;
    page++;
  }

  return { events, warnings };
};
