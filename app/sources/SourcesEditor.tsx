"use client";

import { useMemo, useState, useTransition } from "react";
import type { SourceConfig, AdapterType } from "@/lib/types";

export type SourceHealth = {
  count: number;
  warnings: string[];
  probe?: {
    candidates: Array<{
      confidence: "high" | "medium" | "low";
      verifiedCount: number;
      adapter: string;
      url: string;
      evidence: string;
    }>;
    autoApplied?: {
      from: { adapter: string; url: string };
      to: { adapter: string; url: string };
      reason: string;
      newCount: number;
    };
  };
};

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

type Props = {
  region: string;
  initialSources: SourceConfig[];
  eventCounts: Record<string, number>;
  health: Record<string, SourceHealth>;
  canEdit: boolean;
};

export function SourcesEditor({
  region,
  initialSources,
  eventCounts,
  health,
  canEdit,
}: Props) {
  const [sources, setSources] = useState<SourceConfig[]>(initialSources);
  const [editing, setEditing] = useState(false);
  const [isSaving, startSave] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const dirty = useMemo(
    () => JSON.stringify(sources) !== JSON.stringify(initialSources),
    [sources, initialSources],
  );

  function updateSource(idx: number, patch: Partial<SourceConfig>) {
    setSources((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }
  function deleteSource(idx: number) {
    if (!confirm(`Delete source "${sources[idx].name}"?`)) return;
    setSources((prev) => prev.filter((_, i) => i !== idx));
  }
  function addSource() {
    const newId = `new-source-${Date.now().toString(36).slice(-4)}`;
    setSources((prev) => [
      ...prev,
      {
        id: newId,
        name: "(new source)",
        enabled: false,
        adapter: "ical",
        url: "https://",
        town: "",
        category: "",
        notes: "",
      },
    ]);
  }

  function save() {
    setError(null);
    setOkMsg(null);
    startSave(async () => {
      try {
        const res = await fetch("/api/sources", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ region, sources }),
        });
        const json = (await res.json()) as
          | {
              ok: true;
              commitSha?: string;
              rescan?: { triggered: boolean; error?: string };
            }
          | { ok: false; error: string; details?: string[] };
        if (!json.ok) {
          setError(
            json.details && json.details.length > 0
              ? `${json.error}\n${json.details.join("\n")}`
              : json.error,
          );
          return;
        }
        const sha = json.commitSha?.slice(0, 7) ?? "?";
        const rescanNote = json.rescan?.triggered
          ? "Re-scanning the region now — fresh event counts in ~2 min."
          : json.rescan?.error
            ? `Saved, but auto-rescan failed (${json.rescan.error}). Manually trigger the workflow from GitHub Actions.`
            : "Vercel will redeploy with the new config; events refresh tomorrow on the daily cron.";
        setOkMsg(`Saved · commit ${sha} · ${rescanNote}`);
        setEditing(false);
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  function cancel() {
    setSources(initialSources);
    setEditing(false);
    setError(null);
    setOkMsg(null);
  }

  return (
    <div className="sources-editor">
      {canEdit && (
        <div className="sources-editor-toolbar">
          {!editing ? (
            <button type="button" className="primary-btn" onClick={() => setEditing(true)}>
              Edit
            </button>
          ) : (
            <>
              <button
                type="button"
                className="primary-btn"
                onClick={save}
                disabled={isSaving || !dirty}
                title={!dirty ? "No changes" : "Commit changes to GitHub"}
              >
                {isSaving ? "Saving…" : "Save (commit to GitHub)"}
              </button>
              <button type="button" className="ghost-btn" onClick={cancel} disabled={isSaving}>
                Cancel
              </button>
              <button type="button" className="ghost-btn" onClick={addSource} disabled={isSaving}>
                + Add source
              </button>
              {dirty && <span className="hint">Unsaved changes</span>}
            </>
          )}
          {error && <pre className="hint hint-error">{error}</pre>}
          {okMsg && <span className="hint hint-ok">{okMsg}</span>}
        </div>
      )}

      <table className="sources-table">
        <thead>
          <tr>
            <th>On</th>
            <th>Name</th>
            <th>Adapter</th>
            <th>URL</th>
            <th>Town</th>
            <th>Category</th>
            <th title="Events ingested on the most recent cron run">Events</th>
            <th>Notes</th>
            {editing && <th></th>}
          </tr>
        </thead>
        <tbody>
          {sources.map((s, i) => {
            const count = eventCounts[s.id];
            const h = health[s.id];
            return (
              <tr key={`${s.id}-${i}`} className={s.enabled ? "" : "row-disabled"}>
                <td>
                  {editing ? (
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      onChange={(e) => updateSource(i, { enabled: e.target.checked })}
                    />
                  ) : s.enabled ? (
                    "✓"
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  {editing ? (
                    <>
                      <input
                        value={s.name}
                        onChange={(e) => updateSource(i, { name: e.target.value })}
                        placeholder="Display name"
                      />
                      <input
                        value={s.id}
                        onChange={(e) => updateSource(i, { id: e.target.value })}
                        placeholder="slug-id"
                        className="sources-id-input"
                      />
                    </>
                  ) : (
                    <>
                      <strong>{s.name}</strong>
                      <br />
                      <span className="muted small">{s.id}</span>
                    </>
                  )}
                </td>
                <td>
                  {editing ? (
                    <select
                      value={s.adapter}
                      onChange={(e) =>
                        updateSource(i, { adapter: e.target.value as AdapterType })
                      }
                    >
                      {ADAPTERS.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <code>{s.adapter}</code>
                  )}
                </td>
                <td className="sources-url-cell">
                  {editing ? (
                    <input
                      value={s.url}
                      onChange={(e) => updateSource(i, { url: e.target.value })}
                    />
                  ) : (
                    <a href={s.url} target="_blank" rel="noopener noreferrer">
                      {s.url}
                    </a>
                  )}
                </td>
                <td>
                  {editing ? (
                    <input
                      value={s.town ?? ""}
                      onChange={(e) => updateSource(i, { town: e.target.value })}
                    />
                  ) : (
                    s.town ?? "—"
                  )}
                </td>
                <td>
                  {editing ? (
                    <input
                      value={s.category ?? ""}
                      onChange={(e) => updateSource(i, { category: e.target.value })}
                    />
                  ) : (
                    s.category ?? "—"
                  )}
                </td>
                <td className="sources-count-cell">
                  {count ?? (s.enabled ? "0" : "—")}
                  {h?.probe?.autoApplied && (
                    <div
                      className="health-badge health-fixed"
                      title={`Auto-fixed: ${h.probe.autoApplied.reason}`}
                    >
                      auto-fixed
                    </div>
                  )}
                  {h && !h.probe?.autoApplied && s.enabled && h.count <= 1 && (
                    <div
                      className="health-badge health-low"
                      title={
                        h.probe?.candidates?.length
                          ? `Probe ran, no auto-fix candidate. Top finding: ${h.probe.candidates[0].evidence}`
                          : "Source yielded ≤1 events. No probe candidate found."
                      }
                    >
                      low yield
                    </div>
                  )}
                </td>
                <td className="sources-notes-cell">
                  {editing ? (
                    <textarea
                      value={s.notes ?? ""}
                      onChange={(e) => updateSource(i, { notes: e.target.value })}
                      rows={2}
                    />
                  ) : (
                    <span className="muted small">{s.notes ?? ""}</span>
                  )}
                </td>
                {editing && (
                  <td>
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => deleteSource(i)}
                      title="Delete this source"
                    >
                      ×
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
