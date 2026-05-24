// Triggers a GitHub Actions workflow_dispatch event so the cron pipeline
// re-ingests on demand (e.g. right after an admin edits a source). Lets
// edits land in the live events JSON ~2 min after Save instead of waiting
// for the next daily cron tick.
//
// Required env (same as github-commit.ts):
//   GITHUB_TOKEN  - fine-grained PAT with Actions: Read & Write on the repo
//                   (Contents R/W is already required for the commit path)
//   GITHUB_REPO   - "owner/repo" form

export async function dispatchIngestWorkflow(opts: {
  regionId?: string;
  reason?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) {
    return { ok: false, error: "GITHUB_TOKEN or GITHUB_REPO not configured" };
  }

  const url = `https://api.github.com/repos/${repo}/actions/workflows/ingest.yml/dispatches`;
  const body = {
    ref: "main",
    inputs: {
      ...(opts.regionId ? { region: opts.regionId } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "metrowest-events-editor",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    return {
      ok: false,
      error: `Dispatch failed: HTTP ${res.status} ${text.slice(0, 200)}`,
    };
  }
  // 204 No Content on success — nothing to parse.
  return { ok: true };
}
