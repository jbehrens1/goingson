// Commits a JSON file to GitHub via the REST API. Used by the /sources editor
// to persist sources.json edits back to the repo so the daily cron picks them
// up on the next run.
//
// Required env:
//   GITHUB_TOKEN  - fine-grained PAT with Contents: Read & Write on the repo
//   GITHUB_REPO   - "owner/repo" form, e.g. "jbehrens1/goingson"

type CommitOptions = {
  path: string; // repo-relative path, e.g. "config/regions/metrowest/sources.json"
  content: string; // file content (will be base64-encoded)
  message: string; // commit message
  branch?: string; // default: "main"
  authorName?: string;
  authorEmail?: string;
};

export async function commitFileToGitHub(opts: CommitOptions): Promise<{
  ok: boolean;
  commitSha?: string;
  error?: string;
}> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) {
    return { ok: false, error: "GITHUB_TOKEN or GITHUB_REPO not configured" };
  }
  const branch = opts.branch ?? "main";
  const base = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(opts.path).replace(/%2F/g, "/")}`;

  // Look up the current file SHA (required for updates).
  const headRes = await fetch(`${base}?ref=${branch}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "goingson-editor",
    },
  });
  let sha: string | undefined;
  if (headRes.ok) {
    const data = (await headRes.json()) as { sha?: string };
    sha = data.sha;
  } else if (headRes.status !== 404) {
    return { ok: false, error: `Lookup failed: HTTP ${headRes.status}` };
  }

  const body = {
    message: opts.message,
    content: Buffer.from(opts.content, "utf8").toString("base64"),
    branch,
    ...(sha ? { sha } : {}),
    ...(opts.authorName && opts.authorEmail
      ? {
          committer: { name: opts.authorName, email: opts.authorEmail },
          author: { name: opts.authorName, email: opts.authorEmail },
        }
      : {}),
  };

  const putRes = await fetch(base, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "goingson-editor",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!putRes.ok) {
    const text = await putRes.text();
    return { ok: false, error: `Commit failed: HTTP ${putRes.status} ${text.slice(0, 200)}` };
  }
  const result = (await putRes.json()) as { commit?: { sha?: string } };
  return { ok: true, commitSha: result.commit?.sha };
}
