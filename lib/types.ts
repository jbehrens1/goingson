export type AdapterType =
  | "ical"
  | "rss"
  | "eventbrite"
  | "patch"
  | "wordpress-tribe"
  | "wordpress-mc"
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
};

export type Adapter = (ctx: AdapterContext) => Promise<AdapterResult>;
