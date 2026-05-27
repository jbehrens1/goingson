// Add-to-calendar URL builders for Google, Outlook (live & 365), Yahoo, and
// an Apple-friendly .ics data URL. All pure functions — no fetch, no DOM —
// so they can be shared by client components and (potentially) email
// templates or share-link routes.

import type { EventRecord } from "./types";

/** Detect URLs that point at a raw .ics file or a Google iCal feed.
 *  These are useless as a click-through for end users (browsers will either
 *  download the file or open a calendar app), so we treat them as
 *  "no description URL" and route the title link to the add-to-calendar
 *  widget instead. */
export function isIcsUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  return (
    /\.ics(?:\?|$)/i.test(url) ||
    /\/ical\//i.test(url) ||
    /^https?:\/\/calendar\.google\.com\/calendar\/(ical|embed)\b/i.test(url)
  );
}

// --- Internal helpers --------------------------------------------------------

/** Convert an ISO string to YYYYMMDDTHHMMSSZ (UTC, basic format) — the
 *  format Google/Yahoo expect. For all-day, return YYYYMMDD. */
function toCompactUtc(iso: string, allDay: boolean): string {
  if (allDay) {
    // Date-only: take the YYYY-MM-DD part, strip dashes.
    return iso.slice(0, 10).replace(/-/g, "");
  }
  const d = new Date(iso);
  // toISOString gives "2026-07-03T19:00:00.000Z" — strip punctuation + ms.
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Derive an end-time ISO. Use the event's `end` when present, otherwise
 *  default to start+1h for timed events or start+1d for all-day. */
function deriveEnd(ev: EventRecord): string {
  if (ev.end) return ev.end;
  const start = new Date(ev.start);
  const ms = ev.allDay ? 86_400_000 : 3_600_000;
  return new Date(start.getTime() + ms).toISOString();
}

/** Friendly location string from EventRecord.location. */
function formatLocation(ev: EventRecord): string {
  const loc = ev.location;
  if (!loc) return "";
  const parts = [loc.venue, loc.address, loc.town].filter(Boolean);
  return parts.join(", ");
}

/** Strip HTML tags + decode the handful of entities that show up most
 *  often in our description field (the upstream feeds frequently embed
 *  partly-escaped HTML). Calendar widgets render plain text.
 *  Order matters: decode entities FIRST so that escaped tags like
 *  `&lt;p&gt;` become `<p>` and get stripped by the next pass. */
function plainDescription(ev: EventRecord): string {
  const raw = ev.description ?? "";
  return raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&hellip;/g, "…")
    .replace(/&#x?[0-9a-f]+;/gi, "") // remaining numeric entities
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Per-provider URL builders ----------------------------------------------

/** Google Calendar "Add event" deep link. */
export function googleCalendarUrl(ev: EventRecord): string {
  const start = toCompactUtc(ev.start, !!ev.allDay);
  const end = toCompactUtc(deriveEnd(ev), !!ev.allDay);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: ev.title,
    dates: `${start}/${end}`,
    details: plainDescription(ev) + (ev.url && !isIcsUrl(ev.url) ? `\n\n${ev.url}` : ""),
    location: formatLocation(ev),
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** Outlook (live.com — consumer) compose link. Uses ISO-8601 timestamps
 *  with timezone offset — Outlook is picky about the format. */
function outlookComposeUrl(host: string, ev: EventRecord): string {
  const params = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    startdt: ev.start,
    enddt: deriveEnd(ev),
    subject: ev.title,
    body: plainDescription(ev) + (ev.url && !isIcsUrl(ev.url) ? `\n\n${ev.url}` : ""),
    location: formatLocation(ev),
    ...(ev.allDay ? { allday: "true" } : {}),
  });
  return `https://${host}/calendar/0/deeplink/compose?${params.toString()}`;
}
export function outlookLiveUrl(ev: EventRecord): string {
  return outlookComposeUrl("outlook.live.com", ev);
}
export function office365Url(ev: EventRecord): string {
  return outlookComposeUrl("outlook.office.com", ev);
}

/** Yahoo Calendar add link. */
export function yahooCalendarUrl(ev: EventRecord): string {
  const start = toCompactUtc(ev.start, !!ev.allDay);
  const end = toCompactUtc(deriveEnd(ev), !!ev.allDay);
  const params = new URLSearchParams({
    v: "60",
    title: ev.title,
    st: start,
    et: end,
    desc: plainDescription(ev) + (ev.url && !isIcsUrl(ev.url) ? `\n\n${ev.url}` : ""),
    in_loc: formatLocation(ev),
  });
  return `https://calendar.yahoo.com/?${params.toString()}`;
}

/** Build a minimal RFC 5545 VCALENDAR/VEVENT and return it as a data URL
 *  the browser will download (Apple Calendar / Outlook desktop / Thunderbird
 *  / any iCal-aware app will open it). */
export function icsDataUrl(ev: EventRecord): string {
  const dtStamp = toCompactUtc(new Date().toISOString(), false);
  const dtStart = toCompactUtc(ev.start, !!ev.allDay);
  const dtEnd = toCompactUtc(deriveEnd(ev), !!ev.allDay);
  const dateTag = ev.allDay ? ";VALUE=DATE" : "";
  const escape = (s: string) =>
    s
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/,/g, "\\,")
      .replace(/;/g, "\\;");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Goings On//goingson.co//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${ev.id}@goingson.co`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART${dateTag}:${dtStart}`,
    `DTEND${dateTag}:${dtEnd}`,
    `SUMMARY:${escape(ev.title)}`,
    plainDescription(ev) ? `DESCRIPTION:${escape(plainDescription(ev))}` : "",
    formatLocation(ev) ? `LOCATION:${escape(formatLocation(ev))}` : "",
    ev.url && !isIcsUrl(ev.url) ? `URL:${ev.url}` : "",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);
  // RFC 5545 says CRLF line endings.
  const body = lines.join("\r\n");
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(body)}`;
}

/** A filename hint browsers can use when downloading the .ics. */
export function icsFileName(ev: EventRecord): string {
  const slug = ev.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "event"}.ics`;
}
