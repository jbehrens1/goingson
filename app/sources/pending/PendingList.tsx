"use client";

import { useState, useTransition } from "react";
import type { PendingSuggestion } from "@/lib/pending-sources";
import type { AdapterType } from "@/lib/types";

const ADAPTERS: AdapterType[] = [
  "ical",
  "rss",
  "eventbrite",
  "patch",
  "wordpress-tribe",
  "wordpress-tribe-list",
  "wordpress-mc",
  "wordpress-mec",
  "squarespace-events",
  "trustees",
  "manual-recurring",
  "manual-oneoff",
  "html-generic",
];

type Override = {
  adapter: AdapterType;
  url: string;
  config?: Record<string, unknown>;
};

export function PendingList({
  initial,
  regions,
}: {
  initial: PendingSuggestion[];
  regions: string[];
}) {
  const [items, setItems] = useState<PendingSuggestion[]>(initial);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [_, startTransition] = useTransition();

  // Per-row overrides admins can tweak before clicking Approve. Defaulted to
  // the top probe candidate when present.
  const [overrides, setOverrides] = useState<Record<string, Override>>(() => {
    const init: Record<string, Override> = {};
    for (const item of initial) {
      const best = item.probe?.candidates[0];
      init[item.id] = {
        adapter: (best?.adapter as AdapterType) ?? "ical",
        url: best?.url ?? item.url,
        config: best?.config,
      };
    }
    return init;
  });

  function patchOverride(id: string, patch: Partial<Override>) {
    setOverrides((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  function approve(item: PendingSuggestion) {
    const o = overrides[item.id];
    if (
      !confirm(
        `Approve "${item.name}" → ${item.regionId} as ${o.adapter} @ ${o.url}?`,
      )
    ) {
      return;
    }
    setError(null);
    setPendingId(item.id);
    startTransition(async () => {
      try {
        const res = await fetch("/api/sources/approve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            suggestionId: item.id,
            override: o,
          }),
        });
        const json = (await res.json()) as {
          ok: boolean;
          error?: string;
          sourceId?: string;
        };
        if (!json.ok) {
          setError(json.error ?? "Approve failed");
          return;
        }
        setItems((prev) => prev.filter((p) => p.id !== item.id));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setPendingId(null);
      }
    });
  }

  function reject(item: PendingSuggestion) {
    if (!confirm(`Reject and delete "${item.name}"?`)) return;
    setError(null);
    setPendingId(item.id);
    startTransition(async () => {
      try {
        const res = await fetch("/api/sources/reject", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ suggestionId: item.id }),
        });
        const json = (await res.json()) as { ok: boolean; error?: string };
        if (!json.ok) {
          setError(json.error ?? "Reject failed");
          return;
        }
        setItems((prev) => prev.filter((p) => p.id !== item.id));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setPendingId(null);
      }
    });
  }

  if (items.length === 0) {
    return <p className="muted">No pending suggestions right now.</p>;
  }

  return (
    <>
      {error && <p className="hint hint-error">{error}</p>}
      <div className="pending-list">
        {items.map((item) => {
          const o = overrides[item.id];
          const best = item.probe?.candidates[0];
          return (
            <article key={item.id} className="pending-card">
              <header className="pending-card-head">
                <div>
                  <h3>{item.name}</h3>
                  <p className="muted small">
                    {item.regionId}
                    {item.town ? ` · ${item.town}` : ""} · submitted by{" "}
                    {item.submittedBy} on{" "}
                    {new Date(item.submittedAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="pending-card-actions">
                  <button
                    type="button"
                    className="primary-btn"
                    disabled={pendingId === item.id}
                    onClick={() => approve(item)}
                  >
                    {pendingId === item.id ? "Working…" : "Approve"}
                  </button>
                  <button
                    type="button"
                    className="ghost-btn"
                    disabled={pendingId === item.id}
                    onClick={() => reject(item)}
                  >
                    Reject
                  </button>
                </div>
              </header>

              <dl className="pending-card-grid">
                <dt>Submitted URL</dt>
                <dd>
                  <a href={item.url} target="_blank" rel="noopener noreferrer">
                    {item.url}
                  </a>
                </dd>
                {item.notes && (
                  <>
                    <dt>Notes</dt>
                    <dd>{item.notes}</dd>
                  </>
                )}
                <dt>Probe</dt>
                <dd>
                  {item.probe?.candidates && item.probe.candidates.length > 0 ? (
                    <ul className="suggest-probe-list">
                      {item.probe.candidates.map((c, i) => (
                        <li key={i}>
                          <strong>
                            {c.adapter} · {c.verifiedCount} events
                          </strong>{" "}
                          <span
                            className={`health-badge health-${c.confidence === "high" ? "fixed" : "low"}`}
                          >
                            {c.confidence}
                          </span>
                          <br />
                          <span className="muted small">{c.evidence}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="muted small">
                      No automated feed detected. Pick adapter + URL manually below.
                    </span>
                  )}
                </dd>
              </dl>

              <fieldset className="pending-config">
                <legend>Source config (editable before approval)</legend>
                <label>
                  <span>Adapter</span>
                  <select
                    value={o.adapter}
                    onChange={(e) =>
                      patchOverride(item.id, { adapter: e.target.value as AdapterType })
                    }
                    disabled={pendingId === item.id}
                  >
                    {ADAPTERS.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>URL</span>
                  <input
                    value={o.url}
                    onChange={(e) => patchOverride(item.id, { url: e.target.value })}
                    disabled={pendingId === item.id}
                  />
                </label>
                {best?.config && (
                  <p className="muted small">
                    Will use config:{" "}
                    <code>{JSON.stringify(best.config)}</code>
                  </p>
                )}
              </fieldset>
            </article>
          );
        })}
      </div>
    </>
  );
}
