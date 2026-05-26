// Runs source discovery via Claude + web search and writes results to a
// JSON file that the admin UI polls for. Invoked from .github/workflows/
// discover.yml — running in CI sidesteps Vercel's 60s function timeout.
//
// Usage:
//   REGION=lbi REQUEST_ID=20260526T140000 ANTHROPIC_API_KEY=... npx tsx scripts/discover.ts

import { promises as fs } from "node:fs";
import path from "node:path";
import { discoverSourcesForRegion } from "../lib/discover";

async function main(): Promise<void> {
  const region = process.env.REGION?.trim();
  const requestId = process.env.REQUEST_ID?.trim();
  if (!region) {
    console.error("REGION env var required");
    process.exit(1);
  }
  if (!requestId) {
    console.error("REQUEST_ID env var required");
    process.exit(1);
  }
  if (!/^[a-z0-9-]+$/.test(region)) {
    console.error(`Invalid REGION format: ${region}`);
    process.exit(1);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(requestId)) {
    console.error(`Invalid REQUEST_ID format: ${requestId}`);
    process.exit(1);
  }

  const outDir = path.join(process.cwd(), "public", "discover");
  const outFile = path.join(outDir, `${requestId}.json`);
  await fs.mkdir(outDir, { recursive: true });

  console.log(`[discover] region=${region} requestId=${requestId}`);
  console.log(`[discover] output -> ${outFile}`);

  const started = Date.now();
  try {
    const result = await discoverSourcesForRegion(region);
    const payload = {
      ok: true,
      region,
      requestId,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      ...result,
    };
    await fs.writeFile(outFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
    console.log(
      `[discover] done in ${payload.durationMs}ms. ${result.candidates.length} candidates (${result.proposedCount} proposed).`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const payload = {
      ok: false,
      region,
      requestId,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      error: msg,
    };
    await fs.writeFile(outFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
    console.error(`[discover] failed: ${msg}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[discover] fatal:", err);
  process.exit(1);
});
