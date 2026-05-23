import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAllRegions, runIngest } from "../lib/ingest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const onlySourceId = process.env.INGEST_ONLY?.trim() || undefined;
const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
// REGION env var pins to a single region. Without it we ingest all regions
// and emit public/regions.json so the client can offer a region selector.
const regionOverride = process.env.REGION?.trim() || undefined;

async function main() {
  // If REGION or INGEST_ONLY is set, behave as single-region for back-compat.
  // Otherwise sweep every region and write the manifest.
  if (regionOverride || onlySourceId) {
    console.log(
      `[ingest] starting (region=${regionOverride ?? "default"})${
        onlySourceId ? ` (only=${onlySourceId})` : ""
      }${dryRun ? " (dry run)" : ""}`,
    );
    const report = await runIngest({
      rootDir,
      onlySourceId,
      dryRun,
      regionId: regionOverride,
    });
    for (const r of report.perSource) {
      const status = r.error ? `ERROR: ${r.error}` : `${r.count} events`;
      console.log(`  - ${r.sourceId}: ${status}`);
      for (const w of r.warnings) console.log(`      warn: ${w}`);
    }
    console.log(
      `[ingest] done (region=${report.regionId}): ${report.totalEvents} unique events${
        report.outputPath
          ? ` → ${path.relative(rootDir, report.outputPath)}`
          : " (dry run, no file written)"
      }`,
    );
    return;
  }

  console.log(`[ingest] starting (all regions)${dryRun ? " (dry run)" : ""}`);
  const report = await runAllRegions({ rootDir, dryRun });
  for (const r of report.perRegion) {
    console.log(`\n=== ${r.regionId} ===`);
    for (const s of r.perSource) {
      const status = s.error ? `ERROR: ${s.error}` : `${s.count} events`;
      console.log(`  - ${s.sourceId}: ${status}`);
      for (const w of s.warnings) console.log(`      warn: ${w}`);
    }
    console.log(`  total: ${r.totalEvents} unique events`);
  }
  console.log(`\n[ingest] done: ${report.regions.length} regions ingested`);
  for (const region of report.regions) {
    console.log(`  ${region.id}: ${region.eventCount} events → public${region.eventsPath}`);
  }
  if (!dryRun) {
    console.log(`  manifest → public/regions.json`);
  }
}

main().catch((err) => {
  console.error(`[ingest] failed: ${(err as Error).message}`);
  process.exit(1);
});
