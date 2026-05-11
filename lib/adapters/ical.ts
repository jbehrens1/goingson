import nodeIcal from "node-ical";
import type { Adapter, AdapterResult } from "../types";
import { buildEvent, politeFetch, toIsoOrUndefined } from "../util";

export const icalAdapter: Adapter = async ({ source }): Promise<AdapterResult> => {
  const warnings: string[] = [];
  const res = await politeFetch(source.url);
  if (!res.ok) {
    return { events: [], warnings: [`HTTP ${res.status} fetching ${source.url}`] };
  }
  const text = await res.text();

  let parsed: Record<string, nodeIcal.CalendarComponent>;
  try {
    parsed = nodeIcal.sync.parseICS(text);
  } catch (err) {
    return { events: [], warnings: [`iCal parse failed: ${(err as Error).message}`] };
  }

  const events = Object.values(parsed)
    .filter((c): c is nodeIcal.VEvent => c.type === "VEVENT")
    .map((vev) => {
      const start = toIsoOrUndefined(vev.start);
      if (!start) {
        warnings.push(`Skipping event without start: ${vev.summary ?? vev.uid}`);
        return null;
      }
      const url = (typeof vev.url === "string" ? vev.url : undefined) ?? source.url;
      const naturalKey = vev.uid ?? `${vev.summary}::${start}`;
      return buildEvent(source, {
        naturalKey,
        title: String(vev.summary ?? "Untitled event"),
        description: typeof vev.description === "string" ? vev.description : undefined,
        url,
        start,
        end: toIsoOrUndefined(vev.end),
        allDay: vev.datetype === "date",
        location: vev.location
          ? { venue: String(vev.location), town: source.town }
          : source.town
            ? { town: source.town }
            : undefined,
      });
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  return { events, warnings };
};
