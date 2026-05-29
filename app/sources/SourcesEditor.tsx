"use client";

import { useMemo, useState, useTransition } from "react";
import type { SourceConfig, AdapterType } from "@/lib/types";
import { SortButtons, type SortDir } from "../_components/SortButtons";
import { MultiSelectPicker } from "../_components/MultiSelectPicker";

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
  "elfsight-events",
  "trustees",
  "manual-recurring",
  "manual-oneoff",
  "html-generic",
];

type SourceCol = "enabled" | "name" | "adapter" | "url" | "town" | "category" | "count" | "notes";

type Props = {
  region: string;
  initialSources: SourceConfig[];
  eventCounts: Record<string, number>;
  health: Record<string, SourceHealth>;
  canEdit: boolean;
  /** When true, the table renders open; otherwise it's collapsed inside a <details>. */
  defaultOpen?: boolean;
};

export function SourcesEditor({
  region,
  initialSources,
  eventCounts,
  health,
  canEdit,
  defaultOpen = false,
}: Props) {
  const [sources, setSources] = useState<SourceConfig[]>(initialSources);
  const [isSaving, startSave] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  // ---- Filter + sort state (view-only; not persisted in sources.json) ----
  const [enabledFilter, setEnabledFilter] = useState<Set<string>>(new Set()); // "yes"/"no"
  const [adapterFilter, setAdapterFilter] = useState<Set<string>>(new Set());
  const [townFilter, setTownFilter] = useState<Set<string>>(new Set());
  const [categoryFilter, setCategoryFilter] = useState<Set<string>>(new Set());
  const [nameQuery, setNameQuery] = useState("");
  const [urlQuery, setUrlQuery] = useState("");
  const [notesQuery, setNotesQuery] = useState("");
  const [sortBy, setSortBy] = useState<SourceCol | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  function toggleSort(col: SourceCol, dir: SortDir) {
    if (sortBy === col && sortDir === dir) setSortBy(null);
    else {
      setSortBy(col);
      setSortDir(dir);
    }
  }
  function clearFilters() {
    setEnabledFilter(new Set());
    setAdapterFilter(new Set());
    setTownFilter(new Set());
    setCategoryFilter(new Set());
    setNameQuery("");
    setUrlQuery("");
    setNotesQuery("");
    setSortBy(null);
  }
  const anyFilterActive =
    enabledFilter.size > 0 ||
    adapterFilter.size > 0 ||
    townFilter.size > 0 ||
    categoryFilter.size > 0 ||
    nameQuery !== "" ||
    urlQuery !== "" ||
    notesQuery !== "" ||
    sortBy !== null;

  // Build option lists for the multi-select pickers. Counts reflect the
  // ENTIRE source list for this region, not the filtered view (stable totals).
  const enabledOptions = useMemo(() => {
    const yes = sources.filter((s) => s.enabled).length;
    const no = sources.length - yes;
    return [
      { key: "yes", label: "Enabled", count: yes },
      { key: "no", label: "Disabled", count: no },
    ];
  }, [sources]);
  const adapterOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sources) counts.set(s.adapter, (counts.get(s.adapter) ?? 0) + 1);
    return [...counts.entries()]
      .map(([k, c]) => ({ key: k, label: k, count: c }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [sources]);
  const townOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sources) {
      const t = s.town?.trim();
      if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([k, c]) => ({ key: k, label: k, count: c }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [sources]);
  const categoryOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sources) {
      const c = s.category?.trim();
      if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([k, c]) => ({ key: k, label: k, count: c }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [sources]);

  // ---- Apply filters + sort to derive the visible rows ----
  const visibleSources = useMemo(() => {
    let out = sources.map((s, originalIndex) => ({ source: s, originalIndex }));
    if (enabledFilter.size > 0) {
      out = out.filter(({ source }) =>
        enabledFilter.has(source.enabled ? "yes" : "no"),
      );
    }
    if (adapterFilter.size > 0) {
      out = out.filter(({ source }) => adapterFilter.has(source.adapter));
    }
    if (townFilter.size > 0) {
      out = out.filter(({ source }) => townFilter.has(source.town?.trim() ?? ""));
    }
    if (categoryFilter.size > 0) {
      out = out.filter(({ source }) =>
        categoryFilter.has(source.category?.trim() ?? ""),
      );
    }
    if (nameQuery) {
      const q = nameQuery.toLowerCase();
      out = out.filter(
        ({ source }) =>
          source.name.toLowerCase().includes(q) || source.id.toLowerCase().includes(q),
      );
    }
    if (urlQuery) {
      const q = urlQuery.toLowerCase();
      out = out.filter(({ source }) => source.url.toLowerCase().includes(q));
    }
    if (notesQuery) {
      const q = notesQuery.toLowerCase();
      out = out.filter(({ source }) => (source.notes ?? "").toLowerCase().includes(q));
    }
    if (sortBy) {
      const dir = sortDir === "asc" ? 1 : -1;
      out = [...out].sort((a, b) => dir * compare(a.source, b.source, sortBy, eventCounts));
    }
    return out;
  }, [
    sources,
    enabledFilter,
    adapterFilter,
    townFilter,
    categoryFilter,
    nameQuery,
    urlQuery,
    notesQuery,
    sortBy,
    sortDir,
    eventCounts,
  ]);

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

  // Per-source refresh: dispatches an ingest workflow on GitHub Actions
  // with INGEST_ONLY pinned to one source. Surfaces success/failure inline
  // via the existing error/okMsg banners so admins don't need to hop tabs.
  // Disabled when the row has unsaved edits — refreshing would just pull
  // the persisted version, not what the admin sees on screen.
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  async function refreshSource(id: string, name: string) {
    setError(null);
    setOkMsg(null);
    setRefreshingId(id);
    try {
      const res = await fetch("/api/sources/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ regionId: region, sourceId: id }),
      });
      const raw = await res.text();
      let json:
        | { ok: true; workflowRunUrl?: string }
        | { ok: false; error: string };
      try {
        json = JSON.parse(raw) as typeof json;
      } catch {
        setError(`HTTP ${res.status}: ${raw.slice(0, 200)}`);
        return;
      }
      if (!json.ok) {
        setError(json.error);
        return;
      }
      setOkMsg(
        `Refresh dispatched for "${name}". Results land in ~1–2 min after the workflow finishes.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshingId(null);
    }
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
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  function resetChanges() {
    setSources(initialSources);
    setError(null);
    setOkMsg(null);
  }

  return (
    <div className="sources-editor">
      {canEdit && (
        <div className="sources-editor-toolbar">
          <button
            type="button"
            className="primary-btn"
            onClick={save}
            disabled={isSaving || !dirty}
            title={!dirty ? "No changes to save" : "Commit changes to GitHub"}
          >
            {isSaving ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </button>
          <button
            type="button"
            className="ghost-btn"
            onClick={resetChanges}
            disabled={isSaving || !dirty}
            title={!dirty ? "Nothing to reset" : "Discard unsaved changes"}
          >
            Reset
          </button>
          <button
            type="button"
            className="ghost-btn"
            onClick={addSource}
            disabled={isSaving}
          >
            + Add source
          </button>
          {dirty && <span className="hint">Unsaved changes</span>}
          {error && <pre className="hint hint-error">{error}</pre>}
          {okMsg && <span className="hint hint-ok">{okMsg}</span>}
        </div>
      )}

      <div className="sources-filter-row">
        <p className="muted small">
          Showing {visibleSources.length} of {sources.length} source
          {sources.length === 1 ? "" : "s"}
          {anyFilterActive && (
            <>
              {" "}
              ·{" "}
              <button type="button" className="link-btn" onClick={clearFilters}>
                clear filters
              </button>
            </>
          )}
        </p>
      </div>

      <table className="sources-table">
        <thead>
          <tr className="sources-th-sort">
            <th>
              <SortButtons col="enabled" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
              <MultiSelectPicker
                label="status"
                singularLabel="status"
                selected={enabledFilter}
                onChange={setEnabledFilter}
                options={enabledOptions}
              />
            </th>
            <th>
              <SortButtons col="name" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
              <input
                type="search"
                placeholder="Search name / id…"
                value={nameQuery}
                onChange={(e) => setNameQuery(e.target.value)}
              />
            </th>
            <th>
              <SortButtons col="adapter" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
              <MultiSelectPicker
                label="adapters"
                singularLabel="adapter"
                selected={adapterFilter}
                onChange={setAdapterFilter}
                options={adapterOptions}
              />
            </th>
            <th>
              <SortButtons col="url" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
              <input
                type="search"
                placeholder="Search URL…"
                value={urlQuery}
                onChange={(e) => setUrlQuery(e.target.value)}
              />
            </th>
            <th>
              <SortButtons col="town" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
              <MultiSelectPicker
                label="towns"
                singularLabel="town"
                selected={townFilter}
                onChange={setTownFilter}
                options={townOptions}
              />
            </th>
            <th>
              <SortButtons col="category" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
              <MultiSelectPicker
                label="categories"
                singularLabel="category"
                selected={categoryFilter}
                onChange={setCategoryFilter}
                options={categoryOptions}
              />
            </th>
            <th title="Events ingested on the most recent cron run">
              <SortButtons col="count" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
              <span className="col-filter-label">Events</span>
            </th>
            <th>
              <SortButtons col="notes" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
              <input
                type="search"
                placeholder="Search notes…"
                value={notesQuery}
                onChange={(e) => setNotesQuery(e.target.value)}
              />
            </th>
            {canEdit && <th></th>}
          </tr>
        </thead>
        <tbody>
          {visibleSources.map(({ source: s, originalIndex: i }) => {
            const count = eventCounts[s.id];
            const h = health[s.id];
            // Read-only view (signed-out / regular users) shows plain text.
            // Admin / owner sees inline-editable cells — no Edit-mode toggle.
            if (!canEdit) {
              return (
                <tr key={`${s.id}-${i}`} className={s.enabled ? "" : "row-disabled"}>
                  <td>{s.enabled ? "✓" : "—"}</td>
                  <td>
                    <strong>{s.name}</strong>
                    <br />
                    <span className="muted small">{s.id}</span>
                  </td>
                  <td>
                    <code>{s.adapter}</code>
                  </td>
                  <td className="sources-url-cell">
                    <a href={s.url} target="_blank" rel="noopener noreferrer">
                      {s.url}
                    </a>
                  </td>
                  <td>{s.town ?? "—"}</td>
                  <td>{s.category ?? "—"}</td>
                  <td className="sources-count-cell">
                    {count ?? (s.enabled ? "0" : "—")}
                    {h?.probe?.autoApplied && (
                      <div className="health-badge health-fixed">auto-fixed</div>
                    )}
                    {h && !h.probe?.autoApplied && s.enabled && h.count < 5 && (
                      <div className="health-badge health-low">low yield</div>
                    )}
                    {h?.probe?.candidates && h.probe.candidates.length > 0 && !h.probe.autoApplied && (
                      <div className="health-badge health-info">
                        {h.probe.candidates.length} probe lead
                        {h.probe.candidates.length === 1 ? "" : "s"}
                      </div>
                    )}
                  </td>
                  <td className="sources-notes-cell">
                    <span className="muted small">{s.notes ?? ""}</span>
                  </td>
                </tr>
              );
            }
            return (
              <tr key={`${s.id}-${i}`} className={s.enabled ? "" : "row-disabled"}>
                <td>
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    onChange={(e) => updateSource(i, { enabled: e.target.checked })}
                  />
                </td>
                <td>
                  <input
                    value={s.name}
                    onChange={(e) => updateSource(i, { name: e.target.value })}
                    placeholder="Display name"
                    className="inline-edit"
                  />
                  <input
                    value={s.id}
                    onChange={(e) => updateSource(i, { id: e.target.value })}
                    placeholder="slug-id"
                    className="inline-edit sources-id-input"
                  />
                </td>
                <td>
                  <select
                    value={s.adapter}
                    onChange={(e) =>
                      updateSource(i, { adapter: e.target.value as AdapterType })
                    }
                    className="inline-edit"
                  >
                    {ADAPTERS.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="sources-url-cell">
                  <div className="sources-url-wrap">
                    <input
                      value={s.url}
                      onChange={(e) => updateSource(i, { url: e.target.value })}
                      className="inline-edit"
                    />
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="sources-url-open"
                      title="Open URL in new tab"
                    >
                      ↗
                    </a>
                  </div>
                </td>
                <td>
                  <input
                    value={s.town ?? ""}
                    onChange={(e) => updateSource(i, { town: e.target.value })}
                    className="inline-edit"
                  />
                </td>
                <td>
                  <input
                    value={s.category ?? ""}
                    onChange={(e) => updateSource(i, { category: e.target.value })}
                    className="inline-edit"
                  />
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
                  {/* low-yield threshold matches LOW_YIELD_THRESHOLD (5) in
                   * lib/probe.ts so the inline indicator agrees with the
                   * region-summary count. */}
                  {h && !h.probe?.autoApplied && s.enabled && h.count < 5 && (
                    <div
                      className="health-badge health-low"
                      title={
                        h.probe?.candidates?.length
                          ? `Probe ran, no auto-fix candidate. Top finding: ${h.probe.candidates[0].evidence}`
                          : "Source yielded <5 events. No probe candidate found."
                      }
                    >
                      low yield
                    </div>
                  )}
                  {/* Probe leads: probe surfaced candidate fixes but didn't
                   * auto-apply. Highest-leverage manual-review targets. The
                   * count + top adapter give the admin enough signal to
                   * decide if it's worth investigating before clicking
                   * through to /admin/qc for the full picture. */}
                  {h?.probe?.candidates && h.probe.candidates.length > 0 && !h.probe.autoApplied && (
                    <a
                      href={`/admin/qc#${s.id}`}
                      className="health-badge health-info"
                      title={`${h.probe.candidates.length} candidate${
                        h.probe.candidates.length === 1 ? "" : "s"
                      } found. Top: ${h.probe.candidates[0].adapter} → ${h.probe.candidates[0].verifiedCount} events (${
                        h.probe.candidates[0].confidence
                      } confidence). Click to review in /admin/qc.`}
                    >
                      {h.probe.candidates.length} probe lead
                      {h.probe.candidates.length === 1 ? "" : "s"} ↗
                    </a>
                  )}
                </td>
                <td className="sources-notes-cell">
                  <textarea
                    value={s.notes ?? ""}
                    onChange={(e) => updateSource(i, { notes: e.target.value })}
                    rows={2}
                    className="inline-edit"
                  />
                </td>
                <td>
                  <div style={{ display: "flex", gap: "0.3rem", alignItems: "center" }}>
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => refreshSource(s.id, s.name)}
                      disabled={refreshingId === s.id || isSaving || dirty}
                      title={
                        dirty
                          ? "Save your edits first — refresh re-ingests the persisted source."
                          : `Refresh "${s.name}" — runs ingest for just this source on GitHub Actions (~1–2 min).`
                      }
                      style={{ fontSize: "1.05rem" }}
                    >
                      {refreshingId === s.id ? "…" : "↻"}
                    </button>
                    <button
                      type="button"
                      className="link-btn sources-delete-btn"
                      onClick={() => deleteSource(i)}
                      title="Delete this source"
                    >
                      ×
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
          {visibleSources.length === 0 && (
            <tr>
              <td colSpan={canEdit ? 9 : 8} className="muted small">
                No sources match the current filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  // Hint to TS that defaultOpen is "used" — it's read by the parent <details>
  // wrapper on the page, but importing this prop tells TS it's intentional.
  void defaultOpen;
}

function compare(
  a: SourceConfig,
  b: SourceConfig,
  col: SourceCol,
  eventCounts: Record<string, number>,
): number {
  function strKey(s: SourceConfig): string {
    switch (col) {
      case "enabled":
        return s.enabled ? "0" : "1"; // enabled (✓) sorts first ascending
      case "name":
        return s.name.toLowerCase();
      case "adapter":
        return s.adapter;
      case "url":
        return s.url.toLowerCase();
      case "town":
        return s.town?.toLowerCase() ?? "";
      case "category":
        return s.category?.toLowerCase() ?? "";
      case "notes":
        return s.notes?.toLowerCase() ?? "";
      default:
        return "";
    }
  }
  if (col === "count") {
    return (eventCounts[a.id] ?? -1) - (eventCounts[b.id] ?? -1);
  }
  return strKey(a).localeCompare(strKey(b), undefined, {
    sensitivity: "base",
    numeric: true,
  });
}
