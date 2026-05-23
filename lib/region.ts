import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { buildTownIndex, type TownCoord, type TownIndex } from "./towns";

export type RegionConfig = {
  id: string;
  displayName: string;
  tagline?: string;
  defaultCenter: { label: string; lat: number; lon: number };
  defaultRadiusMi: number;
  timeZone: string;
  locale: string;
  language: string;
  boundingBox?: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  centerSuggestions?: string[];
};

export type VenueAlias = {
  name: string;
  fullName?: string;
  aliases?: string[];
};

export type LoadedRegion = {
  config: RegionConfig;
  towns: TownCoord[];
  townIndex: TownIndex;
  venueAliases: Map<string, string>;
  rootDir: string;
  regionDir: string;
};

const cacheByKey = new Map<string, LoadedRegion>();

export function regionId(): string {
  return process.env.REGION?.trim() || "metrowest";
}

/**
 * Enumerate every region defined under config/regions/.
 * Sort with the default region first so single-region consumers stay stable.
 */
export function listRegionIds(rootDir: string = process.cwd()): string[] {
  const regionsDir = path.join(rootDir, "config", "regions");
  if (!existsSync(regionsDir)) return [];
  const ids: string[] = [];
  for (const entry of readdirSync(regionsDir)) {
    const full = path.join(regionsDir, entry);
    if (statSync(full).isDirectory() && existsSync(path.join(full, "region.json"))) {
      ids.push(entry);
    }
  }
  const def = regionId();
  ids.sort((a, b) => (a === def ? -1 : b === def ? 1 : a.localeCompare(b)));
  return ids;
}

export function loadRegion(
  rootDir: string = process.cwd(),
  id: string = regionId(),
): LoadedRegion {
  const key = `${rootDir}::${id}`;
  const hit = cacheByKey.get(key);
  if (hit) return hit;
  const regionDir = path.join(rootDir, "config", "regions", id);
  const configPath = path.join(regionDir, "region.json");
  if (!existsSync(configPath)) {
    throw new Error(
      `Region "${id}" not found at ${configPath}. Set REGION env var or create the directory.`,
    );
  }
  const config = JSON.parse(readFileSync(configPath, "utf8")) as RegionConfig;

  let towns: TownCoord[] = [];
  const townsPath = path.join(regionDir, "towns.json");
  if (existsSync(townsPath)) {
    const parsed = JSON.parse(readFileSync(townsPath, "utf8")) as
      | { towns?: TownCoord[] }
      | TownCoord[];
    towns = Array.isArray(parsed) ? parsed : (parsed.towns ?? []);
  }
  const townIndex = buildTownIndex(towns);

  // Venue aliases: optional config/regions/<id>/venues.json. Each entry maps
  // a canonical venue name to its known variants.
  const venueAliases = new Map<string, string>();
  const venuesPath = path.join(regionDir, "venues.json");
  if (existsSync(venuesPath)) {
    const parsed = JSON.parse(readFileSync(venuesPath, "utf8")) as
      | { venues?: VenueAlias[] }
      | VenueAlias[];
    const list = Array.isArray(parsed) ? parsed : (parsed.venues ?? []);
    for (const v of list) {
      venueAliases.set(v.name.trim().toLowerCase(), v.name);
      if (v.fullName) venueAliases.set(v.fullName.trim().toLowerCase(), v.name);
      for (const a of v.aliases ?? []) {
        venueAliases.set(a.trim().toLowerCase(), v.name);
      }
    }
  }

  const loaded: LoadedRegion = { config, towns, townIndex, venueAliases, rootDir, regionDir };
  cacheByKey.set(key, loaded);
  return loaded;
}

export function sourcesPath(region: LoadedRegion): string {
  return path.join(region.regionDir, "sources.json");
}

export function eventsOutputPath(region: LoadedRegion): string {
  // Public file the page reads. Per-region keeps multi-region deploys clean.
  return path.join(region.rootDir, "public", `events.${region.config.id}.json`);
}

// Public symlink/copy path that the page always reads. Set by the ingest step.
export function eventsCanonicalPath(region: LoadedRegion): string {
  return path.join(region.rootDir, "public", "events.json");
}
