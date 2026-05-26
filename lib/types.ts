export type AdapterType =
  | "ical"
  | "rss"
  | "eventbrite"
  | "patch"
  | "wordpress-tribe"
  | "wordpress-tribe-list"
  | "wordpress-mc"
  | "wordpress-mec"
  | "wordpress-geodir"
  | "beehiiv-lowdown"
  | "squarespace-events"
  | "elfsight-events"
  | "trustees"
  | "manual-recurring"
  | "manual-oneoff"
  | "html-generic";

export type SourceConfig = {
  id: string;
  name: string;
  enabled: boolean;
  adapter: AdapterType;
  url: string;
  town?: string;
  category?: string;
  notes?: string;
  config?: Record<string, unknown>;
  /** Fallback event type applied when categorize() can't classify the title
   *  (i.e. would return "other"). Useful for venue sources whose events are
   *  just band names — set to "live-music" and we tag them correctly without
   *  needing a list of band names in the rules. */
  defaultEventType?: import("./categorize").EventType;
  /** Source-specific title overrides applied BEFORE the global categorize()
   *  regex. First match wins. Use when a venue has a recurring program whose
   *  title doesn't match (or mismatches) the global rules — e.g. Surf City
   *  Hotel's "Trivia on Tap" should be community, not live-music.
   *  pattern is a case-insensitive JS regex source string. */
  titleRules?: Array<{
    pattern: string;
    type: import("./categorize").EventType;
  }>;
};

export type SourcesFile = {
  $comment?: string;
  sources: SourceConfig[];
};

export type EventLocation = {
  venue?: string;
  town?: string;
  address?: string;
  lat?: number;
  lon?: number;
};

export type EventRecord = {
  id: string;
  title: string;
  description?: string;
  url: string;
  start: string;
  end?: string;
  allDay?: boolean;
  location?: EventLocation;
  source: { id: string; name: string };
  categories?: string[];
  type: import("./categorize").EventType;
  imageUrl?: string;
  ingestedAt: string;
};

export type AdapterResult = {
  events: EventRecord[];
  warnings?: string[];
};

export type AdapterContext = {
  source: SourceConfig;
  fetch: typeof fetch;
  /** Active region id. Adapters that read region-local files (manual-oneoff,
   *  manual-recurring) need this to find the right region directory when
   *  multiple regions are being swept in one ingest run. */
  regionId?: string;
};

export type Adapter = (ctx: AdapterContext) => Promise<AdapterResult>;
