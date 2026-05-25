// Adapter for venues using Elfsight's "Events Calendar" widget.
//
// Elfsight is a third-party widget platform popular on Wix/Squarespace/Webflow
// sites. Their boot endpoint returns the full events list as clean JSON — no
// headless browser needed. Discovered on Daddy O LBI; the same widget is used
// on lots of small-venue sites because it's a one-click install in the Wix App
// Market.
//
// To configure a source:
//   adapter: "elfsight-events"
//   url: "https://www.thevenue.com/events"   // the public venue page (for buildEvent.url default)
//   config: {
//     widgetId: "ced2ea9c-538f-4f25-a1c5-5fe1c4387785"
//     pageUrl: "https://www-thevenue-com.filesusr.com/html/<hash>.html"
//     defaultVenue: "The Venue"  // optional override; otherwise pulled from widget locations
//   }
//
// Finding the widget ID: load the venue page in a real browser, open DevTools
// → Network → filter for "core.service.elfsight.com/p/boot", look at the URL.
// The `w=...` query param IS the widget ID. The `page=...` param is the
// pageUrl. Once you have those two, the adapter does the rest.

import type { Adapter, AdapterResult, EventLocation } from "../types";
import { buildEvent, politeFetch } from "../util";

type ElfsightEvent = {
  id: string;
  name: string;
  start: { date: string; time?: string };
  end?: { date: string; time?: string };
  timeZone?: string;
  description?: string;
  image?: { url?: string };
  eventType?: string[];
  location?: string[];
  isAllDay?: boolean;
};

type ElfsightLocation = {
  id: string;
  name?: string;
  address?: string;
};

type ElfsightBoot = {
  status: number;
  data: {
    widgets: Record<
      string,
      {
        status: number;
        data: {
          app?: string;
          settings: {
            events?: ElfsightEvent[];
            locations?: ElfsightLocation[];
          };
        };
      }
    >;
  };
};

type ElfsightConfig = {
  widgetId: string;
  pageUrl: string;
  defaultVenue?: string;
};

const BOOT_BASE = "https://core.service.elfsight.com/p/boot/";

function combineDateTime(date: string, time?: string): string {
  // The widget stores wall-clock time in the venue's timeZone; we serialize
  // as a naive ISO and let the standard categorize/format paths interpret it.
  return time ? `${date}T${time}:00` : `${date}T00:00:00`;
}

export const elfsightEventsAdapter: Adapter = async ({
  source,
}): Promise<AdapterResult> => {
  const warnings: string[] = [];
  const cfg = (source.config ?? {}) as Partial<ElfsightConfig>;
  if (!cfg.widgetId || !cfg.pageUrl) {
    return {
      events: [],
      warnings: ["elfsight-events: config.widgetId and config.pageUrl are required"],
    };
  }

  const url = `${BOOT_BASE}?page=${encodeURIComponent(cfg.pageUrl)}&w=${cfg.widgetId}`;
  const res = await politeFetch(url);
  if (!res.ok) {
    return { events: [], warnings: [`HTTP ${res.status} fetching elfsight boot`] };
  }
  let parsed: ElfsightBoot;
  try {
    parsed = (await res.json()) as ElfsightBoot;
  } catch (err) {
    return {
      events: [],
      warnings: [`elfsight: JSON parse failed: ${(err as Error).message}`],
    };
  }

  const widget = parsed?.data?.widgets?.[cfg.widgetId];
  if (!widget) {
    return { events: [], warnings: [`elfsight: widget ${cfg.widgetId} not in response`] };
  }
  if (widget.data?.app && widget.data.app !== "event-calendar") {
    warnings.push(
      `elfsight: unexpected app type "${widget.data.app}" — expected event-calendar`,
    );
  }
  const settings = widget.data?.settings ?? {};
  const evs = settings.events ?? [];
  const locById = new Map<string, ElfsightLocation>();
  for (const l of settings.locations ?? []) locById.set(l.id, l);

  const events = evs.map((ev) => {
    const start = combineDateTime(ev.start.date, ev.start.time);
    const end = ev.end ? combineDateTime(ev.end.date, ev.end.time) : undefined;

    // Resolve venue + address: prefer admin-configured defaultVenue (so a
    // single venue's events all use the same display string), fall back to
    // the widget's location name, then the source's display name.
    const locRef = ev.location?.[0];
    const locInfo = locRef ? locById.get(locRef) : undefined;
    const venue = cfg.defaultVenue ?? locInfo?.name ?? source.name;
    const address = locInfo?.address;

    const location: EventLocation = {
      venue,
      town: source.town,
      ...(address ? { address } : {}),
    };

    return buildEvent(source, {
      naturalKey: ev.id,
      title: ev.name,
      description: ev.description || undefined,
      url: source.url, // Elfsight events don't have unique URLs; link to the venue page
      start,
      end,
      allDay: ev.isAllDay,
      location,
      imageUrl: ev.image?.url || undefined,
    });
  });

  return { events, warnings };
};
