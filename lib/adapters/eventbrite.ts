import type { Adapter, AdapterResult } from "../types";
import { buildEvent } from "../util";

type EventbriteEvent = {
  id: string;
  name: { text: string };
  description?: { text?: string };
  url: string;
  start: { utc: string };
  end?: { utc: string };
  venue?: { name?: string; address?: { city?: string; localized_address_display?: string } };
  logo?: { url?: string };
};

type EventbriteSourceConfig = {
  organizerId?: string;
  location?: string;
  withinMiles?: number;
};

export const eventbriteAdapter: Adapter = async ({ source }): Promise<AdapterResult> => {
  const token = process.env.EVENTBRITE_TOKEN;
  if (!token) {
    return {
      events: [],
      warnings: [
        "EVENTBRITE_TOKEN not set — skipping. Set it in .env.local or Actions secrets.",
      ],
    };
  }

  const cfg = (source.config ?? {}) as EventbriteSourceConfig;
  let endpoint: string;

  if (cfg.organizerId) {
    endpoint = `https://www.eventbriteapi.com/v3/organizers/${cfg.organizerId}/events/?status=live&order_by=start_asc&expand=venue,logo`;
  } else {
    return {
      events: [],
      warnings: [
        "Eventbrite public Search was restricted ~2020. Add `organizerId` to source config, or implement a workaround.",
      ],
    };
  }

  const res = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    return { events: [], warnings: [`Eventbrite HTTP ${res.status}: ${await res.text()}`] };
  }
  const json = (await res.json()) as { events?: EventbriteEvent[] };
  const items = json.events ?? [];

  const events = items.map((ev) =>
    buildEvent(source, {
      naturalKey: ev.id,
      title: ev.name.text,
      description: ev.description?.text,
      url: ev.url,
      start: ev.start.utc,
      end: ev.end?.utc,
      location: ev.venue
        ? {
            venue: ev.venue.name,
            town: source.town,
            address: ev.venue.address?.localized_address_display,
          }
        : source.town
          ? { town: source.town }
          : undefined,
      imageUrl: ev.logo?.url,
    }),
  );

  return { events };
};
