// When a source returns 0-1 events, the probe runs to find a better
// configuration. It looks for embedded calendar widgets (Tockify, Eventbrite,
// OvationTix, LibCal), follows redirects, and tries common alternative URL
// paths. Verified candidates that yield substantially more events can be
// auto-applied by the ingest pipeline (see ingest.ts).
//
// Conservative by design: the auto-apply gate (in ingest.ts) only fires for
// HIGH confidence candidates with >10 verified events. Lower-confidence
// findings are surfaced as warnings for human review.

import type { Adapter, AdapterType, SourceConfig } from "./types";
import { icalAdapter } from "./adapters/ical";
import { rssAdapter } from "./adapters/rss";
import { wordpressTribeAdapter } from "./adapters/wordpress-tribe";
import { wordpressMcAdapter } from "./adapters/wordpress-mc";
import { wordpressMecAdapter } from "./adapters/wordpress-mec";
import { wordpressGeodirAdapter } from "./adapters/wordpress-geodir";
import { growthzoneCalendarAdapter } from "./adapters/growthzone-calendar";
import { seeticketsListAdapter } from "./adapters/seetickets-list";
import { squarespaceEventsAdapter } from "./adapters/squarespace-events";
import { elfsightEventsAdapter } from "./adapters/elfsight-events";
import { politeFetch } from "./util";
import { headlessFetch, isHeadlessConfigured } from "./headless-fetch";

/** When the live ingest count is below this, run a probe to find a better
 *  config. Was ≤1 originally — bumped to <5 so brand-new venues that yield
 *  only 2-3 events get extra effort to find their full feed. */
export const LOW_YIELD_THRESHOLD = 5;

/** Probe mode.
 *  - "light": run when an established source's yield dropped. Skip the more
 *    expensive WP-discovery and generic alt-path crawl since the venue was
 *    working before — usually their host had a hiccup or moved one URL.
 *  - "deep": run when a source has NEVER produced events (or only on the
 *    admin "force re-probe" action). Tries everything we know how to probe. */
export type ProbeMode = "light" | "deep";

export type ProbeCandidate = {
  confidence: "high" | "medium" | "low";
  /** Number of events the candidate actually produced when test-run. */
  verifiedCount: number;
  adapter: AdapterType;
  url: string;
  config?: Record<string, unknown>;
  /** Short human-readable explanation: "Tockify embed detected (slug=prezhall)". */
  evidence: string;
};

/** Every URL/adapter combination the probe attempted, whether it produced
 *  events or not. Surfaced in the QC dashboard so admin can see the effort
 *  ("we tried 20 paths and got 0 from each") and confirm the source really
 *  has nothing rather than missing a clever variant. */
export type ProbeAttempt = {
  url: string;
  adapter: AdapterType;
  count: number;
  /** Short label describing what was being checked. */
  note?: string;
};

/** Full probe result: both ranked candidates and every URL we touched. */
export type ProbeResult = {
  candidates: ProbeCandidate[];
  attempts: ProbeAttempt[];
};

const VERIFY_ADAPTERS: Partial<Record<AdapterType, Adapter>> = {
  ical: icalAdapter,
  rss: rssAdapter,
  "wordpress-tribe": wordpressTribeAdapter,
  "wordpress-mc": wordpressMcAdapter,
  "wordpress-mec": wordpressMecAdapter,
  "wordpress-geodir": wordpressGeodirAdapter,
  "growthzone-calendar": growthzoneCalendarAdapter,
  "seetickets-list": seeticketsListAdapter,
  "squarespace-events": squarespaceEventsAdapter,
  "elfsight-events": elfsightEventsAdapter,
};

// ---------------------------------------------------------------------------
// Detectors: scan the main page HTML for embedded calendar signatures.
// Each returns an unverified candidate; verification happens below.
// ---------------------------------------------------------------------------

function detectTockify(html: string): { slug: string } | null {
  // <div data-tockify-calendar="prezhall" ...> or similar
  const m = html.match(/data-tockify-calendar=["']([a-zA-Z0-9_-]+)["']/);
  return m ? { slug: m[1] } : null;
}

function detectEventbriteOrganizer(html: string): { organizerId: string } | null {
  // eventbrite.com/o/<organizer-slug>-<id>
  const m = html.match(/eventbrite\.com\/o\/[a-zA-Z0-9-]*?(\d{8,})/);
  return m ? { organizerId: m[1] } : null;
}

function detectLibCal(html: string): { subdomain: string; libraryId?: string } | null {
  // <subdomain>.libcal.com
  const m = html.match(/([a-z0-9-]+)\.libcal\.com/);
  return m ? { subdomain: m[1] } : null;
}

function detectTribe(html: string): boolean {
  // The Events Calendar plugin signature
  return (
    /tribe-events-calendar|class="tribe-events|wp-content\/plugins\/the-events-calendar/.test(
      html,
    )
  );
}

function detectElfsight(html: string): { widgetId: string } | null {
  // Elfsight embeds reveal the widget UUID via `elfsight-app-<uuid>` div ids
  // (and the platform.js include). The boot endpoint takes that id verbatim
  // and returns the event payload.
  const m = html.match(
    /elfsight-app-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i,
  );
  return m ? { widgetId: m[1] } : null;
}

function detectMec(html: string): boolean {
  // Modern Events Calendar plugin: signatures in CSS/JS includes + body class
  return /mec-events-calendar|wp-content\/plugins\/modern-events-calendar|class="mec-event/.test(
    html,
  );
}

function detectMyCalendar(html: string): boolean {
  // My Calendar plugin: distinctive class names and asset paths
  return /class="mc-main|wp-content\/plugins\/my-calendar|my-calendar-event/.test(html);
}

function detectGeoDirectory(html: string): boolean {
  // GeoDirectory event extension: usually via wp-content/plugins/geodir_event_manager
  return /geodirectory|geodir_event_manager|geodir-events/.test(html);
}

function detectGrowthZone(html: string): boolean {
  // ChamberMaster / GrowthZone-hosted chamber sites embed via these slugs
  return /business\.[a-z0-9-]+\.com\/community-calendar|growthzone\.com|chambermaster/.test(
    html,
  );
}

function detectSeeTickets(html: string): boolean {
  // See Tickets WordPress plugin renders .seetickets-list-event-container blocks
  return /seetickets-(list|calendar)-event|seetickets-custom-scripts|wl\.seetickets\.us/.test(
    html,
  );
}

function detectJsonLdEvents(html: string): number {
  // Count occurrences of structured-data Event blocks. Many sites that don't
  // expose a feed do publish JSON-LD per event page or per listing page.
  // Returns the count (not a boolean) so we can rank.
  const matches = html.match(/"@type"\s*:\s*"Event"/g);
  return matches ? matches.length : 0;
}

// ---------------------------------------------------------------------------
// Alternative path lists per adapter type. Used when the main page doesn't
// reveal an embedded calendar widget, to probe whether events moved to a
// different collection.
// ---------------------------------------------------------------------------

const SQUARESPACE_ALT_PATHS = [
  "/events/",
  "/calendar/",
  "/programs/",
  "/performance/",
  "/music/",
  "/shows/",
  "/happenings/",
  "/workshops/",
  "/special-events/",
  "/all-workshops/",
  "/classes/",
];

const ICAL_ALT_PATHS = [
  "/events.ics",
  "/calendar.ics",
  "/feed.ics",
  "/events/?ical=1",
  "/calendar/?ical=1",
];

/** Common event-collection paths. Used in deep-probe mode to try the
 *  source's existing adapter against several URL alternatives, in case the
 *  venue moved their calendar from / to /events/ etc. Ordered roughly by
 *  prevalence so first hits resolve faster. */
const GENERIC_EVENT_PATHS = [
  "/events/",
  "/events",
  "/calendar/",
  "/calendar",
  "/shows/",
  "/shows",
  "/upcoming-events/",
  "/upcoming/",
  "/whats-on/",
  "/whats-on",
  "/programs/",
  "/programs",
  "/season/",
  "/season",
  "/entertainment/",
  "/entertainment",
  "/performance/",
  "/performances/",
  "/happenings/",
  "/visit/events/",
];

// ---------------------------------------------------------------------------
// Verification: actually run the adapter against the candidate URL/config and
// count events. Only candidates with verifiedCount > 0 are returned.
// ---------------------------------------------------------------------------

async function verify(
  source: SourceConfig,
  adapter: AdapterType,
  url: string,
  config?: Record<string, unknown>,
): Promise<number> {
  const fn = VERIFY_ADAPTERS[adapter];
  if (!fn) return 0;
  const probeSource: SourceConfig = { ...source, adapter, url, config };
  try {
    const result = await fn({ source: probeSource, fetch });
    return result.events.length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Main probe entry point.
// ---------------------------------------------------------------------------

/** Try the given adapter against a known WordPress custom-post-type REST
 *  endpoint. Returns event count; 0 if no events or the endpoint 404s. */
async function tryWpCustomPostType(
  source: SourceConfig,
  origin: string,
  rest_base: string,
): Promise<number> {
  // The wordpress-mc adapter uses mc_event; mec-events for MEC. For other
  // CPTs we fall back to a raw REST fetch and count entries.
  const url = `${origin}/wp-json/wp/v2/${rest_base}?per_page=5`;
  try {
    const res = await politeFetch(url);
    if (!res.ok) return 0;
    const text = await res.text();
    // Quick parse: the count of "id":<n> entries roughly matches event count.
    const matches = text.match(/"id"\s*:\s*\d+/g);
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

/** Enumerate event-like custom post types exposed by WP REST. Returns a list
 *  of {rest_base, slug} candidates that look like events. */
async function discoverWpEventPostTypes(origin: string): Promise<Array<{ rest_base: string; slug: string }>> {
  try {
    const res = await politeFetch(`${origin}/wp-json/wp/v2/types`);
    if (!res.ok) return [];
    const json = (await res.json()) as Record<string, { slug?: string; rest_base?: string; name?: string }>;
    return Object.values(json)
      .filter((t) => {
        const s = `${t.slug ?? ""} ${t.rest_base ?? ""} ${t.name ?? ""}`.toLowerCase();
        return (
          s.includes("event") ||
          s.includes("calendar") ||
          s.includes("performance") ||
          s.includes("show") ||
          s.includes("concert") ||
          s.includes("program")
        );
      })
      .filter((t) => t.rest_base && t.slug)
      .map((t) => ({ rest_base: t.rest_base!, slug: t.slug! }));
  } catch {
    return [];
  }
}

export async function probeSource(
  source: SourceConfig,
  mode: ProbeMode = "light",
): Promise<ProbeResult> {
  const candidates: ProbeCandidate[] = [];
  const attempts: ProbeAttempt[] = [];
  const base = new URL(source.url);

  // Wrap verify() so every attempt is logged regardless of outcome. Callers
  // continue to use raw counts for branching but the audit trail builds up
  // automatically.
  const tryAdapter = async (
    adapter: AdapterType,
    url: string,
    config?: Record<string, unknown>,
    note?: string,
  ): Promise<number> => {
    const count = await verify(source, adapter, url, config);
    attempts.push({ url, adapter, count, note });
    return count;
  };

  // 1) Fetch the canonical page (follows redirects) and scan for embeds.
  //    For sources flagged useHeadless OR that 403 on the first GET (likely
  //    Cloudflare/Kemo bot-gate), retry through the headless rendering
  //    service if one is configured. McCallum Theatre is the canonical
  //    example — without JS execution we get a 403; with it we get the
  //    real season schedule.
  let html = "";
  let finalUrl = source.url;
  const useHeadless = (source.config as { useHeadless?: boolean } | undefined)
    ?.useHeadless === true;
  try {
    const res = await politeFetch(base.toString(), { redirect: "follow" });
    finalUrl = res.url || source.url;
    if (res.ok) {
      html = await res.text();
    } else if ((useHeadless || res.status === 403) && isHeadlessConfigured()) {
      const headlessHtml = await headlessFetch(base.toString());
      if (headlessHtml) {
        html = headlessHtml;
        attempts.push({
          url: base.toString(),
          adapter: source.adapter,
          count: 0,
          note: `Headless fallback (politeFetch returned ${res.status})`,
        });
      }
    }
  } catch {
    // ignore — we'll just have no HTML to analyze
  }

  // 2) Embedded-calendar detectors (high signal, high confidence).
  const tockify = html ? detectTockify(html) : null;
  if (tockify) {
    const url = `https://tockify.com/api/feeds/ics/${tockify.slug}`;
    const count = await tryAdapter("ical", url, {
      defaultVenue: source.config?.defaultVenue ?? source.name,
    });
    if (count > 0) {
      candidates.push({
        confidence: count > 10 ? "high" : "medium",
        verifiedCount: count,
        adapter: "ical",
        url,
        config: { defaultVenue: source.config?.defaultVenue ?? source.name },
        evidence: `Tockify embed found (slug=${tockify.slug}); iCal feed yields ${count} events.`,
      });
    }
  }

  const tribe = html ? detectTribe(html) : false;
  if (tribe && source.adapter !== "wordpress-tribe") {
    const baseUrl = new URL(finalUrl);
    const wpUrl = `${baseUrl.origin}/`;
    const count = await tryAdapter("wordpress-tribe", wpUrl, source.config, "Tribe REST");
    if (count > 0) {
      candidates.push({
        confidence: count > 10 ? "high" : "medium",
        verifiedCount: count,
        adapter: "wordpress-tribe",
        url: wpUrl,
        config: source.config,
        evidence: `The Events Calendar (Tribe) signature detected; REST yields ${count} events.`,
      });
    }
  }

  const eventbrite = html ? detectEventbriteOrganizer(html) : null;
  if (eventbrite) {
    candidates.push({
      confidence: "low", // adapter requires EVENTBRITE_TOKEN; can't verify here
      verifiedCount: 0,
      adapter: "eventbrite",
      url: `https://www.eventbrite.com/o/${eventbrite.organizerId}`,
      evidence: `Eventbrite organizer ID ${eventbrite.organizerId} found; configure eventbrite adapter manually.`,
    });
  }

  const elfsight = html ? detectElfsight(html) : null;
  if (elfsight && source.adapter !== "elfsight-events") {
    const cfg = {
      widgetId: elfsight.widgetId,
      pageUrl: finalUrl,
      defaultVenue: source.config?.defaultVenue ?? source.name,
    };
    const count = await tryAdapter("elfsight-events", source.url, cfg, "Elfsight boot endpoint");
    if (count > 0) {
      candidates.push({
        confidence: count > 5 ? "high" : "medium",
        verifiedCount: count,
        adapter: "elfsight-events",
        url: source.url,
        config: cfg,
        evidence: `Elfsight event-widget embed found (widgetId=${elfsight.widgetId.slice(0, 8)}…); boot endpoint yields ${count} events.`,
      });
    }
  }

  const libcal = html ? detectLibCal(html) : null;
  if (libcal) {
    // LibCal exposes iCal feeds at <subdomain>.libcal.com/ical_subscribe.php?cid=<id>
    // We don't have the calendar id without scraping further; surface as low-conf.
    candidates.push({
      confidence: "low",
      verifiedCount: 0,
      adapter: "ical",
      url: `https://${libcal.subdomain}.libcal.com/`,
      evidence: `LibCal subdomain found (${libcal.subdomain}.libcal.com); manual config needed for iCal subscription URL.`,
    });
  }

  // 3) Redirect repair: if the canonical URL redirected to a different origin,
  //    the original is likely a stale bookmark.
  try {
    if (
      finalUrl &&
      new URL(finalUrl).origin !== base.origin &&
      source.adapter === "squarespace-events"
    ) {
      // Try the existing adapter against the new origin with the existing path.
      const newUrl = `${new URL(finalUrl).origin}/`;
      const count = await tryAdapter(source.adapter, newUrl, source.config, "Redirect repair");
      if (count > 0) {
        candidates.push({
          confidence: count > 10 ? "high" : "medium",
          verifiedCount: count,
          adapter: source.adapter,
          url: newUrl,
          config: source.config,
          evidence: `Original URL redirects to ${newUrl}; refreshed source yields ${count} events.`,
        });
      }
    }
  } catch {
    // bad URL — skip
  }

  // 4) Alternative-path probes (per-adapter): try common event-collection paths.
  if (source.adapter === "squarespace-events") {
    const origin = new URL(finalUrl || source.url).origin;
    const probes = await Promise.all(
      SQUARESPACE_ALT_PATHS.map(async (p) => {
        const count = await tryAdapter("squarespace-events", `${origin}/`, {
          ...source.config,
          path: p,
        });
        return { path: p, count };
      }),
    );
    const best = probes
      .filter((p) => p.count > 0)
      .sort((a, b) => b.count - a.count)[0];
    if (best) {
      candidates.push({
        confidence: best.count > 10 ? "high" : "medium",
        verifiedCount: best.count,
        adapter: "squarespace-events",
        url: `${origin}/`,
        config: { ...source.config, path: best.path },
        evidence: `Squarespace collection at ${best.path} yields ${best.count} events.`,
      });
    }
  }

  // 5) iCal autodiscovery fallback (any adapter).
  if (source.adapter !== "ical") {
    const origin = new URL(finalUrl || source.url).origin;
    for (const p of ICAL_ALT_PATHS) {
      const url = `${origin}${p}`;
      const count = await tryAdapter("ical", url, undefined, "iCal autodiscovery");
      if (count > 0) {
        candidates.push({
          confidence: count > 10 ? "high" : "medium",
          verifiedCount: count,
          adapter: "ical",
          url,
          evidence: `iCal feed at ${p} yields ${count} events.`,
        });
        break; // one ICS hit is enough
      }
    }
  }

  // 6) WordPress plugin detectors (deep mode also runs MEC + MC + GeoDir).
  if (html && mode === "deep") {
    const origin = new URL(finalUrl || source.url).origin;
    const wpUrl = `${origin}/`;

    if (detectMec(html) && source.adapter !== "wordpress-mec") {
      const count = await tryAdapter("wordpress-mec", wpUrl, source.config, "MEC plugin");
      if (count > 0) {
        candidates.push({
          confidence: count > 10 ? "high" : "medium",
          verifiedCount: count,
          adapter: "wordpress-mec",
          url: wpUrl,
          config: source.config,
          evidence: `Modern Events Calendar (MEC) signature detected; yields ${count} events.`,
        });
      }
    }
    if (detectMyCalendar(html) && source.adapter !== "wordpress-mc") {
      const count = await tryAdapter("wordpress-mc", wpUrl, source.config, "My Calendar plugin");
      if (count > 0) {
        candidates.push({
          confidence: count > 10 ? "high" : "medium",
          verifiedCount: count,
          adapter: "wordpress-mc",
          url: wpUrl,
          config: source.config,
          evidence: `My Calendar plugin signature detected; yields ${count} events.`,
        });
      }
    }
    if (detectGeoDirectory(html) && source.adapter !== "wordpress-geodir") {
      const count = await tryAdapter("wordpress-geodir", wpUrl, source.config, "GeoDirectory plugin");
      if (count > 0) {
        candidates.push({
          confidence: count > 10 ? "high" : "medium",
          verifiedCount: count,
          adapter: "wordpress-geodir",
          url: wpUrl,
          config: source.config,
          evidence: `GeoDirectory event extension detected; yields ${count} events.`,
        });
      }
    }
    if (detectGrowthZone(html) && source.adapter !== "growthzone-calendar") {
      const count = await tryAdapter("growthzone-calendar", source.url, source.config, "GrowthZone calendar");
      if (count > 0) {
        candidates.push({
          confidence: count > 10 ? "high" : "medium",
          verifiedCount: count,
          adapter: "growthzone-calendar",
          url: source.url,
          config: source.config,
          evidence: `ChamberMaster / GrowthZone calendar detected; yields ${count} events.`,
        });
      }
    }
    if (detectSeeTickets(html) && source.adapter !== "seetickets-list") {
      // See Tickets plugin renders calendar at /calendar/. Try that path.
      const sUrl = `${origin}/calendar/`;
      const count = await tryAdapter("seetickets-list", sUrl, source.config, "See Tickets plugin");
      if (count > 0) {
        candidates.push({
          confidence: count > 10 ? "high" : "medium",
          verifiedCount: count,
          adapter: "seetickets-list",
          url: sUrl,
          config: source.config,
          evidence: `See Tickets WordPress plugin detected; /calendar/ yields ${count} events.`,
        });
      }
    }
  }

  // 7) WP-discovery: probe /wp-json/wp/v2/types for any event-like custom
  //    post type, then check its REST endpoint. Catches plugins we don't
  //    have a dedicated adapter for (just count entries — not ingest-able
  //    without a custom adapter, but surfaces the lead for manual review).
  //    Deep mode only.
  if (mode === "deep") {
    try {
      const origin = new URL(finalUrl || source.url).origin;
      const types = await discoverWpEventPostTypes(origin);
      for (const t of types) {
        const count = await tryWpCustomPostType(source, origin, t.rest_base);
        const cptUrl = `${origin}/wp-json/wp/v2/${t.rest_base}`;
        attempts.push({
          url: cptUrl,
          adapter: source.adapter,
          count,
          note: `WP custom post type "${t.slug}"`,
        });
        if (count > 0) {
          candidates.push({
            confidence: "low", // no dedicated adapter — surface as lead only
            verifiedCount: count,
            adapter: source.adapter, // unchanged
            url: cptUrl,
            evidence: `WP custom post type "${t.slug}" exposes ${count} entries via REST. Build a custom adapter or extend wordpress-mc/mec to consume.`,
          });
        }
      }
    } catch {
      // ignore
    }
  }

  // 8) Generic event-path crawl: try the source's existing adapter against
  //    common event-collection paths. Catches cases where a venue moved their
  //    calendar from / to /events/ etc. Deep mode only.
  if (mode === "deep") {
    const origin = new URL(finalUrl || source.url).origin;
    for (const p of GENERIC_EVENT_PATHS) {
      const tryUrl = `${origin}${p}`;
      if (tryUrl === source.url) continue;
      const count = await tryAdapter(source.adapter, tryUrl, source.config, "Alt-path crawl");
      if (count > 0) {
        candidates.push({
          confidence: count > 10 ? "high" : count > 3 ? "medium" : "low",
          verifiedCount: count,
          adapter: source.adapter,
          url: tryUrl,
          config: source.config,
          evidence: `Existing ${source.adapter} adapter at ${p} yields ${count} events (was ${source.url}).`,
        });
        // Don't break — collect all hits, sort at the end. Some paths may
        // yield more than others; the ranker picks the best.
      }
    }
  }

  // 9) JSON-LD scan as last-ditch: count "@type":"Event" blocks on the page
  //    itself. If the html-generic adapter wasn't already running, surface
  //    this as a lead so admin knows there ARE events embedded somewhere.
  //    Deep mode only.
  if (mode === "deep" && html && source.adapter !== "html-generic") {
    const jsonLdCount = detectJsonLdEvents(html);
    if (jsonLdCount > 0) {
      const count = await tryAdapter("html-generic" as AdapterType, source.url, undefined, "JSON-LD scan");
      if (count > 0) {
        candidates.push({
          confidence: count > 10 ? "medium" : "low",
          verifiedCount: count,
          adapter: "html-generic" as AdapterType,
          url: source.url,
          evidence: `Page has ${jsonLdCount} JSON-LD Event blocks; html-generic yields ${count} events.`,
        });
      }
    }
  }

  // Sort: highest verified count first, then confidence tier.
  const confRank = { high: 3, medium: 2, low: 1 } as const;
  candidates.sort((a, b) => {
    if (b.verifiedCount !== a.verifiedCount) return b.verifiedCount - a.verifiedCount;
    return confRank[b.confidence] - confRank[a.confidence];
  });
  return { candidates, attempts };
}

/**
 * Threshold check: should this candidate auto-replace the current source config?
 * Conservative: high confidence + >10 events + >5x the original yield.
 *
 * For brand-new sources (currentYield = 0), any high-confidence candidate
 * with >10 events is auto-applied since "5x" is meaningless against 0.
 */
export function shouldAutoApply(
  candidate: ProbeCandidate,
  currentYield: number,
): boolean {
  if (candidate.confidence !== "high") return false;
  if (candidate.verifiedCount < 10) return false;
  if (currentYield > 0 && candidate.verifiedCount < currentYield * 5) return false;
  return true;
}
