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
import type { Adapter, EventRecord, SourceConfig, SourcesFile } from "./types";
import { nowIso } from "./util";

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
};

export type IngestReport = {
  startedAt: string;
  finishedAt: string;
  regionId: string;
  totalEvents: number;
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
      continue;
    }
    try {
      const result = await adapter({ source, fetch });
      allEvents.push(...result.events);
      perSource.push({
        sourceId: source.id,
        sourceName: source.name,
        count: result.events.length,
        warnings: result.warnings ?? [],
      });
    } catch (err) {
      perSource.push({
        sourceId: source.id,
        sourceName: source.name,
        count: 0,
        warnings: [],
        error: (err as Error).message,
      });
    }
  }

  const deduped = dedupe(allEvents);
  deduped.sort((a, b) => a.start.localeCompare(b.start));

  // Geocode venue addresses so distance filtering works for any region.
  // Cached on disk, rate-limited to be polite to Nominatim.
  const geocodeReport = await enrichWithCoordinates(deduped, opts.rootDir);

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
      count: deduped.length,
      events: deduped,
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
    totalEvents: deduped.length,
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
  }

  return {
    startedAt,
    finishedAt: nowIso(),
    defaultRegionId: ids[0],
    regions: manifestEntries,
    perRegion,
  };
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
