import * as cheerio from "cheerio";
import type { Adapter, AdapterResult, EventRecord } from "../types";
import { buildEvent, naiveToUtcIso, politeFetch } from "../util";

// Adapter for venues using the See Tickets WordPress plugin
// (V35.3.x+). Pappy & Harriet's, Coyote Joe's, and a handful of other
// independent music venues embed the same `.seetickets-list-event-container`
// markup on their /calendar/ (or /shows/) page. Markup shape per event:
//
//   <div class="mdc-card seetickets-list-event-container" data-listtype="list">
//     <div class="seetickets-list-view-event-image-container">
//       <a href="https://wl.seetickets.us/event/<slug>/<id>?afflky=..."><img></a>
//     </div>
//     <div class="seetickets-list-event-content-container">
//       <div class="event-info-block">
//         <p class="header">(((folkYEAH!))) Presents:</p>           (optional)
//         <p class="title"><a href="...">Dummy // Locust</a></p>
//         <p class="subtitle">Harmony Index</p>                     (optional)
//         <p class="supporting-talent">Supporting Talent: …</p>     (optional)
//         <p class="date">Thu May 28</p>                            <-- no year!
//         <p class="headliners">Locust, Dummy</p>
//         <p class="doortime-showtime">
//           Doors at <span class="see-doortime">8:00PM</span> /
//           Show at <span class="see-showtime">9:00PM</span>
//         </p>
//         <p class="venue">at Pappy &#038; Harriet's</p>
//         <p><span class="ages">All Ages</span>, <span class="price">$23.00-$27.00</span></p>
//         <p class="genre">Rock</p>
//       </div>
//     </div>
//   </div>
//
// Quirks the adapter handles:
//   • The date string has no year ("Thu May 28"). Infer current year; if the
//     parsed date is more than a month in the past, roll to next year (so
//     "Feb 14" seen in November means next February).
//   • Show time is in a sibling <span class="see-showtime">; if missing fall
//     back to the door time.
//   • Times are wall-clock local to the region's tz — convert via
//     naiveToUtcIso so day-grouping is correct.
//   • Title link is to wl.seetickets.us (the ticket page) — keep that since
//     it's a real product-info page, not a raw .ics file.

const MONTH_MAP: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Parse a "Thu May 28" / "May 28" / "Thursday, May 28" / "May 28, 2026"
 *  string into a {year, month, day} triple. Year is inferred when missing. */
function parseFlexibleDate(s: string, now: Date): { year: number; month: number; day: number } | undefined {
  const text = s.trim().replace(/^[A-Za-z]+,?\s+/, ""); // strip weekday prefix
  // Try "May 28, 2026" first
  const fullMatch = text.match(/^([A-Za-z]+)\s+(\d{1,2})(?:,\s*(\d{4}))?/);
  if (!fullMatch) return undefined;
  const monthName = fullMatch[1].slice(0, 3).toLowerCase();
  const month = MONTH_MAP[monthName];
  if (month === undefined) return undefined;
  const day = parseInt(fullMatch[2], 10);
  if (!Number.isFinite(day) || day < 1 || day > 31) return undefined;
  if (fullMatch[3]) return { year: parseInt(fullMatch[3], 10), month, day };
  // No year — infer from `now`. If the resulting date is more than ~30 days
  // in the past, assume the venue means next year (e.g. they're listing
  // shows for the upcoming season).
  let year = now.getFullYear();
  const candidate = new Date(year, month, day, 12, 0, 0);
  const daysPast = (now.getTime() - candidate.getTime()) / 86_400_000;
  if (daysPast > 30) year += 1;
  return { year, month, day };
}

/** Parse "8:00PM" / "9:30AM" / "10:15 pm" → {hours: 0-23, minutes: 0-59} */
function parseTime(s: string | undefined): { hours: number; minutes: number } | undefined {
  if (!s) return undefined;
  const m = s.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([APap][Mm])$/);
  if (!m) return undefined;
  let hours = parseInt(m[1], 10);
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  const isPM = m[3].toLowerCase() === "pm";
  if (hours === 12 && !isPM) hours = 0;
  else if (hours !== 12 && isPM) hours += 12;
  return { hours, minutes };
}

/** Build "YYYY-MM-DDTHH:MM:SS" naive-local string for naiveToUtcIso. */
function naiveString(date: { year: number; month: number; day: number }, time?: { hours: number; minutes: number }): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const t = time ?? { hours: 20, minutes: 0 }; // default 8 PM for music venues
  return `${date.year}-${pad(date.month + 1)}-${pad(date.day)}T${pad(t.hours)}:${pad(t.minutes)}:00`;
}

export const seeticketsListAdapter: Adapter = async (ctx): Promise<AdapterResult> => {
  const cfg = (ctx.source.config ?? {}) as {
    defaultVenue?: string;
    /** IANA timezone (e.g. "America/Los_Angeles"). Defaults to America/New_York. */
    defaultTimeZone?: string;
    /** Override the year-inference cutoff (days in past before assuming next year). */
    yearRolloverDays?: number;
  };
  const tz = cfg.defaultTimeZone ?? "America/New_York";

  const res = await politeFetch(ctx.source.url);
  if (!res.ok) {
    return {
      events: [],
      warnings: [`${ctx.source.id}: HTTP ${res.status} from ${ctx.source.url}`],
    };
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  const now = new Date();
  const cards = $(".seetickets-list-event-container");
  if (cards.length === 0) {
    return {
      events: [],
      warnings: [
        `${ctx.source.id}: no .seetickets-list-event-container blocks found. Page may have changed or the See Tickets plugin moved (try /calendar/, /shows/, /events/).`,
      ],
    };
  }

  const events: EventRecord[] = [];
  const warnings: string[] = [];

  cards.each((_, el) => {
    const $card = $(el);
    const $info = $card.find(".event-info-block");
    if ($info.length === 0) return;

    const title = $info.find("p.title a").first().text().trim()
      || $info.find("p.title").first().text().trim();
    const ticketUrl = $info.find("p.title a").first().attr("href")
      || $card.find(".seetickets-list-view-event-image-container a").first().attr("href");
    if (!title || !ticketUrl) return;

    const rawDate = $info.find("p.date").first().text().trim();
    const date = parseFlexibleDate(rawDate, now);
    if (!date) {
      warnings.push(`${ctx.source.id}: couldn't parse date "${rawDate}" for "${title}"`);
      return;
    }

    // Prefer showtime; fall back to doortime; fall back to default (8 PM).
    const showTime = parseTime($info.find(".see-showtime").first().text())
      || parseTime($info.find(".see-doortime").first().text());

    const startNaive = naiveString(date, showTime);
    const start = naiveToUtcIso(startNaive, tz);

    // Compose description from optional sub-fields the plugin renders.
    const header = $info.find("p.header").first().text().trim();
    const subtitle = $info.find("p.subtitle").first().text().trim();
    const supporting = $info.find("p.supporting-talent").first().text().trim();
    const genre = $info.find("p.genre").first().text().trim();
    const ages = $info.find("span.ages").first().text().trim();
    const price = $info.find("span.price").first().text().trim();
    const descLines = [header, subtitle, supporting, genre, [ages, price].filter(Boolean).join(" · ")]
      .map((s) => s.trim())
      .filter(Boolean);
    const description = descLines.length ? descLines.join("\n") : undefined;

    // Venue is "at Pappy & Harriet's" — strip the "at " prefix.
    const venueRaw = $info.find("p.venue").first().text().trim();
    const venue = venueRaw.replace(/^at\s+/i, "") || cfg.defaultVenue;

    events.push(
      buildEvent(ctx.source, {
        naturalKey: ticketUrl, // unique per ticket page
        title,
        description,
        url: ticketUrl,
        start,
        allDay: false,
        location: venue ? { venue } : undefined,
      }),
    );
  });

  return { events, warnings };
};
