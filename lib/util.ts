import { createHash } from "node:crypto";
import { categorize } from "./categorize";
import { loadRegion } from "./region";
import { extractTownInText, findTownIn } from "./towns";
import type { EventRecord, SourceConfig } from "./types";

export function makeEventId(sourceId: string, naturalKey: string): string {
  return createHash("sha1").update(`${sourceId}::${naturalKey}`).digest("hex").slice(0, 16);
}

export function nowIso(): string {
  return new Date().toISOString();
}

// Convert a wall-clock time in an IANA timezone to UTC ISO 8601.
// E.g. naiveToUtcIso("2026-05-11T09:00:00", "America/New_York") -> "2026-05-11T13:00:00.000Z"
export function naiveToUtcIso(naiveLocal: string, tz: string): string {
  const asUtc = new Date(naiveLocal + "Z");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(asUtc);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const tzWall = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
  const diff = Date.parse(naiveLocal + "Z") - Date.parse(tzWall + "Z");
  return new Date(asUtc.getTime() + diff).toISOString();
}

// Some adapters return a "venue" string that's actually a full address, like
// "11 Mechanic St., Natick, MA" — or a venue with an address suffix like
// "TCAN, 14 Summer St, Natick, MA 01760" or "Wellesley HS parking lot, 50 Rice St.".
// This helper splits those into a clean venue + an address tail.
const STREET_WORD_RE =
  /\b(St|Rd|Ave|Dr|Ln|Way|Pkwy|Blvd|Pl|Ct|Cir|Sq|Hwy|Plaza|Ter|Trl|Pike|Highway|Street|Road|Avenue|Drive|Lane|Place|Court|Circle|Square|Terrace|Trail)\b\.?/i;

export function splitVenueAndAddress(raw: string): {
  venue?: string;
  addressTail?: string;
} {
  const s = raw.trim();
  if (!s) return {};
  // Find a `<1-5 digit> <word>` tail preceded by start, space, or comma.
  const tailMatch = s.match(/(?:^|[,\s]+)(\d{1,5}\s+[A-Za-z][\s\S]*)$/);
  if (!tailMatch || tailMatch.index === undefined) return { venue: s };
  const tail = tailMatch[1].trim();
  // Sanity: the supposed address tail must contain a street-word, else this
  // is probably an event number, not an address ("Class 1", "Event 7", etc.).
  if (!STREET_WORD_RE.test(tail)) return { venue: s };
  const tailStart = tailMatch.index + (tailMatch[0].length - tailMatch[1].length);
  const venueRaw = s.slice(0, tailStart).replace(/[,\s]+$/, "").trim();
  if (venueRaw.length === 0) return { addressTail: tail };
  return { venue: venueRaw, addressTail: tail };
}

export function toIsoOrUndefined(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

export function buildEvent(
  source: SourceConfig,
  partial: Omit<EventRecord, "id" | "source" | "ingestedAt" | "type"> & {
    naturalKey: string;
    type?: EventRecord["type"];
  },
): EventRecord {
  const { naturalKey, type, ...rest } = partial;
  const townIndex = safeTownIndex();
  const venueAliases = safeVenueAliases();

  let location = rest.location;

  // Step 1: detach any address embedded in the venue field
  // ("TCAN, 14 Summer St, Natick, MA" → venue="TCAN", address="14 Summer St…").
  const venueRaw = location?.venue?.trim();
  if (venueRaw) {
    const split = splitVenueAndAddress(venueRaw);
    if (split.venue !== venueRaw || split.addressTail) {
      location = {
        ...(location ?? {}),
        venue: split.venue,
        address: location?.address || split.addressTail,
      };
    }
  }

  // Step 2: normalize venue aliases ("Center for the Arts in Natick" → "TCAN").
  const venueIn = location?.venue?.trim();
  if (venueIn && venueAliases) {
    const canonical = venueAliases.get(venueIn.toLowerCase());
    if (canonical && canonical !== venueIn) {
      location = { ...(location ?? {}), venue: canonical };
    }
  }

  const existingTown = location?.town?.trim();
  if (!existingTown) {
    const guessed = townIndex
      ? extractTownInText(townIndex, rest.title) ??
        extractTownInText(townIndex, rest.description)
      : undefined;
    if (guessed) location = { ...(location ?? {}), town: guessed };
  } else if (townIndex) {
    // Normalize aliases to canonical name (e.g. "Marlboro" → "Marlborough").
    // Falls through unchanged if not a known town in this region.
    const canonical = findTownIn(townIndex, existingTown)?.name ?? existingTown;
    if (location && location.town !== canonical) {
      location = { ...location, town: canonical };
    }
  }

  return {
    ...rest,
    location,
    type: type ?? categorize(rest.title, rest.description),
    id: makeEventId(source.id, naturalKey),
    source: { id: source.id, name: source.name },
    ingestedAt: nowIso(),
  };
}

function safeTownIndex() {
  try {
    return loadRegion().townIndex;
  } catch {
    return undefined;
  }
}

function safeVenueAliases() {
  try {
    return loadRegion().venueAliases;
  } catch {
    return undefined;
  }
}

// Many shared-WAF hosts (WP Engine, etc.) 403 anything that doesn't look
// browser-like. Use a generic Mozilla UA — still polite, just not flagged.
const USER_AGENT = "Mozilla/5.0 (compatible; metrowest-events/0.1)";

export async function politeFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("User-Agent")) headers.set("User-Agent", USER_AGENT);
  if (!headers.has("Accept")) {
    headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  }
  return fetch(url, { ...init, headers });
}
