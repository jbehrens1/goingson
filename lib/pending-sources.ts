// Pending venue suggestions submitted via /suggest. Admins review at
// /sources/pending; on approval they move to the appropriate region's
// sources.json via the existing GitHub-API commit flow.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AdapterType } from "./types";

export type PendingProbeCandidate = {
  confidence: "high" | "medium" | "low";
  verifiedCount: number;
  adapter: AdapterType;
  url: string;
  config?: Record<string, unknown>;
  evidence: string;
};

export type PendingSuggestion = {
  id: string; // generated UUID
  submittedAt: string;
  submittedBy: string; // email or "anonymous"
  name: string;
  url: string;
  town?: string;
  regionId: string;
  notes?: string;
  probe?: {
    candidates: PendingProbeCandidate[];
    finalUrl?: string;
  };
};

export type PendingFile = {
  $comment?: string;
  pending: PendingSuggestion[];
};

const PENDING_PATH = "config/pending-sources.json";

export function pendingFilePath(): string {
  return PENDING_PATH;
}

export async function readPending(rootDir: string): Promise<PendingFile> {
  const file = path.join(rootDir, PENDING_PATH);
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as PendingFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        $comment:
          "Pending venue suggestions queued via /suggest. Approved entries move to config/regions/<region>/sources.json; rejected entries are removed. Managed via /sources/pending UI.",
        pending: [],
      };
    }
    throw err;
  }
}

export function serializePending(file: PendingFile): string {
  return JSON.stringify(file, null, 2) + "\n";
}

const SLUG_BAD = /[^a-z0-9]+/g;
export function slugifyId(name: string, existing: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(SLUG_BAD, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "source";
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
