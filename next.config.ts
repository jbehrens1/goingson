import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next's automatic file tracing can miss config/ files because they're read
  // via fs.readFile with paths built from process.cwd() (not statically
  // analyzable). Force-include them for every server route that needs them,
  // so the Vercel serverless function bundles ship with the actual JSON on
  // disk. Without this, /sources/pending could render blank because
  // config/pending-sources.json wasn't in the deployed function.
  outputFileTracingIncludes: {
    "/sources/**": ["./config/**"],
    "/account": ["./config/**", "./public/events.*.json"],
    "/admin/**": [
      // newsletter-events.jsonl removed — see app/api/webhooks/resend
      // (Vercel FS is read-only at runtime, so the rollup is on hold)
      "./public/source-history.jsonl",
      "./public/ingest-history.jsonl",
      "./public/source-health.json",
      "./public/events.*.json",
      "./config/**",
    ],
    "/api/admin/**": ["./config/**"],
    "/api/sources/**": ["./config/**"],
    "/api/suggest/**": ["./config/**"],
    "/api/cron/**": ["./public/**", "./config/**"],
    "/api/newsletter/**": ["./public/events.*.json", "./config/**"],
    "/api/account/**": ["./config/**"],
  },
};

export default nextConfig;
