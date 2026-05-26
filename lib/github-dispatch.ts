// Triggers a GitHub Actions workflow_dispatch event so the cron pipeline
// re-ingests on demand (e.g. right after an admin edits a source). Lets
// edits land in the live events JSON ~2 min after Save instead of waiting
// for the next daily cron tick.
//
// Required env (same as github-commit.ts):
//   GITHUB_TOKEN  - fine-grained PAT with Actions: Read & Write on the repo
//                   (Contents R/W is already required for the commit path)
//   GITHUB_REPO   - "owner/repo" form

async function dispatchWorkflow(
  workflowFile: string,
  inputs: Record<string, string>,
): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) {
    return { ok: false, error: "GITHUB_TOKEN or GITHUB_REPO not configured" };
  }
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "goingson-editor",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main", inputs }),
  });
  if (!res.ok) {
    const text = await res.text();
    return {
      ok: false,
      error: `Dispatch failed: HTTP ${res.status} ${text.slice(0, 200)}`,
    };
  }
  return { ok: true };
}

export async function dispatchIngestWorkflow(opts: {
  regionId?: string;
  reason?: string;
  /** When set, the workflow runs ingest with INGEST_ONLY=<sourceId> so only
   *  that source is re-fetched. Region is required alongside it. */
  onlySource?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const inputs: Record<string, string> = {};
  if (opts.regionId) inputs.region = opts.regionId;
  if (opts.reason) inputs.reason = opts.reason;
  if (opts.onlySource) inputs.onlySource = opts.onlySource;
  return dispatchWorkflow("ingest.yml", inputs);
}

export async function dispatchDiscoverWorkflow(opts: {
  region: string;
  requestId: string;
}): Promise<{ ok: boolean; error?: string }> {
  return dispatchWorkflow("discover.yml", {
    region: opts.region,
    requestId: opts.requestId,
  });
}
