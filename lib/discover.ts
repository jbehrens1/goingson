// LLM-powered source discovery for admins. Given a region, asks Claude to use
// web search to find local event venues/aggregators/newspapers/libraries we
// don't already have, then return them as structured candidates via a custom
// `propose_source` tool.
//
// Returned candidates are NOT auto-applied — the admin reviews them in the
// UI and explicitly approves which to add.

import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "node:fs";
import path from "node:path";
import { readSources } from "./sources-config";
import type { AdapterType } from "./types";

export type DiscoveredCandidate = {
  /** Stable client-side ID for checkbox tracking. Not used in the source config. */
  candidateId: string;
  name: string;
  url: string;
  kind: string;
  town?: string;
  suggestedAdapter?: AdapterType;
  rationale: string;
  /** True if a same-host URL is already present in the region's sources.json. */
  duplicate?: boolean;
};

export type DiscoveryResult = {
  candidates: DiscoveredCandidate[];
  /** Raw count Claude proposed before dedupe (useful to debug). */
  proposedCount: number;
  /** Approximate token usage for cost tracking. */
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
};

type ProposeSourceInput = {
  name?: string;
  url?: string;
  kind?: string;
  town?: string;
  suggestedAdapter?: string;
  rationale?: string;
};

const VALID_ADAPTERS = new Set<AdapterType>([
  "ical",
  "rss",
  "eventbrite",
  "patch",
  "wordpress-tribe",
  "wordpress-tribe-list",
  "wordpress-mc",
  "wordpress-mec",
  "wordpress-geodir",
  "squarespace-events",
  "elfsight-events",
  "trustees",
  "manual-recurring",
  "manual-oneoff",
  "html-generic",
  "beehiiv-lowdown",
]);

const PROPOSE_SOURCE_TOOL = {
  name: "propose_source",
  description:
    "Propose ONE candidate event source for the region. Call this once for each distinct venue/library/aggregator/newspaper/museum/etc. you found. Aim for 8-15 strong candidates total. Do not call this for sources already in the existing list. Do not propose national chains, generic listings sites, or anything outside the region's towns.",
  input_schema: {
    type: "object" as const,
    properties: {
      name: {
        type: "string" as const,
        description: "Human-readable venue or source name (e.g. 'Holgate Library', 'LBI Foundation of the Arts').",
      },
      url: {
        type: "string" as const,
        description:
          "Canonical URL where this source's events appear (usually the events/calendar page, not just the homepage). Must be a full https URL.",
      },
      kind: {
        type: "string" as const,
        enum: [
          "venue",
          "library",
          "town-government",
          "museum",
          "newspaper",
          "aggregator",
          "church",
          "school",
          "park",
          "restaurant-bar",
          "other",
        ],
        description: "What kind of source this is.",
      },
      town: {
        type: "string" as const,
        description: "Which town in the region the venue is located in. Match a town from the provided list.",
      },
      suggestedAdapter: {
        type: "string" as const,
        enum: [
          "ical",
          "rss",
          "wordpress-tribe",
          "wordpress-mec",
          "wordpress-mc",
          "wordpress-geodir",
          "squarespace-events",
          "eventbrite",
          "html-generic",
          "patch",
          "manual-oneoff",
        ],
        description:
          "Your best guess at the right adapter based on the website's platform. If you can tell it runs WordPress + The Events Calendar (Tribe), use 'wordpress-tribe'. iCal feed → 'ical'. Squarespace with native events → 'squarespace-events'. If unsure, omit.",
      },
      rationale: {
        type: "string" as const,
        description:
          "One sentence on why this is a good local source and what kind of events it publishes (e.g. 'Public library hosting weekly story times, author talks, and senior programs'). Cite the URL you found this on.",
      },
    },
    required: ["name", "url", "kind", "rationale"],
  },
};

function buildSystemPrompt(args: {
  regionName: string;
  regionDescription?: string;
  towns: string[];
  existingSources: Array<{ name: string; url: string }>;
}): string {
  const existingList = args.existingSources
    .map((s) => `  - ${s.name} (${s.url})`)
    .join("\n");
  return `You are a source-discovery assistant for Goings On (goingson.co), a local events aggregator.

Your job: find LOCAL event sources in the ${args.regionName} region that are NOT already in the existing list. Use the web_search tool to actively search for them.

REGION: ${args.regionName}
${args.regionDescription ? `Description: ${args.regionDescription}\n` : ""}Towns in scope:
${args.towns.map((t) => `  - ${t}`).join("\n")}

EXISTING SOURCES (DO NOT propose these — they're already configured):
${existingList || "  (none yet)"}

WHAT MAKES A GOOD CANDIDATE:
  - A specific local venue, library, museum, town government, newspaper, church, school, or aggregator
  - Has a publicly accessible events page or calendar
  - Located in one of the listed towns (not adjacent regions)
  - Recurring or regular events, not one-off announcements
  - Examples of types that work well: live-music venues, libraries, historical societies, town rec departments, weekly newsletters, art schools, community centers

WHAT TO SKIP:
  - National chains and franchises
  - Eventbrite-style listing aggregators (we have those covered)
  - Sources already in the existing list (any URL whose hostname matches an existing one)
  - Anything outside the region's towns

HOW TO WORK (budget: up to 12 web searches):
  1. Plan queries across towns AND kinds. Examples:
       "<region name> events calendar"
       "<town> library events"
       "<region name> live music venues"
       "<region name> historical society"
       "<region name> arts center"
       "<region name> town hall calendar"
       "<region name> church events"
       "<region name> newsletter local"
  2. For each search, extract multiple candidates before moving on.
  3. Call propose_source for each distinct, valid candidate.
  4. Skip anything whose hostname matches an existing source. Skip anything outside the listed towns.
  5. Aim for 10-15 candidates total. Quality matters more than quantity — but more candidates give the admin more options.

OUTPUT: only call propose_source — no summary text.`;
}

function safeHost(u: string): string | null {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

async function loadRegionMeta(
  regionId: string,
): Promise<{ name: string; description?: string; towns: string[] }> {
  // The region's display name + description live in region.json; towns live
  // in towns.json. Both files are co-located in config/regions/<id>/.
  const dir = path.join(process.cwd(), "config", "regions", regionId);
  const region = JSON.parse(
    await fs.readFile(path.join(dir, "region.json"), "utf8"),
  );
  let towns: string[] = [];
  try {
    const t = JSON.parse(
      await fs.readFile(path.join(dir, "towns.json"), "utf8"),
    );
    const list = Array.isArray(t) ? t : Array.isArray(t.towns) ? t.towns : [];
    towns = list
      .map((row: { name?: string }) => (typeof row?.name === "string" ? row.name : null))
      .filter((s: string | null): s is string => !!s);
  } catch {
    /* towns file optional */
  }
  return {
    name: region.name ?? regionId,
    description: region.description,
    towns,
  };
}

/** Run a Claude-powered discovery pass for one region. */
export async function discoverSourcesForRegion(
  regionId: string,
): Promise<DiscoveryResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  const [region, sourcesFile] = await Promise.all([
    loadRegionMeta(regionId),
    readSources(regionId),
  ]);

  const existingHosts = new Set<string>();
  for (const s of sourcesFile.sources) {
    const h = safeHost(s.url);
    if (h) existingHosts.add(h);
  }

  const client = new Anthropic();
  const systemPrompt = buildSystemPrompt({
    regionName: region.name,
    regionDescription: region.description,
    towns: region.towns,
    existingSources: sourcesFile.sources.map((s) => ({
      name: s.name,
      url: s.url,
    })),
  });

  // Conversation loop. The web search tool runs server-side — Claude may issue
  // multiple searches inside a single response. If it hits the server-side
  // tool-call limit, we get stop_reason: "pause_turn" and need to re-send.
  type Msg = Anthropic.MessageParam;
  const messages: Msg[] = [
    {
      role: "user",
      content: `Discover event sources for the ${region.name} region.`,
    },
  ];

  const allProposed: ProposeSourceInput[] = [];
  let totalInput = 0;
  let totalOutput = 0;
  const maxContinuations = 3;
  let continuations = 0;

  // Single call (or up to 3 if pause_turn). The model handles its own web
  // searches server-side and emits propose_source tool_use blocks inline.
  while (true) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: systemPrompt,
      tools: [
        // Runs in GitHub Actions (5min job timeout) — generous budget OK.
        { type: "web_search_20260209", name: "web_search", max_uses: 12 },
        // Custom tool — must be a plain object literal (Tool type is custom-only).
        PROPOSE_SOURCE_TOOL,
      ],
      tool_choice: { type: "auto" },
      messages,
    });

    totalInput += response.usage.input_tokens;
    totalOutput += response.usage.output_tokens;

    for (const block of response.content) {
      if (block.type === "tool_use" && block.name === "propose_source") {
        allProposed.push(block.input as ProposeSourceInput);
      }
    }

    if (response.stop_reason === "pause_turn") {
      // Server-side tool loop paused — re-send to continue.
      if (continuations >= maxContinuations) break;
      continuations++;
      messages.push({ role: "assistant", content: response.content });
      continue;
    }
    break;
  }

  // Post-process: dedupe by hostname, mark duplicates of existing sources,
  // assign client-side IDs, validate adapter values.
  const seenHosts = new Set<string>();
  const candidates: DiscoveredCandidate[] = [];
  for (let i = 0; i < allProposed.length; i++) {
    const p = allProposed[i];
    if (!p?.name || !p?.url || !p?.kind || !p?.rationale) continue;
    const host = safeHost(p.url);
    if (!host) continue;
    if (seenHosts.has(host)) continue;
    seenHosts.add(host);
    const duplicate = existingHosts.has(host);
    const adapter =
      p.suggestedAdapter && VALID_ADAPTERS.has(p.suggestedAdapter as AdapterType)
        ? (p.suggestedAdapter as AdapterType)
        : undefined;
    candidates.push({
      candidateId: `c_${i}_${host}`,
      name: p.name.trim(),
      url: p.url.trim(),
      kind: p.kind,
      town: p.town?.trim() || undefined,
      suggestedAdapter: adapter,
      rationale: p.rationale.trim(),
      duplicate,
    });
  }

  return {
    candidates,
    proposedCount: allProposed.length,
    usage: { input_tokens: totalInput, output_tokens: totalOutput },
  };
}
