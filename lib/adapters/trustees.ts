import * as cheerio from "cheerio";
import type { Adapter, AdapterResult } from "../types";
import { buildEvent, naiveToUtcIso, politeFetch } from "../util";
import { loadRegion } from "../region";

// The Trustees of Reservations runs WordPress with a custom theme. Events are
// rendered server-side as `<article class="teaser-event">` cards. The site
// shows ~6 "featured/current" events per render; deeper pagination is behind
// authenticated FacetWP AJAX. This adapter parses what's on the public list
// page — usually enough since the site curates the list to upcoming events.
//
// Dates on the list cards omit the year ("Monday, May 11"), so we infer the
// nearest future occurrence of (month, day).

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function inferYearMonthDay(text: string): { y: number; m: number; d: number } | null {
  // "Monday, May 11" or "May 11"
  const m = text.match(/(?:[A-Za-z]+,\s+)?([A-Za-z]+)\s+(\d{1,2})(?:,\s+(\d{4}))?/);
  if (!m) return null;
  const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!month) return null;
  const day = parseInt(m[2], 10);
  if (m[3]) return { y: parseInt(m[3], 10), m: month, d: day };

  // Infer the nearest future year.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let y = today.getFullYear();
  const candidate = new Date(y, month - 1, day);
  if (candidate.getTime() < today.getTime()) y++;
  return { y, m: month, d: day };
}

type TrusteesConfig = {
  venueGroupLabel?: string;
};

export const trusteesAdapter: Adapter = async ({
  source,
  regionId,
}): Promise<AdapterResult> => {
  const warnings: string[] = [];
  const tz = (() => {
    try {
      return loadRegion(process.cwd(), regionId).config.timeZone;
    } catch {
      return "America/New_York";
    }
  })();
  const cfg = (source.config ?? {}) as TrusteesConfig;
  const groupLabel = cfg.venueGroupLabel ?? "Trustees";
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

  const events: ReturnType<typeof buildEvent>[] = [];
  const seenLinks = new Set<string>();

  $("article.teaser-event").each((_i, el) => {
    const node = $(el);
    const linkAttr = node.find("a").first().attr("href")?.trim();
    if (!linkAttr) return;
    const url = new URL(linkAttr, source.url).toString();
    if (seenLinks.has(url)) return;
    seenLinks.add(url);

    const title = node.find(".teaser-event__title").first().text().trim();
    const dateText = node.find(".teaser-event__date-row p").first().text().trim();
    const description = node.find(".teaser-event__description").first().text().trim();
    const image = node.find(".teaser-event__image-wrapper img").first().attr("src");
    const locationText = node.find(".teaser-event__location").first().text().trim();

    if (!title || !dateText) return;
    const ymd = inferYearMonthDay(dateText);
    if (!ymd) {
      warnings.push(`Skipped "${title}" — unparseable date "${dateText}"`);
      return;
    }

    // Location format from these cards is "Venue | Town"
    let venue: string | undefined;
    let town: string | undefined;
    if (locationText.includes("|")) {
      const parts = locationText.split("|").map((s) => s.trim()).filter(Boolean);
      venue = parts[0];
      town = parts[1];
    } else if (locationText) {
      town = locationText;
    }

    // All-day event: anchor at noon in the region's timezone so the event
    // unambiguously falls on the intended date in any common viewing zone.
    const naive = `${ymd.y}-${String(ymd.m).padStart(2, "0")}-${String(ymd.d).padStart(2, "0")}T12:00:00`;
    const startIso = naiveToUtcIso(naive, tz);

    events.push(
      buildEvent(source, {
        naturalKey: url,
        title,
        description: description || undefined,
        url,
        start: startIso,
        allDay: true,
        location: {
          venue: venue ? `${venue} (${groupLabel})` : undefined,
          town,
        },
        imageUrl: image || undefined,
      }),
    );
  });

  if (events.length === 0) {
    warnings.push(
      `${source.id}: no teaser-event cards on ${source.url}. Site layout may have changed.`,
    );
  }

  return { events, warnings };
};
