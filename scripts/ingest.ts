import path from "node:path";
import { fileURLToPath } from "node:url";
import { runIngest } from "../lib/ingest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const onlySourceId = process.env.INGEST_ONLY?.trim() || undefined;
const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

async function main() {
  console.log(
    `[ingest] starting${onlySourceId ? ` (only=${onlySourceId})` : ""}${dryRun ? " (dry run)" : ""}`,
  );
  const report = await runIngest({ rootDir, onlySourceId, dryRun });
  for (const r of report.perSource) {
    const status = r.error ? `ERROR: ${r.error}` : `${r.count} events`;
    console.log(`  - ${r.sourceId}: ${status}`);
    for (const w of r.warnings) console.log(`      warn: ${w}`);
  }
  console.log(
    `[ingest] done: ${report.totalEvents} unique events${
      report.outputPath ? ` → ${path.relative(rootDir, report.outputPath)}` : " (dry run, no file written)"
    }`,
  );
}

main().catch((err) => {
  console.error(`[ingest] failed: ${(err as Error).message}`);
  process.exit(1);
});
