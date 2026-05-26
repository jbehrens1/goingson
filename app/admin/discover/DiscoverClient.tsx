"use client";

import { useEffect, useRef, useState } from "react";

type Candidate = {
  candidateId: string;
  name: string;
  url: string;
  kind: string;
  town?: string;
  suggestedAdapter?: string;
  rationale: string;
  duplicate?: boolean;
};

type DiscoverResult = {
  ok: boolean;
  candidates?: Candidate[];
  proposedCount?: number;
  usage?: { input_tokens: number; output_tokens: number };
  durationMs?: number;
  completedAt?: string;
  error?: string;
};

type DispatchResponse =
  | { ok: true; requestId: string; region: string; workflowRunUrl?: string }
  | { ok: false; error: string };

type StatusResponse =
  | { ok: true; status: "pending" }
  | { ok: true; status: "complete"; result: DiscoverResult }
  | { ok: false; error: string };

type AddResponse =
  | {
      ok: true;
      added: number;
      addedIds: string[];
      rejected: Array<{ name?: string; reason: string }>;
      commitSha?: string;
    }
  | { ok: false; error: string; rejected?: Array<{ name?: string; reason: string }> };

const POLL_INTERVAL_MS = 5000;
const MAX_POLL_DURATION_MS = 5 * 60 * 1000; // 5 minutes

export function DiscoverClient({ regions }: { regions: string[] }) {
  const [region, setRegion] = useState<string>(regions[0] ?? "");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [workflowUrl, setWorkflowUrl] = useState<string | null>(null);
  const [pollStartedAt, setPollStartedAt] = useState<number | null>(null);
  const [statusText, setStatusText] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [proposedCount, setProposedCount] = useState<number | null>(null);
  const [usage, setUsage] = useState<DiscoverResult["usage"] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [addResult, setAddResult] = useState<AddResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up any in-flight poll when unmounting.
  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  function resetResults() {
    setCandidates([]);
    setProposedCount(null);
    setUsage(null);
    setSelected(new Set());
    setAddResult(null);
  }

  async function pollOnce(rid: string, startedAt: number): Promise<void> {
    try {
      const res = await fetch(
        `/api/admin/discover/status?requestId=${encodeURIComponent(rid)}`,
        { cache: "no-store" },
      );
      const raw = await res.text();
      let data: StatusResponse;
      try {
        data = JSON.parse(raw) as StatusResponse;
      } catch {
        setError(`Status check returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`);
        setLoading(false);
        return;
      }
      if (!data.ok) {
        setError(data.error);
        setLoading(false);
        return;
      }
      if (data.status === "complete") {
        const result = data.result;
        if (!result.ok) {
          setError(result.error ?? "Discovery failed in the workflow");
          setLoading(false);
          return;
        }
        setCandidates(result.candidates ?? []);
        setProposedCount(result.proposedCount ?? null);
        setUsage(result.usage ?? null);
        const pre = new Set(
          (result.candidates ?? []).filter((c) => !c.duplicate).map((c) => c.candidateId),
        );
        setSelected(pre);
        setStatusText(
          `Done in ${Math.round((result.durationMs ?? 0) / 1000)}s. Found ${result.candidates?.length ?? 0} candidates.`,
        );
        setLoading(false);
        return;
      }
      // Still pending — schedule next poll.
      const elapsed = Date.now() - startedAt;
      if (elapsed > MAX_POLL_DURATION_MS) {
        setError(
          `Discovery still hasn't completed after ${Math.round(elapsed / 1000)}s. Check the workflow logs.`,
        );
        setLoading(false);
        return;
      }
      setStatusText(`Running on GitHub Actions… (${Math.round(elapsed / 1000)}s elapsed)`);
      pollTimer.current = setTimeout(() => pollOnce(rid, startedAt), POLL_INTERVAL_MS);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }

  async function runDiscovery() {
    setLoading(true);
    setError(null);
    setStatusText("Dispatching workflow…");
    resetResults();
    setRequestId(null);
    setWorkflowUrl(null);
    setPollStartedAt(null);
    if (pollTimer.current) clearTimeout(pollTimer.current);

    try {
      const res = await fetch("/api/admin/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region }),
      });
      const raw = await res.text();
      let data: DispatchResponse;
      try {
        data = JSON.parse(raw) as DispatchResponse;
      } catch {
        setError(`Dispatch returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`);
        setLoading(false);
        return;
      }
      if (!data.ok) {
        setError(data.error);
        setLoading(false);
        return;
      }
      setRequestId(data.requestId);
      setWorkflowUrl(data.workflowRunUrl ?? null);
      const startedAt = Date.now();
      setPollStartedAt(startedAt);
      setStatusText("Workflow dispatched. Polling for results…");
      // First poll after a short delay to give the workflow time to start.
      pollTimer.current = setTimeout(() => pollOnce(data.requestId, startedAt), 8000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }

  async function addSelected() {
    const picks = candidates.filter((c) => selected.has(c.candidateId));
    if (picks.length === 0) return;
    setAdding(true);
    setAddResult(null);
    try {
      const res = await fetch("/api/admin/discover/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          region,
          sources: picks.map((c) => ({
            name: c.name,
            url: c.url,
            suggestedAdapter: c.suggestedAdapter,
            town: c.town,
            kind: c.kind,
            rationale: c.rationale,
          })),
        }),
      });
      const raw = await res.text();
      let data: AddResponse;
      try {
        data = JSON.parse(raw) as AddResponse;
      } catch {
        setAddResult({ ok: false, error: `HTTP ${res.status}: ${raw.slice(0, 200)}` });
        return;
      }
      setAddResult(data);
      if (data.ok && data.addedIds.length > 0) {
        const addedNames = new Set(picks.slice(0, data.added).map((c) => c.name));
        setCandidates((cs) => cs.filter((c) => !addedNames.has(c.name)));
        setSelected(new Set());
      }
    } catch (e) {
      setAddResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setAdding(false);
    }
  }

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectableCount = candidates.filter((c) => !c.duplicate).length;
  const elapsedSec = pollStartedAt
    ? Math.round((Date.now() - pollStartedAt) / 1000)
    : 0;

  return (
    <div>
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", marginBottom: "1rem" }}>
        <label style={{ fontWeight: 600 }}>Region:</label>
        <select
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          disabled={loading || adding}
          style={{ padding: "0.4rem 0.6rem", borderRadius: 6 }}
        >
          {regions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button
          onClick={runDiscovery}
          disabled={loading || adding || !region}
          style={{
            padding: "0.45rem 1rem",
            background: loading ? "#888" : "#1e40af",
            color: "white",
            border: "none",
            borderRadius: 6,
            cursor: loading ? "wait" : "pointer",
          }}
        >
          {loading ? `Running… ${elapsedSec}s` : "Discover sources"}
        </button>
        {usage && (
          <span style={{ color: "var(--muted)", fontSize: "0.85rem", marginLeft: "auto" }}>
            {usage.input_tokens.toLocaleString()} in / {usage.output_tokens.toLocaleString()} out tokens
          </span>
        )}
      </div>

      {loading && (
        <div style={{ padding: "1rem", background: "#fff8e1", borderRadius: 6, marginBottom: "1rem" }}>
          <div>
            <strong>{statusText}</strong>
          </div>
          {requestId && (
            <div style={{ fontSize: "0.85rem", color: "var(--muted)", marginTop: "0.4rem" }}>
              Request: <code>{requestId}</code>
              {workflowUrl && (
                <>
                  {" · "}
                  <a href={workflowUrl} target="_blank" rel="noopener noreferrer">
                    Watch the workflow run
                  </a>
                </>
              )}
            </div>
          )}
          <div style={{ fontSize: "0.85rem", marginTop: "0.5rem", color: "var(--muted)" }}>
            Discovery runs as a GitHub Actions workflow (typically 60–120 seconds). Results appear here when ready.
          </div>
        </div>
      )}

      {!loading && statusText && candidates.length > 0 && (
        <div style={{ marginBottom: "0.75rem", fontSize: "0.85rem", color: "var(--muted)" }}>
          {statusText}
        </div>
      )}

      {error && (
        <div style={{ padding: "0.75rem 1rem", background: "#fde2e2", color: "#7a1f1f", borderRadius: 6, marginBottom: "1rem" }}>
          <strong>Error:</strong> {error}
          {requestId && (
            <div style={{ fontSize: "0.85rem", marginTop: "0.3rem" }}>
              Request: <code>{requestId}</code>
              {workflowUrl && (
                <>
                  {" · "}
                  <a href={workflowUrl} target="_blank" rel="noopener noreferrer">
                    Check workflow logs
                  </a>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {candidates.length > 0 && (
        <>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "0.75rem",
              gap: "1rem",
              flexWrap: "wrap",
            }}
          >
            <div>
              <strong>{candidates.length}</strong> candidate{candidates.length === 1 ? "" : "s"}
              {proposedCount !== null && proposedCount !== candidates.length && (
                <span style={{ color: "var(--muted)" }}> ({proposedCount} proposed, deduped)</span>
              )}
              <span style={{ color: "var(--muted)" }}>
                {" "}
                · {selected.size} selected
              </span>
            </div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button
                onClick={() => setSelected(new Set(candidates.filter((c) => !c.duplicate).map((c) => c.candidateId)))}
                disabled={adding}
                style={{ padding: "0.35rem 0.8rem", borderRadius: 6 }}
              >
                Select all ({selectableCount})
              </button>
              <button
                onClick={() => setSelected(new Set())}
                disabled={adding}
                style={{ padding: "0.35rem 0.8rem", borderRadius: 6 }}
              >
                Clear
              </button>
              <button
                onClick={addSelected}
                disabled={adding || selected.size === 0}
                style={{
                  padding: "0.45rem 1rem",
                  background: adding || selected.size === 0 ? "#888" : "#15803d",
                  color: "white",
                  border: "none",
                  borderRadius: 6,
                  fontWeight: 600,
                  cursor: adding || selected.size === 0 ? "not-allowed" : "pointer",
                }}
              >
                {adding ? "Adding…" : `Add ${selected.size} to sources.json`}
              </button>
            </div>
          </div>

          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #ccc", textAlign: "left" }}>
                <th style={{ padding: "0.4rem 0.3rem", width: 32 }}></th>
                <th style={{ padding: "0.4rem 0.3rem" }}>Name</th>
                <th style={{ padding: "0.4rem 0.3rem" }}>URL</th>
                <th style={{ padding: "0.4rem 0.3rem" }}>Kind</th>
                <th style={{ padding: "0.4rem 0.3rem" }}>Town</th>
                <th style={{ padding: "0.4rem 0.3rem" }}>Adapter</th>
                <th style={{ padding: "0.4rem 0.3rem" }}>Rationale</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr
                  key={c.candidateId}
                  style={{
                    borderBottom: "1px solid #eee",
                    background: c.duplicate ? "#f7f7f7" : selected.has(c.candidateId) ? "#eef6ff" : undefined,
                    opacity: c.duplicate ? 0.55 : 1,
                  }}
                >
                  <td style={{ padding: "0.5rem 0.3rem", textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={selected.has(c.candidateId)}
                      disabled={c.duplicate || adding}
                      onChange={() => toggle(c.candidateId)}
                      title={c.duplicate ? "Already in your sources" : undefined}
                    />
                  </td>
                  <td style={{ padding: "0.5rem 0.3rem", fontWeight: 600 }}>
                    {c.name}
                    {c.duplicate && (
                      <div style={{ fontSize: "0.75rem", color: "#a04500", fontWeight: 400 }}>
                        (duplicate of existing source)
                      </div>
                    )}
                  </td>
                  <td style={{ padding: "0.5rem 0.3rem", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis" }}>
                    <a href={c.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: "0.85rem" }}>
                      {c.url}
                    </a>
                  </td>
                  <td style={{ padding: "0.5rem 0.3rem" }}>
                    <span style={{ fontSize: "0.8rem", background: "#eee", padding: "0.1rem 0.5rem", borderRadius: 10 }}>
                      {c.kind}
                    </span>
                  </td>
                  <td style={{ padding: "0.5rem 0.3rem" }}>{c.town ?? "—"}</td>
                  <td style={{ padding: "0.5rem 0.3rem", fontFamily: "monospace", fontSize: "0.8rem" }}>
                    {c.suggestedAdapter ?? "html-generic"}
                  </td>
                  <td style={{ padding: "0.5rem 0.3rem", fontSize: "0.85rem", color: "var(--muted)" }}>{c.rationale}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {addResult && (
        <div
          style={{
            marginTop: "1rem",
            padding: "0.75rem 1rem",
            borderRadius: 6,
            background: addResult.ok ? "#dcfce7" : "#fde2e2",
            color: addResult.ok ? "#14532d" : "#7a1f1f",
          }}
        >
          {addResult.ok ? (
            <>
              <strong>Added {addResult.added} sources to {region}.</strong>{" "}
              {addResult.commitSha && (
                <span style={{ fontFamily: "monospace", fontSize: "0.85rem" }}>(commit {addResult.commitSha.slice(0, 7)})</span>
              )}
              <div style={{ marginTop: "0.4rem", fontSize: "0.9rem" }}>
                They were added <strong>disabled</strong> — visit{" "}
                <a href="/sources" style={{ color: "#14532d", textDecoration: "underline" }}>
                  /sources
                </a>{" "}
                to enable and probe them, then trigger an ingest.
              </div>
              {addResult.rejected && addResult.rejected.length > 0 && (
                <details style={{ marginTop: "0.4rem", fontSize: "0.85rem" }}>
                  <summary>{addResult.rejected.length} rejected</summary>
                  <ul>
                    {addResult.rejected.map((r, i) => (
                      <li key={i}>
                        {r.name ?? "(no name)"}: {r.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          ) : (
            <>
              <strong>Error:</strong> {addResult.error}
            </>
          )}
        </div>
      )}
    </div>
  );
}
