"use client";

import { useState, useTransition } from "react";

type ProbeAttempt = {
  url: string;
  adapter: string;
  count: number;
  note?: string;
};

type ProbeCandidate = {
  confidence: "high" | "medium" | "low";
  verifiedCount: number;
  adapter: string;
  url: string;
  evidence: string;
};

type ProbeResult = {
  candidates: ProbeCandidate[];
  attempts: ProbeAttempt[];
};

type ApiResponse = {
  ok: boolean;
  result?: ProbeResult;
  durationMs?: number;
  error?: string;
};

export function ReprobeButton({
  regionId,
  sourceId,
}: {
  regionId: string;
  sourceId: string;
}) {
  const [running, startTransition] = useTransition();
  const [result, setResult] = useState<ApiResponse | null>(null);

  function trigger(mode: "deep" | "light") {
    setResult(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/probe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ regionId, sourceId, mode }),
        });
        const json = (await res.json()) as ApiResponse;
        setResult(json);
      } catch (err) {
        setResult({ ok: false, error: (err as Error).message });
      }
    });
  }

  return (
    <div className="reprobe">
      <button
        type="button"
        className="ghost-btn"
        disabled={running}
        onClick={() => trigger("deep")}
        title="Force the deepest probe — every detector, every alt-path, every WP custom-post-type"
      >
        {running ? "Probing…" : "Re-probe (deep)"}
      </button>
      {result && !result.ok && (
        <span className="hint hint-error">{result.error}</span>
      )}
      {result?.ok && result.result && (
        <div className="reprobe-result">
          <p className="muted small">
            Probed in {result.durationMs}ms.{" "}
            {result.result.candidates.length} candidate
            {result.result.candidates.length === 1 ? "" : "s"} found,{" "}
            {result.result.attempts.length} path
            {result.result.attempts.length === 1 ? "" : "s"} tried.
          </p>
          {result.result.candidates.length > 0 && (
            <>
              <h4>Candidates</h4>
              <ul className="qc-probe-list">
                {result.result.candidates.slice(0, 8).map((c, i) => (
                  <li key={i}>
                    <strong>
                      {c.adapter} · {c.verifiedCount} events
                    </strong>{" "}
                    <span
                      className={`health-badge health-${
                        c.confidence === "high" ? "fixed" : "low"
                      }`}
                    >
                      {c.confidence}
                    </span>
                    <br />
                    <span className="muted small">{c.evidence}</span>
                    <br />
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="small"
                    >
                      {c.url}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
          <details className="qc-attempts" open>
            <summary>
              {result.result.attempts.length} attempt
              {result.result.attempts.length === 1 ? "" : "s"} —{" "}
              {result.result.attempts.filter((a) => a.count > 0).length}{" "}
              produced events
            </summary>
            <table className="qc-attempts-table">
              <thead>
                <tr>
                  <th>Count</th>
                  <th>Adapter</th>
                  <th>URL</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {result.result.attempts
                  .slice()
                  .sort((a, b) => b.count - a.count)
                  .map((a, i) => (
                    <tr key={i} className={a.count === 0 ? "muted-row" : ""}>
                      <td className="sources-count-cell">{a.count}</td>
                      <td>
                        <code className="small">{a.adapter}</code>
                      </td>
                      <td className="qc-attempt-url">
                        <a
                          href={a.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {a.url}
                        </a>
                      </td>
                      <td className="muted small">{a.note ?? ""}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </details>
        </div>
      )}
    </div>
  );
}
