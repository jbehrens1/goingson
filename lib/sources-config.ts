// Read/validate sources.json files for the /sources page. Writes go through
// the GitHub API (lib/github-commit.ts) so they survive Vercel's read-only
// filesystem and end up in the next ingest cron run.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { SourceConfig, SourcesFile, AdapterType } from "./types";

export type RegionId = string;

const CONFIG_ROOT = path.join(process.cwd(), "config", "regions");

const VALID_ADAPTERS: AdapterType[] = [
  "ical",
  "rss",
  "eventbrite",
  "patch",
  "wordpress-tribe",
  "wordpress-tribe-list",
  "wordpress-mc",
  "wordpress-mec",
  "wordpress-geodir",
  "beehiiv-lowdown",
  "growthzone-calendar",
  "squarespace-events",
  "elfsight-events",
  "trustees",
  "manual-recurring",
  "manual-oneoff",
  "html-generic",
];

export async function listRegions(): Promise<RegionId[]> {
  const entries = await fs.readdir(CONFIG_ROOT, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export async function readSources(region: RegionId): Promise<SourcesFile> {
  const file = path.join(CONFIG_ROOT, region, "sources.json");
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw) as SourcesFile;
}

export function sourcesFilePath(region: RegionId): string {
  // Repo-relative path for the GitHub API commit.
  return `config/regions/${region}/sources.json`;
}

/**
 * Validates an incoming sources list before we commit it. Returns an array of
 * error messages; empty array means OK.
 */
export function validateSources(sources: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(sources)) {
    return ["sources must be an array"];
  }
  const ids = new Set<string>();
  sources.forEach((s, i) => {
    const ctx = `sources[${i}]`;
    if (!s || typeof s !== "object") {
      errors.push(`${ctx}: must be an object`);
      return;
    }
    const src = s as Partial<SourceConfig>;
    if (!src.id || typeof src.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(src.id)) {
      errors.push(`${ctx}: id must be a lowercase slug (a-z 0-9 -)`);
    } else if (ids.has(src.id)) {
      errors.push(`${ctx}: duplicate id "${src.id}"`);
    } else {
      ids.add(src.id);
    }
    if (!src.name || typeof src.name !== "string") errors.push(`${ctx}: name required`);
    if (!src.url || typeof src.url !== "string") {
      errors.push(`${ctx}: url required`);
    } else {
      try {
        new URL(src.url);
      } catch {
        errors.push(`${ctx}: url is not a valid URL`);
      }
    }
    if (typeof src.enabled !== "boolean") errors.push(`${ctx}: enabled must be boolean`);
    if (!src.adapter || !VALID_ADAPTERS.includes(src.adapter as AdapterType)) {
      errors.push(`${ctx}: adapter must be one of ${VALID_ADAPTERS.join(", ")}`);
    }
    if (src.town != null && typeof src.town !== "string")
      errors.push(`${ctx}: town must be a string`);
    if (src.category != null && typeof src.category !== "string")
      errors.push(`${ctx}: category must be a string`);
    if (src.notes != null && typeof src.notes !== "string")
      errors.push(`${ctx}: notes must be a string`);
    if (src.config != null && (typeof src.config !== "object" || Array.isArray(src.config)))
      errors.push(`${ctx}: config must be a plain object`);
  });
  return errors;
}

/**
 * Serializes a SourcesFile back to disk-shaped JSON with stable key ordering
 * and 2-space indent, matching what the hand-edited files look like.
 */
export function serializeSources(file: SourcesFile): string {
  const ordered: SourcesFile = {
    ...(file.$comment ? { $comment: file.$comment } : {}),
    sources: file.sources.map(orderSource),
  };
  return JSON.stringify(ordered, null, 2) + "\n";
}

function orderSource(src: SourceConfig): SourceConfig {
  // Keep the same field order as the hand-edited sources.json files so diffs
  // stay readable. CRITICAL: include EVERY SourceConfig field — leaving one
  // out here means /sources saves silently strip it (caused a major data
  // loss when defaultEventType and titleRules got wiped from every source
  // the first time an admin clicked Save).
  const out: Record<string, unknown> = {};
  for (const k of [
    "id",
    "name",
    "enabled",
    "adapter",
    "url",
    "category",
    "town",
    "notes",
    "defaultEventType",
    "titleRules",
  ]) {
    if (src[k as keyof SourceConfig] !== undefined) out[k] = src[k as keyof SourceConfig];
  }
  if (src.config !== undefined) out.config = src.config;
  return out as SourceConfig;
}

export { VALID_ADAPTERS };
