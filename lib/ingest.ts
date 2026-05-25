import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { icalAdapter } from "./adapters/ical";
import { rssAdapter } from "./adapters/rss";
import { eventbriteAdapter } from "./adapters/eventbrite";
import { patchAdapter } from "./adapters/patch";
import { htmlGenericAdapter } from "./adapters/html-generic";
import { wordpressTribeAdapter } from "./adapters/wordpress-tribe";
import { wordpressTribeListAdapter } from "./adapters/wordpress-tribe-list";
import { wordpressMcAdapter } from "./adapters/wordpress-mc";
import { wordpressMecAdapter } from "./adapters/wordpress-mec";
import { squarespaceEventsAdapter } from "./adapters/squarespace-events";
import { elfsightEventsAdapter } from "./adapters/elfsight-events";
import { trusteesAdapter } from "./adapters/trustees";
import { manualRecurringAdapter } from "./adapters/manual-recurring";
import { manualOneoffAdapter } from "./adapters/manual-oneoff";
import { enrichWithCoordinates } from "./geocode";
import {
  eventsCanonicalPath,
  eventsOutputPath,
  listRegionIds,
  loadRegion,
  sourcesPath,
} from "./region";
import { findTownIn } from "./towns";
import type { Adapter, EventRecord, SourceConfig, SourcesFile } from "./types";
import { nowIso } from "./util";
import { probeSource, shouldAutoApply, type ProbeCandidate } from "./probe";
import { appendHistory, type HistoryRow } from "./source-history";
import {
  ALL_REGIONS_KEY,
  appendIngestHistory,
  type IngestHistoryRow,
} from "./ingest-history";

const ADAPTERS: Record<SourceConfig["adapter"], Adapter> = {
  ical: icalAdapter,
  rss: rssAdapter,
  eventbrite: eventbriteAdapter,
  patch: patchAdapter,
  "wordpress-tribe": wordpressTribeAdapter,
  "wordpress-tribe-list": wordpressTribeListAdapter,
  "wordpress-mc": wordpressMcAdapter,
  "wordpress-mec": wordpressMecAdapter,
  "squarespace-events": squarespaceEventsAdapter,
  "elfsight-events": elfsightEventsAdapter,
  trustees: trusteesAdapter,
  "manual-recurring": manualRecurringAdapter,
  "manual-oneoff": manualOneoffAdapter,
  "html-generic": htmlGenericAdapter,
};

export type IngestOptions = {
  rootDir: string;
  onlySourceId?: string;
  dryRun?: boolean;
  /** Region to ingest. Defaults to the REGION env var (or "metrowest"). */
  regionId?: string;
};

export type SourceReport = {
  sourceId: string;
  sourceName: string;
  count: number;
  warnings: string[];
  error?: string;
  /** Probe findings when initial count was ≤1. */
  probe?: {
    candidates: ProbeCandidate[];
    autoApplied?: {
      from: { adapter: string; url: string; config?: Record<string, unknown> };
      to: { adapter: string; url: string; config?: Record<string, unknown> };
      reason: string;
      newCount: number;
    };
  };
};

export type IngestReport = {
  startedAt: string;
  finishedAt: string;
  regionId: string;
  totalEvents: number;
  droppedOutsideRegion?: number;
  droppedClosure?: number;
  autoFixes?: number;
  perSource: SourceReport[];
  geocode?: { attempted: number; resolved: number; cacheHits: number; failed: number };
  outputPath?: string;
  dryRun: boolean;
};

export type RegionManifestEntry = {
  id: string;
  displayName: string;
  tagline?: string;
  defaultCenter: { label: string; lat: number; lon: number };
  defaultRadiusMi: number;
  timeZone: string;
  locale: string;
  language: string;
  centerSuggestions?: string[];
  eventCount: number;
  eventsPath: string;
  generatedAt: string;
};

export type AllRegionsReport = {
  startedAt: string;
  finishedAt: string;
  defaultRegionId: string;
  regions: RegionManifestEntry[];
  perRegion: IngestReport[];
};

export async function loadSources(
  rootDir: string,
  regionId?: string,
): Promise<SourcesFile> {
  const region = loadRegion(rootDir, regionId);
  const raw = await readFile(sourcesPath(region), "utf8");
  return JSON.parse(raw) as SourcesFile;
}

export async function runIngest(opts: IngestOptions): Promise<IngestReport> {
  const startedAt = nowIso();
  const region = loadRegion(opts.rootDir, opts.regionId);
  const { sources } = await loadSources(opts.rootDir, opts.regionId);

  const enabled = sources.filter((s) => {
    if (opts.onlySourceId) return s.id === opts.onlySourceId;
    return s.enabled;
  });

  if (opts.onlySourceId && enabled.length === 0) {
    throw new Error(`No source with id "${opts.onlySourceId}" found.`);
  }

  const perSource: SourceReport[] = [];
  const allEvents: EventRecord[] = [];
  // Auto-applied probe fixes get written back to sources.json once at the end.
  const fixedSources = new Map<string, SourceConfig>();
  // History rows accumulated for this ingest run; written to
  // public/source-history.jsonl after the loop.
  const historyRows: HistoryRow[] = [];
  const runStartedAt = new Date().toISOString();

  for (const source of enabled) {
    const adapter = ADAPTERS[source.adapter];
    if (!adapter) {
      perSource.push({
        sourceId: source.id,
        sourceName: source.name,
        count: 0,
        warnings: [],
        error: `Unknown adapter: ${source.adapter}`,
      });
      historyRows.push({
        ts: runStartedAt,
        regionId: region.config.id,
        sourceId: source.id,
        adapter: source.adapter,
        url: source.url,
        count: 0,
        error: `Unknown adapter: ${source.adapter}`,
      });
      continue;
    }
    let activeSource = source;
    let result;
    try {
      result = await adapter({ source: activeSource, fetch, regionId: region.config.id });
    } catch (err) {
      const errMsg = (err as Error).message;
      perSource.push({
        sourceId: source.id,
        sourceName: source.name,
        count: 0,
        warnings: [],
        error: errMsg,
      });
      historyRows.push({
        ts: runStartedAt,
        regionId: region.config.id,
        sourceId: source.id,
        adapter: source.adapter,
        url: source.url,
        count: 0,
        error: errMsg,
      });
      continue;
    }

    // Low-yield probe: if we got ≤1 events, look for a better config.
    let probe: SourceReport["probe"];
    if (result.events.length <= 1) {
      console.log(
        `[ingest] ${source.id}: low yield (${result.events.length}), running probe...`,
      );
      const candidates = await probeSource(activeSource);
      probe = { candidates };
      const best = candidates[0];
      if (best && shouldAutoApply(best, result.events.length)) {
        console.log(
          `[ingest] ${source.id}: auto-applying ${best.adapter} @ ${best.url} (${best.verifiedCount} events)`,
        );
        const newAdapterFn = ADAPTERS[best.adapter];
        if (newAdapterFn) {
          const fixedSource: SourceConfig = {
            ...activeSource,
            adapter: best.adapter,
            url: best.url,
            config: best.config ?? activeSource.config,
            notes: appendAutoFixNote(activeSource.notes, best),
          };
          try {
            const fixedResult = await newAdapterFn({
              source: fixedSource,
              fetch,
              regionId: region.config.id,
            });
            if (fixedResult.events.length > result.events.length) {
              probe.autoApplied = {
                from: {
                  adapter: activeSource.adapter,
                  url: activeSource.url,
                  config: activeSource.config,
                },
                to: {
                  adapter: fixedSource.adapter,
                  url: fixedSource.url,
                  config: fixedSource.config,
                },
                reason: best.evidence,
                newCount: fixedResult.events.length,
              };
              result = fixedResult;
              activeSource = fixedSource;
              fixedSources.set(source.id, fixedSource);
            }
          } catch (err) {
            probe.candidates.unshift({
              ...best,
              confidence: "low",
              evidence: `${best.evidence} (auto-apply failed: ${(err as Error).message})`,
            });
          }
        }
      }
    }

    allEvents.push(...result.events);
    perSource.push({
      sourceId: source.id,
      sourceName: source.name,
      count: result.events.length,
      warnings: result.warnings ?? [],
      probe,
    });
    historyRows.push({
      ts: runStartedAt,
      regionId: region.config.id,
      sourceId: source.id,
      adapter: activeSource.adapter,
      url: activeSource.url,
      count: result.events.length,
      ...(result.warnings && result.warnings.length > 0
        ? { warnings: result.warnings.slice(0, 5).map((w) => w.slice(0, 200)) }
        : {}),
    });
  }

  // Persist the per-source history (one row per source per ingest) so the
  // QC dashboard can show trends + spot the day a venue's count crashed.
  if (!opts.dryRun && historyRows.length > 0) {
    try {
      await appendHistory(opts.rootDir, historyRows);
    } catch (err) {
      console.warn(`[ingest] history write failed: ${(err as Error).message}`);
    }
  }

  // Persist any auto-applied fixes back to sources.json so the cron's commit
  // step picks them up. Skip during dry-run / single-source runs.
  if (!opts.dryRun && !opts.onlySourceId && fixedSources.size > 0) {
    const fullFile = await loadSources(opts.rootDir, opts.regionId);
    const next: SourcesFile = {
      ...fullFile,
      sources: fullFile.sources.map((s) => fixedSources.get(s.id) ?? s),
    };
    await writeFile(
      sourcesPath(region),
      JSON.stringify(next, null, 2) + "\n",
      "utf8",
    );
    console.log(
      `[ingest] ${region.config.id}: auto-applied probe fixes to ${fixedSources.size} source(s); wrote sources.json`,
    );
  }

  // Drop non-public entries (venue closures + private bookings) before
  // anything else sees them. These aren't events — they're status markers
  // venues drop into their public calendars (Joe Pop's, town halls,
  // Wellfleet Preservation Hall, etc.).
  const beforeFilter = allEvents.length;
  const publicEvents = allEvents.filter((ev) => !isNonPublicEntry(ev.title));
  const droppedClosure = beforeFilter - publicEvents.length;
  if (droppedClosure > 0) {
    console.log(
      `[ingest] ${region.config.id}: dropped ${droppedClosure} non-public entry/entries (closures + private bookings)`,
    );
  }

  const deduped = dedupe(publicEvents);
  deduped.sort((a, b) => a.start.localeCompare(b.start));

  // Geocode venue addresses so distance filtering works for any region.
  // Cached on disk, rate-limited to be polite to Nominatim. Pass the active
  // region so multi-region sweeps each use their own bias/cache, instead of
  // defaulting to the REGION env var (which is always 'metrowest' in cron).
  const geocodeReport = await enrichWithCoordinates(
    deduped,
    opts.rootDir,
    region.config.id,
  );

  // Restrict events to the active region. Two complementary checks:
  //
  //   1. If an event has coordinates, they must fall inside the region's
  //      bounding box. Catches geocoded outliers (Trustees properties on
  //      Hingham, Cape Ann, etc.).
  //
  //   2. If an event has no coordinates but DOES have a town string, the
  //      town must be in the region's known-town index (towns.json + aliases).
  //      Catches events whose addresses couldn't geocode under the regional
  //      bias — e.g. "Hamilton & Ipswich" or "Edgartown" for Outer Cape.
  //
  // Events with neither coords nor a town pass through (we don't have enough
  // info to decide). Regions with no towns.json + no boundingBox also pass
  // everything through.
  let droppedOutsideRegion = 0;
  const box = region.config.boundingBox;
  const hasTownIndex = region.townIndex.list.length > 0;
  const filteredEvents = deduped.filter((ev) => {
    const lat = ev.location?.lat;
    const lon = ev.location?.lon;
    if (lat != null && lon != null) {
      if (!box) return true;
      const inside =
        lat >= box.minLat &&
        lat <= box.maxLat &&
        lon >= box.minLon &&
        lon <= box.maxLon;
      if (!inside) droppedOutsideRegion++;
      return inside;
    }
    // No coords: check town against the region's index.
    const town = ev.location?.town?.trim();
    if (!town || !hasTownIndex) return true;
    const known = findTownIn(region.townIndex, town) !== undefined;
    if (!known) droppedOutsideRegion++;
    return known;
  });
  if (droppedOutsideRegion > 0) {
    console.log(
      `[ingest] ${region.config.id}: dropped ${droppedOutsideRegion} events outside region`,
    );
  }

  let outputPath: string | undefined;
  if (!opts.dryRun) {
    await mkdir(path.join(opts.rootDir, "public"), { recursive: true });
    outputPath = eventsOutputPath(region);
    const payload = {
      region: {
        id: region.config.id,
        displayName: region.config.displayName,
        tagline: region.config.tagline,
        defaultCenter: region.config.defaultCenter,
        defaultRadiusMi: region.config.defaultRadiusMi,
        timeZone: region.config.timeZone,
        locale: region.config.locale,
        language: region.config.language,
        centerSuggestions: region.config.centerSuggestions,
      },
      generatedAt: nowIso(),
      count: filteredEvents.length,
      events: filteredEvents,
    };
    const serialized = JSON.stringify(payload, null, 2) + "\n";
    await writeFile(outputPath, serialized, "utf8");
    // For backwards compatibility, also write the default region to events.json
    // (the canonical path the page used to read).
    if (region.config.id === (process.env.REGION?.trim() || "metrowest")) {
      await writeFile(eventsCanonicalPath(region), serialized, "utf8");
    }
  }

  return {
    startedAt,
    finishedAt: nowIso(),
    regionId: region.config.id,
    totalEvents: filteredEvents.length,
    droppedOutsideRegion,
    droppedClosure,
    autoFixes: fixedSources.size,
    perSource,
    geocode: geocodeReport,
    outputPath,
    dryRun: !!opts.dryRun,
  };
}

/**
 * Ingest every region under config/regions/ and write a manifest at
 * public/regions.json the client can use to populate a region selector.
 * The first region is the default (REGION env var or "metrowest").
 */
export async function runAllRegions(opts: IngestOptions): Promise<AllRegionsReport> {
  const startedAt = nowIso();
  const ids = listRegionIds(opts.rootDir);
  if (ids.length === 0) {
    throw new Error(`No regions found under ${opts.rootDir}/config/regions/`);
  }

  const perRegion: IngestReport[] = [];
  const manifestEntries: RegionManifestEntry[] = [];

  for (const id of ids) {
    const report = await runIngest({ ...opts, regionId: id });
    perRegion.push(report);

    const region = loadRegion(opts.rootDir, id);
    const cfg = region.config;
    manifestEntries.push({
      id: cfg.id,
      displayName: cfg.displayName,
      tagline: cfg.tagline,
      defaultCenter: cfg.defaultCenter,
      defaultRadiusMi: cfg.defaultRadiusMi,
      timeZone: cfg.timeZone,
      locale: cfg.locale,
      language: cfg.language,
      centerSuggestions: cfg.centerSuggestions,
      eventCount: report.totalEvents,
      eventsPath: `/events.${cfg.id}.json`,
      generatedAt: report.finishedAt,
    });
  }

  if (!opts.dryRun) {
    await mkdir(path.join(opts.rootDir, "public"), { recursive: true });
    const manifest = {
      generatedAt: nowIso(),
      defaultRegionId: ids[0],
      regions: manifestEntries,
    };
    await writeFile(
      path.join(opts.rootDir, "public", "regions.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8",
    );

    // Source-health snapshot so the /sources page can surface low-yield + probe
    // findings without re-running the ingest. Only includes sources whose
    // initial yield was ≤1 (i.e. those the probe actually evaluated).
    const health: Record<
      string,
      { count: number; warnings: string[]; probe?: SourceReport["probe"] }
    > = {};
    for (const report of perRegion) {
      for (const s of report.perSource) {
        if (s.count <= 1 || s.probe) {
          health[`${report.regionId}:${s.sourceId}`] = {
            count: s.count,
            warnings: s.warnings,
            probe: s.probe,
          };
        }
      }
    }
    await writeFile(
      path.join(opts.rootDir, "public", "source-health.json"),
      JSON.stringify({ generatedAt: nowIso(), sources: health }, null, 2) + "\n",
      "utf8",
    );

    // Record per-region + overall duration for /admin/qc trend visibility.
    const overallEnd = Date.now();
    const overallStartMs = new Date(startedAt).getTime();
    const historyRows: IngestHistoryRow[] = perRegion.map((r) => ({
      ts: startedAt,
      regionId: r.regionId,
      durationMs:
        new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime(),
      eventCount: r.totalEvents,
      sourceCount: r.perSource.length,
      dropped: {
        ...(r.droppedClosure ? { closure: r.droppedClosure } : {}),
        ...(r.droppedOutsideRegion ? { outOfRegion: r.droppedOutsideRegion } : {}),
      },
      ...(r.autoFixes ? { autoFixes: r.autoFixes } : {}),
    }));
    historyRows.push({
      ts: startedAt,
      regionId: ALL_REGIONS_KEY,
      durationMs: overallEnd - overallStartMs,
      eventCount: perRegion.reduce((sum, r) => sum + r.totalEvents, 0),
      sourceCount: perRegion.reduce((sum, r) => sum + r.perSource.length, 0),
      dropped: {
        closure: perRegion.reduce((s, r) => s + (r.droppedClosure ?? 0), 0),
        outOfRegion: perRegion.reduce((s, r) => s + (r.droppedOutsideRegion ?? 0), 0),
      },
      autoFixes: perRegion.reduce((s, r) => s + (r.autoFixes ?? 0), 0),
    });
    try {
      await appendIngestHistory(opts.rootDir, historyRows);
    } catch (err) {
      console.warn(`[ingest] timing-history write failed: ${(err as Error).message}`);
    }
  }

  return {
    startedAt,
    finishedAt: nowIso(),
    defaultRegionId: ids[0],
    regions: manifestEntries,
    perRegion,
  };
}

/**
 * Recognize non-public entries that shouldn't appear in the events feed:
 * venue-closure announcements ("Closed Today", "Town Hall Closed") and
 * private-booking entries ("Private Event", "Private Party"). Match
 * patterns observed across sources:
 *
 *   Closures:
 *     "Closed" / "CLOSED"
 *     "Closed Today" / "Closed for Thanksgiving" / "Closed for the Season"
 *     "Closed for a Private Event" / "CLOSED for Memorial Day"
 *     "Bistro Closed?"
 *     "Town Hall Closed - Memorial Day 2026"
 *   Private bookings:
 *     "Private Event" / "Private Party" / "Private booking"
 *
 * Errs on the side of NOT dropping unless the title is clearly non-public.
 * A legitimate event with a coincidental match (e.g. "Private Lives of
 * Saints") would be wrongly dropped, but the corpus doesn't currently
 * contain any such cases.
 */
function isNonPublicEntry(title: string): boolean {
  const t = title.trim().toLowerCase();
  if (!t) return false;
  // 1. Title begins with "closed" as a whole word — catches most cases:
  //    "Closed", "Closed Today", "Closed for ___", "CLOSED for ___"
  if (/^closed\b/.test(t)) return true;
  // 2. "<venue noun> closed" — catches "Town Hall Closed", "Bistro Closed"
  //    anywhere in the title.
  if (
    /\b(town\s*hall|bistro|library|office|restaurant|store|shop|gallery|museum)\s+closed\b/.test(
      t,
    )
  )
    return true;
  // 3. Title ends with "closed" (with optional punctuation).
  if (/\bclosed\s*[?!.]?\s*$/.test(t)) return true;
  // 4. Private bookings — "Private Event", "Private Party", etc.
  if (/^private\s+(event|party|booking|function|rental)\b/.test(t)) return true;
  return false;
}

function appendAutoFixNote(notes: string | undefined, c: ProbeCandidate): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const line = `[auto-fix ${stamp}] ${c.evidence}`;
  return notes ? `${notes}\n${line}` : line;
}

function dedupe(events: EventRecord[]): EventRecord[] {
  const byId = new Map<string, EventRecord>();
  for (const ev of events) {
    if (!byId.has(ev.id)) byId.set(ev.id, ev);
  }
  // Secondary dedupe: same title + start + (town or venue) often indicates a cross-posted
  // event (e.g. Patch shares one event across multiple town calendars). Keep first seen.
  const byNatural = new Map<string, EventRecord>();
  for (const ev of byId.values()) {
    const place = (ev.location?.venue ?? ev.location?.town ?? "").toLowerCase().trim();
    const key = `${ev.title.toLowerCase().trim()}::${ev.start}::${place}`;
    if (!byNatural.has(key)) byNatural.set(key, ev);
  }
  return [...byNatural.values()];
}
