import type * as cheerio from "cheerio";

type JsonLdNode = Record<string, unknown> & { "@type"?: string | string[]; "@graph"?: unknown[] };

export type JsonLdEvent = {
  name?: string;
  description?: string;
  url?: string;
  startDate?: string;
  endDate?: string;
  image?: string | { url?: string } | Array<string | { url?: string }>;
  location?:
    | string
    | {
        name?: string;
        address?:
          | string
          | { streetAddress?: string; addressLocality?: string; addressRegion?: string };
      };
  identifier?: string;
};

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function isEventNode(node: JsonLdNode): boolean {
  const t = node["@type"];
  if (!t) return false;
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => typeof x === "string" && x.toLowerCase().endsWith("event"));
}

function flatten(nodes: unknown[]): JsonLdNode[] {
  const out: JsonLdNode[] = [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== "object") continue;
    const node = raw as JsonLdNode;
    out.push(node);
    if (Array.isArray(node["@graph"])) out.push(...flatten(node["@graph"]));
  }
  return out;
}

export function extractJsonLdEvents($: cheerio.CheerioAPI): JsonLdEvent[] {
  const events: JsonLdEvent[] = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    const raw = $(el).text().trim();
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const nodes = flatten(asArray(parsed));
    for (const node of nodes) {
      if (isEventNode(node)) events.push(node as unknown as JsonLdEvent);
    }
  });
  return events;
}

export function jsonLdImageUrl(image: JsonLdEvent["image"]): string | undefined {
  if (!image) return undefined;
  if (typeof image === "string") return image;
  if (Array.isArray(image)) {
    const first = image[0];
    return typeof first === "string" ? first : first?.url;
  }
  return image.url;
}

export function jsonLdLocation(location: JsonLdEvent["location"]): {
  venue?: string;
  address?: string;
} {
  if (!location) return {};
  if (typeof location === "string") return { venue: location };
  const addr = location.address;
  let address: string | undefined;
  if (typeof addr === "string") address = addr;
  else if (addr) {
    address = [addr.streetAddress, addr.addressLocality, addr.addressRegion]
      .filter(Boolean)
      .join(", ");
  }
  return { venue: location.name, address };
}
