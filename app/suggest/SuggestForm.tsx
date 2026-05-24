"use client";

import { useState, useTransition } from "react";

type ProbeCandidate = {
  confidence: "high" | "medium" | "low";
  verifiedCount: number;
  adapter: string;
  url: string;
  evidence: string;
};

type SubmitResult = {
  ok: boolean;
  id?: string;
  probe?: {
    candidates: ProbeCandidate[];
    finalUrl?: string;
  };
  error?: string;
};

export function SuggestForm({ regions }: { regions: string[] }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [town, setTown] = useState("");
  const [regionId, setRegionId] = useState(regions[0] ?? "");
  const [notes, setNotes] = useState("");
  const [submitting, startSubmit] = useTransition();
  const [result, setResult] = useState<SubmitResult | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    startSubmit(async () => {
      try {
        const res = await fetch("/api/suggest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            url: url.trim(),
            town: town.trim() || undefined,
            regionId,
            notes: notes.trim() || undefined,
          }),
        });
        const json = (await res.json()) as SubmitResult;
        setResult(json);
        if (json.ok) {
          setName("");
          setUrl("");
          setTown("");
          setNotes("");
        }
      } catch (err) {
        setResult({ ok: false, error: (err as Error).message });
      }
    });
  }

  return (
    <>
      <form className="suggest-form" onSubmit={submit}>
        <label>
          <span>Venue name *</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Wellfleet Cinemas"
            required
            disabled={submitting}
          />
        </label>
        <label>
          <span>URL *</span>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://venue.example.com/"
            required
            disabled={submitting}
          />
        </label>
        <label>
          <span>Town</span>
          <input
            type="text"
            value={town}
            onChange={(e) => setTown(e.target.value)}
            placeholder="e.g. Wellfleet"
            disabled={submitting}
          />
        </label>
        <label>
          <span>Region *</span>
          <select
            value={regionId}
            onChange={(e) => setRegionId(e.target.value)}
            disabled={submitting}
            required
          >
            {regions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className="suggest-notes">
          <span>Notes (optional)</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Anything that would help — type of events, calendar URL, etc."
            disabled={submitting}
          />
        </label>
        <div className="suggest-actions">
          <button type="submit" className="primary-btn" disabled={submitting}>
            {submitting ? "Probing site…" : "Submit suggestion"}
          </button>
          <span className="muted small">
            We&rsquo;ll fetch the URL and look for an event feed before queueing
            for admin review (~5 seconds).
          </span>
        </div>
      </form>

      {result && !result.ok && (
        <p className="hint hint-error">{result.error ?? "Submission failed"}</p>
      )}
      {result && result.ok && (
        <div className="suggest-result">
          <p className="hint hint-ok">
            Thanks — suggestion queued for admin review.
          </p>
          {result.probe?.candidates && result.probe.candidates.length > 0 ? (
            <div>
              <p className="muted small">Probe findings:</p>
              <ul className="suggest-probe-list">
                {result.probe.candidates.map((c, i) => (
                  <li key={i}>
                    <strong>
                      {c.adapter} · {c.verifiedCount} events
                    </strong>{" "}
                    <span className={`health-badge health-${c.confidence === "high" ? "fixed" : "low"}`}>
                      {c.confidence}
                    </span>
                    <br />
                    <span className="muted small">{c.evidence}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="muted small">
              No automatic event feed detected — admin will review the URL manually.
            </p>
          )}
        </div>
      )}
    </>
  );
}
