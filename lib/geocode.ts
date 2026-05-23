import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { EventRecord } from "./types";
import { loadRegion } from "./region";
import { findTownIn } from "./towns";

type CacheEntry = {
  lat: number | null;
  lon: number | null;
  displayName?: string;
  fetchedAt: string;
};

type Cache = Record<string, CacheEntry>;

const NOMINATIM = "https://nominatim.openstreetmap.org";
const RATE_LIMIT_MS = 1100; // Nominatim ToS = max 1 req/sec; we go 1.1s to be safe.
const USER_AGENT =
  "metrowest-events/0.1 (+https://github.com/jbehrens/metrowest-events) - personal aggregator";

let lastRequestAt = 0;
async function rateLimit() {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - elapsed));
  }
  lastRequestAt = Date.now();
}

function cachePath(rootDir: string): string {
  return path.join(rootDir, "data", "geocode-cache.json");
}

async function readCache(rootDir: string): Promise<Cache> {
  try {
    const raw = await readFile(cachePath(rootDir), "utf8");
    return JSON.parse(raw) as Cache;
  } catch {
    return {};
  }
}

async function writeCache(rootDir: string, cache: Cache): Promise<void> {
  // Filesystem is read-only on serverless hosts (Vercel/Cloudflare). Cache
  // writes happen during local dev + the GitHub Actions ingest step where the
  // result lands in git. Silently swallow failures at runtime in production
  // so user-triggered geocode lookups still succeed (they just don't cache).
  try {
    await mkdir(path.join(rootDir, "data"), { recursive: true });
    await writeFile(cachePath(rootDir), JSON.stringify(cache, null, 2) + "\n", "utf8");
  } catch (err) {
    if (process.env.VERBOSE_GEOCODE_ERRORS) {
      console.warn(`[geocode] cache write failed: ${(err as Error).message}`);
    }
  }
}

function normalizeQuery(q: string): string {
  return q.replace(/\s+/g, " ").trim().toLowerCase();
}

export type GeocodeOptions = {
  rootDir?: string;
  // Bias geocoding toward a region's bounding box for ambiguous queries.
  // Without this, "Wellesley" could resolve to Wellesley, UK.
  applyRegionBias?: boolean;
  // Region to use for bias + cache key. Defaults to whatever loadRegion()
  // returns (i.e. REGION env var). Pass this explicitly when ingesting one
  // region as part of a multi-region sweep, so each region geocodes against
  // its own bounding box rather than the env-var default.
  regionId?: string;
};

export type GeocodeResult = {
  lat: number;
  lon: number;
  displayName?: string;
  cached: boolean;
};

export async function geocode(
  query: string,
  opts: GeocodeOptions = {},
): Promise<GeocodeResult | null> {
  const rootDir = opts.rootDir ?? process.cwd();
  const region = (() => {
    try {
      return loadRegion(rootDir, opts.regionId);
    } catch {
      return null;
    }
  })();
  const applyBias = opts.applyRegionBias !== false && !!region?.config.boundingBox;

  const norm = normalizeQuery(query);
  if (!norm) return null;
  const cacheKey = applyBias ? `${region!.config.id}::${norm}` : norm;

  const cache = await readCache(rootDir);
  const hit = cache[cacheKey];
  if (hit) {
    if (hit.lat == null || hit.lon == null) return null;
    return { lat: hit.lat, lon: hit.lon, displayName: hit.displayName, cached: true };
  }

  await rateLimit();
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "1",
    addressdetails: "0",
  });
  if (applyBias && region?.config.boundingBox) {
    const b = region.config.boundingBox;
    params.set("viewbox", `${b.minLon},${b.maxLat},${b.maxLon},${b.minLat}`);
    params.set("bounded", "1");
  }
  type NomResult = { lat: string; lon: string; display_name?: string };
  let result: NomResult[] | null = null;
  try {
    const res = await fetch(`${NOMINATIM}/search?${params}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (res.ok) {
      result = (await res.json()) as NomResult[];
    }
  } catch {
    // Treat network errors as cache miss without negative caching.
    return null;
  }

  if (!result || result.length === 0) {
    cache[cacheKey] = { lat: null, lon: null, fetchedAt: new Date().toISOString() };
    await writeCache(rootDir, cache);
    return null;
  }

  const first = result[0];
  const lat = parseFloat(first.lat);
  const lon = parseFloat(first.lon);
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    cache[cacheKey] = { lat: null, lon: null, fetchedAt: new Date().toISOString() };
    await writeCache(rootDir, cache);
    return null;
  }
  cache[cacheKey] = {
    lat,
    lon,
    displayName: first.display_name,
    fetchedAt: new Date().toISOString(),
  };
  await writeCache(rootDir, cache);
  return { lat, lon, displayName: first.display_name, cached: false };
}

function eventQueries(ev: EventRecord): string[] {
  // Yield queries in order of specificity. Caller stops at first hit.
  const loc = ev.location;
  if (!loc) return [];
  const queries: string[] = [];
  if (loc.address) queries.push(loc.address);
  if (loc.venue && loc.town) queries.push(`${loc.venue}, ${loc.town}`);
  if (loc.town) queries.push(loc.town);
  return queries;
}

export async function enrichWithCoordinates(
  events: EventRecord[],
  rootDir: string,
  regionId?: string,
): Promise<{ attempted: number; resolved: number; cacheHits: number; failed: number }> {
  const region = (() => {
    try {
      return loadRegion(rootDir, regionId);
    } catch {
      return null;
    }
  })();

  let attempted = 0;
  let resolved = 0;
  let cacheHits = 0;
  let failed = 0;
  for (const ev of events) {
    if (ev.location?.lat != null && ev.location?.lon != null) continue;
    const queries = eventQueries(ev);
    if (queries.length === 0) {
      failed++;
      continue;
    }
    attempted++;

    // If the event's town is one of the region's known towns, use that town's
    // centroid directly (no Nominatim call needed) AND apply regional bias for
    // any street-level lookups. If the town is OUT of region (Hingham from
    // MetroWest, Nantucket from anywhere we care about), skip bias so we get
    // the *actual* coords back instead of a bogus in-box street match —
    // the downstream bounding-box filter then correctly drops it.
    const evTown = ev.location?.town?.trim();
    const knownTown = region && evTown ? findTownIn(region.townIndex, evTown) : undefined;
    const useBias = knownTown !== undefined || !evTown;

    let r: GeocodeResult | null = null;
    for (const q of queries) {
      // Shortcut: if the query exactly matches a region town, use its centroid.
      const t = region ? findTownIn(region.townIndex, q.trim()) : undefined;
      if (t) {
        r = { lat: t.lat, lon: t.lon, displayName: t.name, cached: true };
        break;
      }
      r = await geocode(q, { rootDir, applyRegionBias: useBias, regionId });
      if (r) break;
    }
    if (r) {
      ev.location = { ...ev.location, lat: r.lat, lon: r.lon };
      resolved++;
      if (r.cached) cacheHits++;
    } else {
      failed++;
    }
  }
  return { attempted, resolved, cacheHits, failed };
}
