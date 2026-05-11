// Pure helpers for town coordinate lookups + great-circle distance.
// Town data lives in `config/regions/<region>/towns.json` and is loaded by
// lib/region.ts at startup. This file deliberately holds no hardcoded list so
// that the same helpers work for any region.

export type TownCoord = {
  name: string;
  lat: number;
  lon: number;
  aliases?: string[];
};

export type TownIndex = {
  list: TownCoord[];
  byKey: Map<string, TownCoord>;
  pattern: RegExp | null;
  namesAndAliases: string[];
};

export function buildTownIndex(towns: TownCoord[]): TownIndex {
  const byKey = new Map<string, TownCoord>();
  for (const t of towns) {
    byKey.set(t.name.toLowerCase(), t);
    for (const alias of t.aliases ?? []) byKey.set(alias.toLowerCase(), t);
  }
  const namesAndAliases = towns.flatMap((t) => [t.name, ...(t.aliases ?? [])]);
  const pattern = namesAndAliases.length
    ? new RegExp(
        `\\b(${namesAndAliases.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
        "i",
      )
    : null;
  return { list: towns, byKey, pattern, namesAndAliases };
}

export function findTownIn(
  index: TownIndex,
  name: string | undefined | null,
): TownCoord | undefined {
  if (!name) return undefined;
  return index.byKey.get(name.trim().toLowerCase());
}

export function extractTownInText(
  index: TownIndex,
  text: string | undefined,
): string | undefined {
  if (!text || !index.pattern) return undefined;
  const m = text.match(index.pattern);
  if (!m) return undefined;
  return findTownIn(index, m[1])?.name;
}

const R_MI = 3958.8;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function haversineMiles(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_MI * Math.asin(Math.sqrt(x));
}
