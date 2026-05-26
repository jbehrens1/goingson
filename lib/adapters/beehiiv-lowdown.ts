import type { Adapter, AdapterResult } from "../types";
import { buildEvent, naiveToUtcIso, politeFetch } from "../util";

// Parses LBI Lowdown's weekly Beehiiv newsletter ("this week on LBI: M/D/YY").
// Each post follows a tightly-structured template:
//
//   🗓️ Things to Do
//   <emoji> <Title>
//   <Venue> | <Town>
//   <Day>, <Mon> <Day><ord> | <Time>[ | More Info]
//   [optional second day line for multi-day events]
//   <emoji> <Title>
//   ...
//
//   👪️ Family Fun
//   ...same triplets
//
//   🎶 Live Music & Entertainment   ← skipped (we already aggregate live music
//                                     from venue ical/REST sources + SandPaper)
//
// Strategy: pull the most recent "/p/this-week-on-lbi-*" post from sitemap.xml,
// strip HTML, then split each section by emoji-anchored event chunks. Each
// chunk parses into one or more occurrences (some events span two days).

type LowdownConfig = {
  defaultTimeZone?: string;
  /** Max number of past sitemap posts to consider. Default 4. */
  maxPosts?: number;
};

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const SECTION_MARKERS = {
  thingsToDo: "Things to Do",
  familyFun: "Family Fun",
  liveMusic: "Live Music",
};

// Any printable emoji range used as event marker. Each event in the source
// starts with an emoji that doubles as an icon for the activity type.
// Use a broad class so we catch them all (kite, beer, plant, etc.).
const EMOJI_PREFIX_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27FF}\u{2300}-\u{23FF}][️]?/u;

/** Strip HTML but preserve <br> and <p> as newlines so we can use the
 *  newsletter's per-event line structure (title / venue|town / date|time) as
 *  parsing anchors. Without this, splitting "title venue | town date" into
 *  its parts is ambiguous. */
function stripHtmlPreservingLines(html: string): string {
  let s = html.replace(/<script[\s\S]*?<\/script>/g, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/g, " ");
  // Preserve breaks
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/p>/gi, "\n\n");
  s = s.replace(/<\/li>/gi, "\n");
  // Strip remaining tags
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;/g, " ");
  s = s.replace(/&amp;/g, "&");
  s = s.replace(/&#x27;|&#039;/g, "'");
  s = s.replace(/&quot;/g, '"');
  s = s.replace(/&#8217;/g, "’");
  s = s.replace(/&#8211;/g, "–");
  s = s.replace(/&#8212;/g, "—");
  s = s.replace(/&#x?[0-9a-f]+;/gi, " ");
  // Collapse spaces within a line but keep newlines
  return s
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}


type SitemapEntry = { url: string; sortKey: number };

async function findRecentWeeklyPosts(
  siteOrigin: string,
  limit: number,
): Promise<SitemapEntry[]> {
  const res = await politeFetch(`${siteOrigin}/sitemap.xml`);
  if (!res.ok) return [];
  const xml = await res.text();
  const matches = [
    ...xml.matchAll(/<loc>([^<]*\/p\/this-week-on-lbi-[^<]+)<\/loc>/g),
  ];
  const out: SitemapEntry[] = [];
  for (const m of matches) {
    const url = m[1];
    const slug = url.split("/p/this-week-on-lbi-")[1] ?? "";
    const ymd = slug.match(/^(\d+)-(\d+)-(\d{2})/);
    if (!ymd) continue;
    const month = parseInt(ymd[1], 10);
    const day = parseInt(ymd[2], 10);
    const year = 2000 + parseInt(ymd[3], 10);
    out.push({ url, sortKey: Date.UTC(year, month - 1, day) });
  }
  out.sort((a, b) => b.sortKey - a.sortKey);
  return out.slice(0, limit);
}

function postDateFromUrl(url: string): Date | null {
  const m = url.match(/\/p\/this-week-on-lbi-(\d+)-(\d+)-(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(2000 + +m[3], +m[1] - 1, +m[2]));
}

function extractSection(
  body: string,
  startMarker: string,
  endMarkers: string[],
): string {
  const start = body.indexOf(startMarker);
  if (start < 0) return "";
  const startAfter = start + startMarker.length;
  let end = body.length;
  for (const m of endMarkers) {
    const idx = body.indexOf(m, startAfter);
    if (idx >= 0 && idx < end) end = idx;
  }
  return body.slice(startAfter, end).trim();
}

type ParsedOccurrence = {
  date: { y: number; m: number; d: number };
  startTime?: { h: number; min: number };
  endTime?: { h: number; min: number };
  allDay: boolean;
};

type ParsedEvent = {
  title: string;
  venue?: string;
  town?: string;
  occurrences: ParsedOccurrence[];
  /** Whatever "More Info" link we could locate, if any. Not always present. */
  moreInfoUrl?: string;
};

function parseDateToken(
  token: string,
  refYear: number,
): { y: number; m: number; d: number } | null {
  if (/^Various$/i.test(token.trim())) return null;
  const m = token.match(
    /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?,?\s+([A-Za-z]+)\.?\s+(\d+)(?:st|nd|rd|th)?/i,
  );
  if (!m) return null;
  const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!month) return null;
  const day = parseInt(m[2], 10);
  return { y: refYear, m: month, d: day };
}

function parseTimeRange(
  spec: string,
): { start?: { h: number; min: number }; end?: { h: number; min: number } } {
  // Examples:
  //   "9:30 AM start"
  //   "11:00–12:00 PM"
  //   "6:00 PM"
  //   "1:00–6:00 PM"
  //   "12:00 PM"
  const s = spec.trim().replace(/\s+/g, " ");
  // Range with dash (en or em or hyphen)
  const range = s.match(
    /(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*[–\-—]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/i,
  );
  if (range) {
    const endAmPm = range[6].toLowerCase().replace(/\./g, "");
    const startAmPm = range[3]
      ? range[3].toLowerCase().replace(/\./g, "")
      : endAmPm; // when only end specifies AM/PM, assume same period
    return {
      start: { h: to24h(+range[1], startAmPm), min: range[2] ? +range[2] : 0 },
      end: { h: to24h(+range[4], endAmPm), min: range[5] ? +range[5] : 0 },
    };
  }
  // Single time
  const single = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/i);
  if (single) {
    const ampm = single[3].toLowerCase().replace(/\./g, "");
    return {
      start: { h: to24h(+single[1], ampm), min: single[2] ? +single[2] : 0 },
    };
  }
  return {};
}

function to24h(h: number, ampm: string): number {
  if (/^pm/.test(ampm) && h < 12) return h + 12;
  if (/^am/.test(ampm) && h === 12) return 0;
  return h;
}

/** Split a multi-line section into per-event blocks. Each block in the source
 *  HTML is wrapped in a <p>...</p>, which we converted to "\n\n" delimiters.
 *  Each block has the shape:
 *    <emoji> Title
 *    Venue | Town
 *    Day, Mon DDth | Time | More Info
 *    [optional second day line]
 *  Filter out paragraphs that don't start with an emoji (header text,
 *  sponsor blurbs, etc.). */
function splitIntoEventBlocks(section: string): string[] {
  const blocks = section.split(/\n\s*\n/);
  return blocks
    .map((b) => b.trim())
    .filter((b) => b && EMOJI_PREFIX_RE.test(b))
    // Drop sponsor inserts that begin "Together with <X>"
    .filter((b) => !/^Together with\b/i.test(b.replace(/^[\s\S]*?\n/, "")));
}

function parseEventChunk(
  block: string,
  refYear: number,
): ParsedEvent | null {
  // Each block has 3-4 lines (line 1 = emoji+title, line 2 = venue|town,
  // line 3+ = date|time|MoreInfo for each occurrence).
  const lines = block.split("\n").map((s) => s.trim()).filter(Boolean);
  if (lines.length < 3) return null;

  // Line 1: emoji + title
  const titleLine = lines[0].replace(
    new RegExp(`^${EMOJI_PREFIX_RE.source}\\s*`, "u"),
    "",
  );
  if (!titleLine) return null;
  const title = titleLine.replace(/\s+/g, " ").trim();

  // Line 2: "Venue | Town"
  const loc = lines[1];
  const pipeIdx = loc.indexOf("|");
  let venue: string | undefined;
  let town: string | undefined;
  if (pipeIdx > 0) {
    venue = loc.slice(0, pipeIdx).trim() || undefined;
    town = loc.slice(pipeIdx + 1).trim() || undefined;
  } else {
    venue = loc || undefined;
  }

  // Lines 3+: each is "Day, Mon DDth | TimeSpec [| More Info]" or "Various | ..."
  const occurrences: ParsedOccurrence[] = [];
  for (const line of lines.slice(2)) {
    // Pull date and time-spec out, joined by "|"
    const parts = line.split("|").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) continue;
    const dateRaw = parts[0];
    const timeRaw = parts[1];
    const date = parseDateToken(dateRaw, refYear);
    if (!date) continue; // skip "Various" / unparseable
    const time = timeRaw ? parseTimeRange(timeRaw) : {};
    occurrences.push({
      date,
      startTime: time.start,
      endTime: time.end,
      allDay: !time.start,
    });
  }
  if (occurrences.length === 0) return null;

  return {
    title,
    venue,
    town,
    occurrences,
  };
}

function naiveIso(
  date: { y: number; m: number; d: number },
  time: { h: number; min: number } | undefined,
): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const t = time ? `${pad(time.h)}:${pad(time.min)}` : "00:00";
  return `${date.y}-${pad(date.m)}-${pad(date.d)}T${t}:00`;
}

export const beehiivLowdownAdapter: Adapter = async ({ source }): Promise<AdapterResult> => {
  const warnings: string[] = [];
  const cfg = (source.config ?? {}) as LowdownConfig;
  const tz = cfg.defaultTimeZone || "America/New_York";
  const maxPosts = Math.max(1, Math.min(8, cfg.maxPosts ?? 4));
  const origin = new URL(source.url).origin;

  const posts = await findRecentWeeklyPosts(origin, maxPosts);
  if (posts.length === 0) {
    return {
      events: [],
      warnings: ["No 'this-week-on-lbi-*' posts found in sitemap.xml"],
    };
  }

  const events: ReturnType<typeof buildEvent>[] = [];
  const cutoff = Date.now() - 24 * 3600_000;

  // Process the most recent post(s). One post is usually sufficient (it covers
  // ~7 days); we fetch a small history so re-runs after a gap still grab
  // anything still upcoming.
  for (const entry of posts.slice(0, maxPosts)) {
    const postDate = postDateFromUrl(entry.url);
    if (!postDate) continue;
    const refYear = postDate.getUTCFullYear();
    const res = await politeFetch(entry.url);
    if (!res.ok) {
      warnings.push(`HTTP ${res.status} fetching ${entry.url}`);
      continue;
    }
    const body = stripHtmlPreservingLines(await res.text());

    const thingsToDo = extractSection(body, SECTION_MARKERS.thingsToDo, [
      SECTION_MARKERS.familyFun,
      SECTION_MARKERS.liveMusic,
      "Eat & Drink",
      "Weather",
    ]);
    const familyFun = extractSection(body, SECTION_MARKERS.familyFun, [
      SECTION_MARKERS.liveMusic,
      "Eat & Drink",
      "Weather",
    ]);

    const chunks: string[] = [
      ...splitIntoEventBlocks(thingsToDo),
      ...splitIntoEventBlocks(familyFun),
    ];

    for (const chunk of chunks) {
      const parsed = parseEventChunk(chunk, refYear);
      if (!parsed) continue;

      for (const occ of parsed.occurrences) {
        const startIso = naiveToUtcIso(
          naiveIso(occ.date, occ.startTime),
          tz,
        );
        const endIso = occ.endTime
          ? naiveToUtcIso(naiveIso(occ.date, occ.endTime), tz)
          : undefined;

        if (new Date(endIso ?? startIso).getTime() < cutoff) continue;

        const naturalKey = [
          entry.url.split("/p/")[1] ?? "",
          parsed.title.toLowerCase().replace(/\s+/g, "-"),
          `${occ.date.y}-${occ.date.m}-${occ.date.d}`,
          occ.startTime ? `${occ.startTime.h}${occ.startTime.min}` : "ad",
        ].join("::");

        events.push(
          buildEvent(source, {
            naturalKey,
            title: parsed.title,
            url: entry.url,
            start: startIso,
            end: endIso,
            allDay: occ.allDay,
            location: {
              venue: parsed.venue,
              town: parsed.town ?? source.town,
            },
          }),
        );
      }
    }
  }

  // Dedupe by id (multiple newsletter editions can reference the same event).
  const seen = new Set<string>();
  const unique = events.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });

  return { events: unique, warnings };
};
