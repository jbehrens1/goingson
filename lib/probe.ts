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
import { squarespaceEventsAdapter } from "./adapters/squarespace-events";
import { elfsightEventsAdapter } from "./adapters/elfsight-events";
import { politeFetch } from "./util";

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

const VERIFY_ADAPTERS: Partial<Record<AdapterType, Adapter>> = {
  ical: icalAdapter,
  rss: rssAdapter,
  "wordpress-tribe": wordpressTribeAdapter,
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

export async function probeSource(source: SourceConfig): Promise<ProbeCandidate[]> {
  const candidates: ProbeCandidate[] = [];
  const base = new URL(source.url);

  // 1) Fetch the canonical page (follows redirects) and scan for embeds.
  let html = "";
  let finalUrl = source.url;
  try {
    const res = await politeFetch(base.toString(), { redirect: "follow" });
    finalUrl = res.url || source.url;
    if (res.ok) html = await res.text();
  } catch {
    // ignore — we'll just have no HTML to analyze
  }

  // 2) Embedded-calendar detectors (high signal, high confidence).
  const tockify = html ? detectTockify(html) : null;
  if (tockify) {
    const url = `https://tockify.com/api/feeds/ics/${tockify.slug}`;
    const count = await verify(source, "ical", url, {
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
    const count = await verify(source, "wordpress-tribe", wpUrl, source.config);
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
    const count = await verify(source, "elfsight-events", source.url, cfg);
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
      const count = await verify(source, source.adapter, newUrl, source.config);
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
        const count = await verify(source, "squarespace-events", `${origin}/`, {
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
      const count = await verify(source, "ical", url);
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

  // Sort: highest verified count first, then confidence tier.
  const confRank = { high: 3, medium: 2, low: 1 } as const;
  candidates.sort((a, b) => {
    if (b.verifiedCount !== a.verifiedCount) return b.verifiedCount - a.verifiedCount;
    return confRank[b.confidence] - confRank[a.confidence];
  });
  return candidates;
}

/**
 * Threshold check: should this candidate auto-replace the current source config?
 * Conservative: high confidence + >10 events + >5x the original yield.
 */
export function shouldAutoApply(
  candidate: ProbeCandidate,
  currentYield: number,
): boolean {
  if (candidate.confidence !== "high") return false;
  if (candidate.verifiedCount < 10) return false;
  if (candidate.verifiedCount < currentYield * 5) return false;
  return true;
}
