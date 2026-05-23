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
const NO_VENUE = "__no_venue__";

// Sentinel prefix for "all events from a source" meta options in the venue
// picker. Selected value looks like "__src:trustees__".
const SRC_PREFIX = "__src:";
const srcKey = (sourceId: string) => `${SRC_PREFIX}${sourceId}__`;
const srcKeyToId = (key: string) =>
  key.startsWith(SRC_PREFIX) && key.endsWith("__") ? key.slice(SRC_PREFIX.length, -2) : null;

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
  const [selectedVenues, setSelectedVenues] = useState<Set<string>>(new Set());
  const [venueSearch, setVenueSearch] = useState<string>("");

  // Per-column quick filters (text substring match per column).
  const [colTown, setColTown] = useState("");
  const [colVenue, setColVenue] = useState("");
  const [colTitle, setColTitle] = useState("");

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

  // Distinct venues with counts (sorted alphabetically) + source-group meta
  // options for sources whose venue names carry an org suffix like
  // "The Old Manse (Trustees)". A group option lets the user pick all events
  // from that organization regardless of which specific venue.
  const venueOptions = useMemo(() => {
    const counts = new Map<string, number>();
    let noVenueCount = 0;
    const sourceTotals = new Map<string, { sourceName: string; count: number; label: string }>();

    for (const ev of payload.events) {
      const v = ev.location?.venue?.trim();
      if (!v) {
        noVenueCount++;
        continue;
      }
      counts.set(v, (counts.get(v) ?? 0) + 1);
      // Look for org suffix "(...)" at the end of the venue.
      const m = v.match(/\(([^()]+)\)\s*$/);
      if (m) {
        const label = m[1].trim();
        const existing = sourceTotals.get(ev.source.id);
        if (existing) {
          existing.count++;
        } else {
          sourceTotals.set(ev.source.id, { sourceName: ev.source.name, label, count: 1 });
        }
      }
    }

    // Merge specific venues and source-group meta options into one alphabetized
    // list. Group options use a sentinel key ("__src:trustees__") so the
    // filter logic can distinguish them, and a display label that sorts
    // alphabetically alongside venues ("Trustees (all events)" → T).
    type Item = { key: string; label: string; count: number; isGroup: boolean };
    const items: Item[] = [
      ...[...counts.entries()].map(([name, count]) => ({
        key: name,
        label: name,
        count,
        isGroup: false,
      })),
      ...[...sourceTotals.entries()].map(([sourceId, info]) => ({
        key: srcKey(sourceId),
        label: `${info.label} (all events)`,
        count: info.count,
        isGroup: true,
      })),
    ].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
    );

    return { items, noVenueCount };
  }, [payload.events]);

  const visibleVenueOptions = useMemo(() => {
    const q = venueSearch.trim().toLowerCase();
    if (!q) return venueOptions.items;
    return venueOptions.items.filter((v) => v.label.toLowerCase().includes(q));
  }, [venueOptions.items, venueSearch]);

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
        if (selectedVenues.size > 0) {
          const v = ev.location?.venue?.trim();
          const venueKey = v || NO_VENUE;
          const sourceMatch = selectedVenues.has(srcKey(ev.source.id));
          const venueMatch = selectedVenues.has(venueKey);
          if (!sourceMatch && !venueMatch) return false;
        }
        // Per-column quick filters (case-insensitive substring match).
        if (colTown && !(ev.location?.town ?? "").toLowerCase().includes(colTown.toLowerCase()))
          return false;
        if (colVenue && !(ev.location?.venue ?? "").toLowerCase().includes(colVenue.toLowerCase()))
          return false;
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
  }, [payload.events, selectedTypes, selectedVenues, colTown, colVenue, colTitle, filterDistance, filterNoLocation, center.lat, center.lon, distanceMi, fromDate, toDate]);

  const byDay = useMemo(() => {
    const map = new Map<string, typeof filtered>();
    for (const item of filtered) {
      const k = dayKey(item.ev.start);
      const list = map.get(k) ?? [];
      list.push(item);
      map.set(k, list);
    }
    return map;
  }, [filtered]);

  function toggleType(t: EventType) {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  function toggleVenue(key: string) {
    setSelectedVenues((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
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
        setSelectedVenues(new Set());
        setColTown("");
        setColVenue("");
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
          <details className="venue-filter">
            <summary>
              Venues{" "}
              {selectedVenues.size > 0 && (
                <span className="filter-count">({selectedVenues.size})</span>
              )}
              {selectedVenues.size > 0 && (
                <button
                  type="button"
                  className="link-btn"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSelectedVenues(new Set());
                  }}
                >
                  clear
                </button>
              )}
            </summary>
            <div className="venue-popover">
              <input
                type="search"
                placeholder={`Search ${venueOptions.items.length} venues…`}
                value={venueSearch}
                onChange={(e) => setVenueSearch(e.target.value)}
                className="venue-search"
              />
              <div className="venue-list">
                {venueOptions.noVenueCount > 0 && (
                  <label className="venue-item">
                    <input
                      type="checkbox"
                      checked={selectedVenues.has(NO_VENUE)}
                      onChange={() => toggleVenue(NO_VENUE)}
                    />
                    <span className="venue-name muted">(No venue listed)</span>
                    {venueOptions.noVenueCount > 1 && (
                      <span className="venue-count">{venueOptions.noVenueCount}</span>
                    )}
                  </label>
                )}
                {visibleVenueOptions.length === 0 && venueSearch && (
                  <p className="empty muted small">No venues match &ldquo;{venueSearch}&rdquo;.</p>
                )}
                {visibleVenueOptions.map((v) => (
                  <label
                    key={v.key}
                    className={`venue-item ${v.isGroup ? "venue-item-group" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedVenues.has(v.key)}
                      onChange={() => toggleVenue(v.key)}
                    />
                    <span className="venue-name">{v.label}</span>
                    {v.count > 1 && <span className="venue-count">{v.count}</span>}
                  </label>
                ))}
              </div>
            </div>
          </details>
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
          <span className="col-filter-label">Time</span>
        </div>
        <div className="col-filter col-town">
          <input
            type="search"
            placeholder="Town…"
            aria-label="Filter by town"
            value={colTown}
            onChange={(e) => setColTown(e.target.value)}
          />
        </div>
        <div className="col-filter col-venue">
          <input
            type="search"
            placeholder="Venue…"
            aria-label="Filter by venue"
            value={colVenue}
            onChange={(e) => setColVenue(e.target.value)}
          />
        </div>
        <div className="col-filter col-type">
          <span className="col-filter-label">Type</span>
        </div>
        <div className="col-filter col-event">
          <input
            type="search"
            placeholder="Title / description…"
            aria-label="Filter by event title or description"
            value={colTitle}
            onChange={(e) => setColTitle(e.target.value)}
          />
        </div>
        {(colTown || colVenue || colTitle) && (
          <button
            type="button"
            className="link-btn col-filter-clear"
            onClick={() => {
              setColTown("");
              setColVenue("");
              setColTitle("");
            }}
          >
            clear column filters
          </button>
        )}
      </div>

      {byDay.size === 0 && (
        <p className="empty">
          No events match the current filters. Try clearing types, widening the distance, or
          extending the date range.
        </p>
      )}

      {[...byDay.entries()].map(([day, list]) => (
        <section key={day} className="day-group">
          <h2 className="day-heading">{formatDayHeading(day, region.timeZone, region.locale)}</h2>
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
