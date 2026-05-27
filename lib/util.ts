import { createHash } from "node:crypto";
import { categorize, typeFromPlatformCategories } from "./categorize";
import { cleanDescription } from "./clean-text";
import { loadRegion } from "./region";
import { extractTownInText, findTownIn } from "./towns";
import type { EventRecord, SourceConfig } from "./types";

// Re-export so existing callers (`import { cleanDescription } from "@/lib/util"`)
// keep working. Client code should import directly from "./clean-text" to
// avoid pulling node:crypto into the browser bundle.
export { cleanDescription };

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

  // Normalize the description: decode entities, strip tags, collapse
  // whitespace. Some adapters (jcc-greater-boston / Tribe REST especially)
  // hand us HTML-escaped HTML like "&lt;p&gt;Body..." which renders as raw
  // text. Centralizing here means every adapter benefits and the events
  // file is clean for downstream consumers (newsletter, calendar widget).
  rest.description = cleanDescription(rest.description);

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

  // Categorization priority (when the caller didn't pin `type` explicitly):
  //   1. source.titleRules     — surgical per-venue overrides (highest signal)
  //   2. categorize(title+desc) — global keyword regex (high-signal, title-derived)
  //   3. platform categories   — Tribe/Squarespace/iCal/Tockify tags (used only
  //                              when title regex falls through to "other";
  //                              Tockify in particular tags everything with
  //                              generic "Community,Education,Wellness", which
  //                              would otherwise drown out specific title signals
  //                              like "Mah Jongg" or "Workshop").
  //   4. source.defaultEventType — venue-level fallback (e.g. live-music bar)
  //   5. "other"
  let resolvedType: EventRecord["type"] | undefined = type;
  if (!resolvedType) resolvedType = matchTitleRules(source, rest.title);
  if (!resolvedType) {
    const titleType = categorize(rest.title, rest.description);
    if (titleType !== "other") {
      resolvedType = titleType;
    } else {
      resolvedType =
        typeFromPlatformCategories(rest.categories) ??
        source.defaultEventType ??
        "other";
    }
  }

  return {
    ...rest,
    location,
    type: resolvedType,
    id: makeEventId(source.id, naturalKey),
    source: { id: source.id, name: source.name },
    ingestedAt: nowIso(),
  };
}

/** Apply source.titleRules to a title. First match wins. Returns undefined
 *  when no rule matches (caller falls through to next strategy). Malformed
 *  regex sources are silently skipped — we don't want one bad rule to kill
 *  ingest. */
function matchTitleRules(
  source: SourceConfig,
  title: string,
): EventRecord["type"] | undefined {
  const rules = source.titleRules;
  if (!rules?.length) return undefined;
  for (const rule of rules) {
    try {
      if (new RegExp(rule.pattern, "i").test(title)) return rule.type;
    } catch {
      /* skip malformed regex */
    }
  }
  return undefined;
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
const USER_AGENT = "Mozilla/5.0 (compatible; goingson/0.1)";

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
