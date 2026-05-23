"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { EVENT_TYPES, TYPE_LABELS, type EventType } from "@/lib/categorize";
import { haversineMiles } from "@/lib/towns";
import type { EventRecord } from "@/lib/types";

type RegionPayload = {
  id: string;
  displayName: string;
  tagline?: string;
  defaultCenter: { label: string; lat: number; lon: number };
  defaultRadiusMi: number;
  timeZone: string;
  locale: string;
  language: string;
  centerSuggestions?: string[];
};

export type EventsPayload = {
  region: RegionPayload;
  generatedAt: string;
  count: number;
  events: EventRecord[];
};

export type RegionManifestEntry = RegionPayload & {
  eventCount: number;
  eventsPath: string;
  generatedAt: string;
};

export type RegionsManifest = {
  generatedAt: string;
  defaultRegionId: string;
  regions: RegionManifestEntry[];
};

const ANY = "__any__";
const NO_LOCATION = "__no_location__";
const CUSTOM = "__custom__";

// Sentinel prefix for "all events from a source" meta options in the venue
// picker (e.g. "Trustees (all events)" → matches any event whose source.id is
// "trustees", regardless of venue). Selected value looks like "__src:trustees__".
const SRC_PREFIX = "__src:";
const srcKey = (sourceId: string) => `${SRC_PREFIX}${sourceId}__`;

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function todayLocalIso(): string {
  const now = new Date();
  const tzOffsetMin = now.getTimezoneOffset();
  const local = new Date(now.getTime() - tzOffsetMin * 60_000);
  return local.toISOString().slice(0, 10);
}

function formatDayHeading(iso: string, tz: string, locale: string): string {
  return new Date(iso + "T12:00:00Z").toLocaleDateString(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: tz,
  });
}

function formatTime(iso: string, tz: string, locale: string, allDay?: boolean): string {
  if (allDay) return "All day";
  return new Date(iso).toLocaleTimeString(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  });
}

function formatRefreshedAt(iso: string, tz: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, {
    timeZone: tz,
    dateStyle: "medium",
    timeStyle: "short",
  });
}

type CenterState = {
  // sentinel value: ANY (none), NO_LOCATION, CUSTOM (resolved), or a suggestion label
  mode: typeof ANY | typeof NO_LOCATION | "resolved";
  label: string;
  lat?: number;
  lon?: number;
};

export default function EventsView({
  initial,
  manifest,
  canRefresh = true,
}: {
  initial: EventsPayload;
  manifest?: RegionsManifest;
  canRefresh?: boolean;
}) {
  const [payload, setPayload] = useState<EventsPayload>(initial);
  const region = payload.region;
  const [selectedTypes, setSelectedTypes] = useState<Set<EventType>>(new Set());

  // Per-column quick filters. Town and Venue are multi-select sets; Title is
  // a free-text substring search.
  const [colTowns, setColTowns] = useState<Set<string>>(new Set());
  const [colVenues, setColVenues] = useState<Set<string>>(new Set());
  const [colTitle, setColTitle] = useState("");

  // Per-column sort. null = default day-grouped view. When set, the entire
  // filtered list is sorted by the chosen column and day-grouping is suspended.
  const [sortBy, setSortBy] = useState<SortableColumn | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  function toggleSort(col: SortableColumn, dir: "asc" | "desc") {
    if (sortBy === col && sortDir === dir) {
      setSortBy(null);
    } else {
      setSortBy(col);
      setSortDir(dir);
    }
  }
  function clearSort() {
    setSortBy(null);
  }

  const [isSwitchingRegion, startRegionSwitch] = useTransition();
  const [regionError, setRegionError] = useState<string | null>(null);
  const [center, setCenter] = useState<CenterState>({ mode: ANY, label: "" });
  const [centerQuery, setCenterQuery] = useState<string>("");
  const [centerLookupError, setCenterLookupError] = useState<string | null>(null);
  const [isLookingUpCenter, startCenterLookup] = useTransition();
  const [distanceMi, setDistanceMi] = useState<number>(region.defaultRadiusMi);
  const [fromDate, setFromDate] = useState<string>(todayLocalIso());
  const [toDate, setToDate] = useState<string>("");
  const [isRefreshing, startRefresh] = useTransition();
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const filterDistance = center.mode === "resolved" && center.lat != null && center.lon != null;
  const filterNoLocation = center.mode === NO_LOCATION;

  // Distinct towns + venues with event counts, alphabetized. Counts are based
  // on the full region payload (NOT the post-filter set) so the dropdown shows
  // stable totals regardless of other active filters.
  const columnTownOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ev of payload.events) {
      const t = ev.location?.town?.trim();
      if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      );
  }, [payload.events]);

  // Venue options include source-group meta items so users can pick "all
  // events from Trustees" without having to tick each Trustees property
  // individually. A meta item has key `__src:trustees__` and label
  // `Trustees (all events)` so it sorts alphabetically with regular venues.
  const columnVenueOptions = useMemo(() => {
    const venueCounts = new Map<string, number>();
    const sourceGroups = new Map<
      string,
      { count: number; label: string }
    >();

    for (const ev of payload.events) {
      const v = ev.location?.venue?.trim();
      if (v) venueCounts.set(v, (venueCounts.get(v) ?? 0) + 1);
      // Detect org suffix in venue name like "The Old Manse (Trustees)" — that
      // identifies a multi-venue parent source we can offer as a meta option.
      if (v) {
        const m = v.match(/\(([^()]+)\)\s*$/);
        if (m) {
          const label = m[1].trim();
          const cur = sourceGroups.get(ev.source.id);
          if (cur) cur.count++;
          else sourceGroups.set(ev.source.id, { count: 1, label });
        }
      }
    }

    type Item = { key: string; label: string; count: number; isGroup: boolean };
    const items: Item[] = [
      ...[...venueCounts.entries()].map(([name, count]) => ({
        key: name,
        label: name,
        count,
        isGroup: false,
      })),
      ...[...sourceGroups.entries()].map(([sourceId, info]) => ({
        key: srcKey(sourceId),
        label: `${info.label} (all events)`,
        count: info.count,
        isGroup: true,
      })),
    ].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
    );
    return items;
  }, [payload.events]);

  const filtered = useMemo(() => {
    const fromTs = fromDate ? new Date(fromDate + "T00:00:00").getTime() : -Infinity;
    const toTs = toDate ? new Date(toDate + "T23:59:59").getTime() : Infinity;

    return payload.events
      .map((ev) => {
        const evLat = ev.location?.lat;
        const evLon = ev.location?.lon;
        const hasCoords = evLat != null && evLon != null;
        const distance =
          filterDistance && hasCoords
            ? haversineMiles({ lat: center.lat!, lon: center.lon! }, { lat: evLat, lon: evLon })
            : undefined;
        return { ev, distance, hasCoords };
      })
      .filter(({ ev, distance, hasCoords }) => {
        const ts = new Date(ev.start).getTime();
        if (ts < fromTs || ts > toTs) return false;
        if (selectedTypes.size > 0 && !selectedTypes.has(ev.type)) return false;
        // Per-column quick filters. Town and venue are multi-select; an empty
        // set means no filter. Venue set may include `__src:<id>__` meta keys
        // matching the event's source.id (covers "Trustees all events").
        if (colTowns.size > 0 && !colTowns.has(ev.location?.town ?? "")) return false;
        if (colVenues.size > 0) {
          const v = ev.location?.venue ?? "";
          const venueMatch = colVenues.has(v);
          const sourceMatch = colVenues.has(srcKey(ev.source.id));
          if (!venueMatch && !sourceMatch) return false;
        }
        if (colTitle) {
          const q = colTitle.toLowerCase();
          const hay = `${ev.title} ${ev.description ?? ""}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        if (filterNoLocation) return !hasCoords;
        if (filterDistance) {
          if (!hasCoords) return false;
          if ((distance ?? Infinity) > distanceMi) return false;
        }
        return true;
      });
  }, [payload.events, selectedTypes, colTowns, colVenues, colTitle, filterDistance, filterNoLocation, center.lat, center.lon, distanceMi, fromDate, toDate]);

  // When a sort is active, flatten into a single ordered list (no day groups).
  const sortedFlat = useMemo(() => {
    if (!sortBy) return null;
    const dir = sortDir === "asc" ? 1 : -1;
    const key = (it: (typeof filtered)[number]): string => {
      const ev = it.ev;
      switch (sortBy) {
        case "time":
          return ev.start;
        case "town":
          return ev.location?.town ?? "￿";
        case "venue":
          return ev.location?.venue ?? "￿";
        case "type":
          return TYPE_LABELS[ev.type];
        case "title":
          return ev.title;
      }
    };
    return [...filtered].sort((a, b) =>
      dir * key(a).localeCompare(key(b), undefined, { sensitivity: "base", numeric: true }),
    );
  }, [filtered, sortBy, sortDir]);

  const byDay = useMemo(() => {
    if (sortedFlat) return null; // flat sort suppresses day grouping
    const map = new Map<string, typeof filtered>();
    for (const item of filtered) {
      const k = dayKey(item.ev.start);
      const list = map.get(k) ?? [];
      list.push(item);
      map.set(k, list);
    }
    return map;
  }, [filtered, sortedFlat]);

  function toggleType(t: EventType) {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  function handleRefresh() {
    setRefreshError(null);
    startRefresh(async () => {
      try {
        const res = await fetch("/api/refresh", { method: "POST" });
        const json = (await res.json()) as
          | { ok: true; payload: EventsPayload }
          | { ok: false; error: string };
        if (!json.ok) throw new Error(json.error);
        setPayload(json.payload);
      } catch (err) {
        setRefreshError((err as Error).message);
      }
    });
  }

  function handleRegionChange(nextRegionId: string) {
    if (nextRegionId === region.id) return;
    const entry = manifest?.regions.find((r) => r.id === nextRegionId);
    if (!entry) return;
    setRegionError(null);
    startRegionSwitch(async () => {
      try {
        const res = await fetch(entry.eventsPath, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status} loading ${entry.eventsPath}`);
        const nextPayload = (await res.json()) as EventsPayload;
        setPayload(nextPayload);
        // Reset filters that don't make sense across regions.
        setCenter({ mode: ANY, label: "" });
        setCenterQuery("");
        setColTowns(new Set());
        setColVenues(new Set());
        setColTitle("");
      } catch (err) {
        setRegionError((err as Error).message);
      }
    });
  }

  function applyCenter(query: string) {
    const q = query.trim();
    if (!q) {
      setCenter({ mode: ANY, label: "" });
      setCenterLookupError(null);
      return;
    }
    setCenterLookupError(null);
    startCenterLookup(async () => {
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
        if (res.status === 404) {
          setCenterLookupError(`No location found for "${q}".`);
          return;
        }
        if (!res.ok) {
          setCenterLookupError(`Lookup failed (HTTP ${res.status}).`);
          return;
        }
        const json = (await res.json()) as {
          ok: boolean;
          lat: number;
          lon: number;
          displayName?: string;
        };
        if (!json.ok) {
          setCenterLookupError("Lookup failed.");
          return;
        }
        setCenter({
          mode: "resolved",
          label: json.displayName ?? q,
          lat: json.lat,
          lon: json.lon,
        });
      } catch (err) {
        setCenterLookupError((err as Error).message);
      }
    });
  }

  function clearCenter() {
    setCenter({ mode: ANY, label: "" });
    setCenterQuery("");
    setCenterLookupError(null);
  }

  const hasMultipleRegions = !!manifest && manifest.regions.length > 1;

  return (
    <main>
      <header>
        <div className="header-row">
          <h1>{region.displayName}</h1>
          {hasMultipleRegions && (
            <label className="region-selector">
              <span className="region-selector-label">Region</span>
              <select
                value={region.id}
                onChange={(e) => handleRegionChange(e.target.value)}
                disabled={isSwitchingRegion}
              >
                {manifest!.regions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.displayName} ({r.eventCount})
                  </option>
                ))}
              </select>
              {isSwitchingRegion && <span className="region-loading">Loading…</span>}
            </label>
          )}
        </div>
        <p className="muted">
          Last refreshed {formatRefreshedAt(payload.generatedAt, region.timeZone, region.locale)} ·{" "}
          {payload.events.length} ingested events ({filtered.length} match filters)
        </p>
        {regionError && <p className="error">Region load failed: {regionError}</p>}
      </header>

      <section className="filters">
        <div className="filter-row">
          <div className="filter-group filter-types">
            <span className="filter-label">
              Types {selectedTypes.size > 0 && `(${selectedTypes.size})`}
              {selectedTypes.size > 0 && (
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => setSelectedTypes(new Set())}
                >
                  clear
                </button>
              )}
            </span>
            <div className="type-chips">
              {EVENT_TYPES.map((t) => {
                const on = selectedTypes.has(t);
                return (
                  <button
                    key={t}
                    type="button"
                    className={`type-chip type-${t} ${on ? "on" : "off"}`}
                    onClick={() => toggleType(t)}
                    aria-pressed={on}
                  >
                    {TYPE_LABELS[t]}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="filter-row">
          <label className="grow">
            <span>Center on</span>
            <div className="center-input-wrap">
              <input
                type="text"
                placeholder='Address, city, or ZIP (e.g. "Dover, MA")'
                list="center-suggestions"
                value={centerQuery}
                onChange={(e) => setCenterQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    applyCenter(centerQuery);
                  }
                }}
              />
              <button
                type="button"
                className="ghost-btn"
                onClick={() => applyCenter(centerQuery)}
                disabled={isLookingUpCenter || !centerQuery.trim()}
              >
                {isLookingUpCenter ? "Locating…" : "Set"}
              </button>
              {center.mode === "resolved" && (
                <button type="button" className="ghost-btn" onClick={clearCenter}>
                  Clear
                </button>
              )}
              <button
                type="button"
                className={`ghost-btn ${center.mode === NO_LOCATION ? "active" : ""}`}
                onClick={() =>
                  center.mode === NO_LOCATION
                    ? clearCenter()
                    : setCenter({ mode: NO_LOCATION, label: "No location" })
                }
              >
                No location
              </button>
            </div>
            {region.centerSuggestions && (
              <datalist id="center-suggestions">
                {region.centerSuggestions.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            )}
            {center.mode === "resolved" && (
              <span className="hint">Centered on: {center.label}</span>
            )}
            {centerLookupError && <span className="hint hint-error">{centerLookupError}</span>}
          </label>

          <label className={filterDistance ? "" : "disabled"}>
            <span>Within (mi)</span>
            <input
              type="number"
              min={1}
              max={500}
              step={1}
              value={distanceMi}
              disabled={!filterDistance}
              onChange={(e) => setDistanceMi(Math.max(1, Number(e.target.value) || 0))}
            />
          </label>

          <label>
            <span>From</span>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
            />
          </label>

          <label>
            <span>To</span>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </label>

          {canRefresh && (
            <button
              type="button"
              className="refresh-btn"
              onClick={handleRefresh}
              disabled={isRefreshing}
            >
              {isRefreshing ? "Refreshing…" : "Refresh data"}
            </button>
          )}
        </div>
      </section>

      {refreshError && <p className="error">Refresh failed: {refreshError}</p>}

      <div className="col-filter-row" role="search">
        <div className="col-filter col-time">
          <SortButtons col="time" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
          <span className="col-filter-label">Time</span>
        </div>
        <div className="col-filter col-town">
          <SortButtons col="town" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
          <MultiSelectPicker
            label="towns"
            singularLabel="town"
            selected={colTowns}
            onChange={setColTowns}
            options={columnTownOptions.map((t) => ({ key: t.name, label: t.name, count: t.count }))}
          />
        </div>
        <div className="col-filter col-venue">
          <SortButtons col="venue" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
          <MultiSelectPicker
            label="venues"
            singularLabel="venue"
            selected={colVenues}
            onChange={setColVenues}
            options={columnVenueOptions}
          />
        </div>
        <div className="col-filter col-type">
          <SortButtons col="type" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
          <span className="col-filter-label">Type</span>
        </div>
        <div className="col-filter col-event">
          <SortButtons col="title" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
          <input
            type="search"
            placeholder="Title / description…"
            aria-label="Filter by event title or description"
            value={colTitle}
            onChange={(e) => setColTitle(e.target.value)}
          />
        </div>
        {(colTowns.size > 0 || colVenues.size > 0 || colTitle || sortBy) && (
          <button
            type="button"
            className="link-btn col-filter-clear"
            onClick={() => {
              setColTowns(new Set());
              setColVenues(new Set());
              setColTitle("");
              clearSort();
            }}
          >
            clear filters &amp; sort
          </button>
        )}
      </div>

      {(sortedFlat ? sortedFlat.length === 0 : byDay && byDay.size === 0) && (
        <p className="empty">
          No events match the current filters. Try clearing types, widening the distance, or
          extending the date range.
        </p>
      )}

      {sortedFlat && (
        <section className="day-group">
          <h2 className="day-heading">
            Sorted by {sortBy} ({sortDir === "asc" ? "A → Z" : "Z → A"}) · {sortedFlat.length} events
          </h2>
          <table className="events-table">
            <tbody>
              {sortedFlat.map(({ ev, distance }) => (
                <tr key={ev.id} className="event-row">
                  <td className="col-time">
                    <span className="event-row-date">
                      {new Date(ev.start).toLocaleDateString(region.locale, {
                        timeZone: region.timeZone,
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                    <br />
                    {formatTime(ev.start, region.timeZone, region.locale, ev.allDay)}
                  </td>
                  <td className="col-town">
                    {ev.location?.town ?? "—"}
                    {distance !== undefined && (
                      <span className="distance"> · {distance.toFixed(1)} mi</span>
                    )}
                  </td>
                  <td className="col-venue">{ev.location?.venue ?? "—"}</td>
                  <td className="col-type">
                    <span className={`type-pill type-${ev.type}`}>{TYPE_LABELS[ev.type]}</span>
                  </td>
                  <td className="col-event">
                    <a
                      href={ev.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="event-title"
                    >
                      {ev.title}
                    </a>
                    {ev.description && (
                      <p className="event-description">
                        {ev.description.length > 200
                          ? ev.description.slice(0, 197).trimEnd() + "…"
                          : ev.description}
                      </p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {!sortedFlat &&
        byDay &&
        [...byDay.entries()].map(([day, list]) => (
          <section key={day} className="day-group">
            <h2 className="day-heading">
              {formatDayHeading(day, region.timeZone, region.locale)}
            </h2>
            <table className="events-table">
              <tbody>
                {list.map(({ ev, distance }) => (
                  <tr key={ev.id} className="event-row">
                    <td className="col-time">
                      {formatTime(ev.start, region.timeZone, region.locale, ev.allDay)}
                    </td>
                    <td className="col-town">
                      {ev.location?.town ?? "—"}
                      {distance !== undefined && (
                        <span className="distance"> · {distance.toFixed(1)} mi</span>
                      )}
                    </td>
                    <td className="col-venue">{ev.location?.venue ?? "—"}</td>
                    <td className="col-type">
                      <span className={`type-pill type-${ev.type}`}>{TYPE_LABELS[ev.type]}</span>
                    </td>
                    <td className="col-event">
                      <a
                        href={ev.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="event-title"
                      >
                        {ev.title}
                      </a>
                      {ev.description && (
                        <p className="event-description">
                          {ev.description.length > 200
                            ? ev.description.slice(0, 197).trimEnd() + "…"
                            : ev.description}
                        </p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}

      <footer>
        Region: <code>{region.id}</code> · See <code>config/regions/{region.id}/sources.json</code>{" "}
        for configured sources.
      </footer>
    </main>
  );
}

type SortableColumn = "time" | "town" | "venue" | "type" | "title";

function SortButtons({
  col,
  sortBy,
  sortDir,
  onToggle,
}: {
  col: SortableColumn;
  sortBy: SortableColumn | null;
  sortDir: "asc" | "desc";
  onToggle: (col: SortableColumn, dir: "asc" | "desc") => void;
}) {
  const ascActive = sortBy === col && sortDir === "asc";
  const descActive = sortBy === col && sortDir === "desc";
  return (
    <span className="sort-buttons" role="group" aria-label={`Sort by ${col}`}>
      <button
        type="button"
        className={`sort-btn${ascActive ? " active" : ""}`}
        onClick={() => onToggle(col, "asc")}
        aria-pressed={ascActive}
        title={`Sort ${col} A → Z`}
      >
        ▲
      </button>
      <button
        type="button"
        className={`sort-btn${descActive ? " active" : ""}`}
        onClick={() => onToggle(col, "desc")}
        aria-pressed={descActive}
        title={`Sort ${col} Z → A`}
      >
        ▼
      </button>
    </span>
  );
}

type MultiSelectOption = {
  key: string;
  label: string;
  count: number;
  isGroup?: boolean;
};

function MultiSelectPicker({
  label,
  singularLabel,
  selected,
  onChange,
  options,
}: {
  label: string;
  singularLabel: string;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  options: MultiSelectOption[];
}) {
  const [query, setQuery] = useState("");
  const visible = query
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options;

  function toggle(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  }

  const summary =
    selected.size === 0
      ? `All ${label} (${options.length})`
      : selected.size === 1
        ? // Show the single selected label inline; truncate if too long
          (() => {
            const k = [...selected][0];
            const found = options.find((o) => o.key === k);
            return found ? found.label : `1 ${singularLabel}`;
          })()
        : `${selected.size} ${label}`;

  return (
    <details className="col-multi">
      <summary>
        <span className="col-multi-summary">{summary}</span>
        {selected.size > 0 && (
          <button
            type="button"
            className="link-btn"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onChange(new Set());
            }}
            title={`Clear ${label} filter`}
          >
            ×
          </button>
        )}
      </summary>
      <div className="col-multi-popover">
        <input
          type="search"
          placeholder={`Search ${options.length} ${label}…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="col-multi-search"
        />
        <div className="col-multi-list">
          {visible.length === 0 && (
            <p className="empty muted small">No {label} match &ldquo;{query}&rdquo;.</p>
          )}
          {visible.map((o) => (
            <label
              key={o.key}
              className={`col-multi-item${o.isGroup ? " col-multi-item-group" : ""}`}
            >
              <input
                type="checkbox"
                checked={selected.has(o.key)}
                onChange={() => toggle(o.key)}
              />
              <span className="col-multi-name">{o.label}</span>
              <span className="col-multi-count">{o.count}</span>
            </label>
          ))}
        </div>
      </div>
    </details>
  );
}
