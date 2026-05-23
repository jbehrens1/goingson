import { readFile } from "node:fs/promises";
import path from "node:path";
import EventsView, { type EventsPayload, type RegionsManifest } from "./EventsView";

export const dynamic = "force-dynamic";

async function loadEventsForRegion(regionId: string): Promise<EventsPayload> {
  const filePath = path.join(process.cwd(), "public", `events.${regionId}.json`);
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as EventsPayload;
}

async function loadManifest(): Promise<RegionsManifest> {
  const filePath = path.join(process.cwd(), "public", "regions.json");
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as RegionsManifest;
  } catch {
    // No manifest yet — fall back to single-region mode using events.json directly.
    const events = await readFile(path.join(process.cwd(), "public", "events.json"), "utf8");
    const parsed = JSON.parse(events);
    const r = parsed.region;
    return {
      generatedAt: parsed.generatedAt ?? new Date().toISOString(),
      defaultRegionId: r?.id ?? "metrowest",
      regions: r
        ? [
            {
              id: r.id,
              displayName: r.displayName,
              tagline: r.tagline,
              defaultCenter: r.defaultCenter,
              defaultRadiusMi: r.defaultRadiusMi,
              timeZone: r.timeZone,
              locale: r.locale,
              language: r.language,
              centerSuggestions: r.centerSuggestions,
              eventCount: parsed.count ?? 0,
              eventsPath: `/events.${r.id}.json`,
              generatedAt: parsed.generatedAt,
            },
          ]
        : [],
    };
  }
}

function canRefresh(): boolean {
  return !(
    process.env.VERCEL === "1" ||
    process.env.CF_PAGES === "1" ||
    process.env.READONLY === "1"
  );
}

export default async function Home() {
  const manifest = await loadManifest();
  const initial = await loadEventsForRegion(manifest.defaultRegionId);
  return (
    <EventsView initial={initial} manifest={manifest} canRefresh={canRefresh()} />
  );
}
