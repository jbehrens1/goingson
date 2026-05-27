"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { EVENT_TYPES, TYPE_LABELS } from "@/lib/categorize";
import { haversineMiles } from "@/lib/towns";
import type { EventRecord } from "@/lib/types";
import { SortButtons } from "./_components/SortButtons";
import { MultiSelectPicker } from "./_components/MultiSelectPicker";
import { AddToCalendar } from "./_components/AddToCalendar";
import { DateRangePicker } from "./_components/DateRangePicker";
import { isIcsUrl } from "@/lib/calendar-links";

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

// Sentinel key in the venue picker for "events with no venue."
const NO_VENUE = "__no_venue__";

/** Whitespace-AND substring match against title + description + venue + town.
 *
 *  Splits the user's query on whitespace and requires every non-empty token
 *  to appear (case-insensitively) somewhere in the haystack. So "shorty long"
 *  matches "Shorty Long & The Jersey Horns" the same as "long shorty" does,
 *  and "pappy" matches events at "Pappy & Harriet's" even when the band name
 *  is the only thing in the title.
 *
 *  Empty query returns true (no filter applied). */
function matchesTitleQuery(
  query: string,
  ev: { title: string; description?: string; location?: { venue?: string; town?: string } },
): boolean {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = (
    `${ev.title} ${ev.description ?? ""} ${ev.location?.venue ?? ""} ${ev.location?.town ?? ""}`
  ).toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

function dayKey(iso: string, tz: string): string {
  // YYYY-MM-DD in the region's local timezone. Slicing the raw ISO string
  // would bucket events to the UTC date, so a 9 PM EDT show (stored as
  // 01:00 UTC the next day) ended up under tomorrow's heading. Use the
  // "en-CA" locale because it formats dates as YYYY-MM-DD, the exact key
  // shape we want. `tz` should be region.timeZone, e.g. "America/New_York".
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: tz });
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

  // Per-column quick filters. Type, Town, and Venue are multi-select sets;
  // Title is a free-text substring search. Selected sets are Set<string> to
  // match the generic MultiSelectPicker API; for the Type column the strings
  // are EventType literals.
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
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

  // Faceted counts: each dropdown's counts reflect what would still match if
  // you applied that facet on top of every OTHER active filter. So if you
  // pick town=Wellesley, the venue dropdown counts reflect Wellesley-only
  // events; if you pick type=Music, town counts reflect music-only events;
  // etc. Standard pattern used by every catalog/search UI.
  //
  // Items whose count drops to 0 are hidden unless currently selected (so
  // the user can still uncheck them).
  const facets = useMemo(() => {
    const fromTs = fromDate ? new Date(fromDate + "T00:00:00").getTime() : -Infinity;
    const toTs = toDate ? new Date(toDate + "T23:59:59").getTime() : Infinity;

    type Skip = "type" | "town" | "venue" | null;
    function passes(ev: (typeof payload.events)[number], skip: Skip): boolean {
      const ts = new Date(ev.start).getTime();
      if (ts < fromTs || ts > toTs) return false;
      if (skip !== "type" && selectedTypes.size > 0 && !selectedTypes.has(ev.type))
        return false;
      if (
        skip !== "town" &&
        colTowns.size > 0 &&
        !colTowns.has(ev.location?.town ?? "")
      )
        return false;
      if (skip !== "venue" && colVenues.size > 0) {
        const v = ev.location?.venue?.trim() ?? "";
        const matched = v ? colVenues.has(v) : colVenues.has(NO_VENUE);
        if (!matched) return false;
      }
      if (colTitle && !matchesTitleQuery(colTitle, ev)) return false;
      const hasCoords = ev.location?.lat != null && ev.location?.lon != null;
      if (filterNoLocation) return !hasCoords;
      if (filterDistance) {
        if (!hasCoords) return false;
        const d = haversineMiles(
          { lat: center.lat!, lon: center.lon! },
          { lat: ev.location!.lat!, lon: ev.location!.lon! },
        );
        if (d > distanceMi) return false;
      }
      return true;
    }

    const allTowns = new Set<string>();
    const townCounts = new Map<string, number>();
    const allVenues = new Set<string>();
    const venueCounts = new Map<string, number>();
    let hasAnyNoVenue = false;
    let noVenueCount = 0;
    const typeCounts = new Map<string, number>();

    for (const ev of payload.events) {
      const t = ev.location?.town?.trim();
      if (t) allTowns.add(t);
      const v = ev.location?.venue?.trim();
      if (v) allVenues.add(v);
      else hasAnyNoVenue = true;

      if (passes(ev, "town")) {
        if (t) townCounts.set(t, (townCounts.get(t) ?? 0) + 1);
      }
      if (passes(ev, "venue")) {
        if (v) venueCounts.set(v, (venueCounts.get(v) ?? 0) + 1);
        else noVenueCount++;
      }
      if (passes(ev, "type")) {
        typeCounts.set(ev.type, (typeCounts.get(ev.type) ?? 0) + 1);
      }
    }

    return {
      allTowns,
      townCounts,
      allVenues,
      venueCounts,
      hasAnyNoVenue,
      noVenueCount,
      typeCounts,
    };
  }, [
    payload.events,
    selectedTypes,
    colTowns,
    colVenues,
    colTitle,
    filterDistance,
    filterNoLocation,
    center.lat,
    center.lon,
    distanceMi,
    fromDate,
    toDate,
  ]);

  const columnTownOptions = useMemo(() => {
    const items: { name: string; count: number }[] = [];
    for (const name of facets.allTowns) {
      const count = facets.townCounts.get(name) ?? 0;
      // Show items with events OR currently-selected items (so they can be unchecked).
      if (count > 0 || colTowns.has(name)) items.push({ name, count });
    }
    return items.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
  }, [facets, colTowns]);

  const columnVenueOptions = useMemo(() => {
    const items: { key: string; label: string; count: number }[] = [];
    for (const name of facets.allVenues) {
      const count = facets.venueCounts.get(name) ?? 0;
      if (count > 0 || colVenues.has(name))
        items.push({ key: name, label: name, count });
    }
    items.sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
    );
    if (facets.hasAnyNoVenue && (facets.noVenueCount > 0 || colVenues.has(NO_VENUE))) {
      items.unshift({
        key: NO_VENUE,
        label: "(no venue)",
        count: facets.noVenueCount,
      });
    }
    return items;
  }, [facets, colVenues]);

  const columnTypeOptions = useMemo(() => {
    // EVENT_TYPES is in priority/specificity order (mahjong > comedy >
    // live-music ...) — that order matters for categorize() but is wrong
    // for the user-facing picker. Sort by display label so the dropdown
    // matches Town and Venue (which are alphabetized).
    return EVENT_TYPES.filter((t) => {
      const count = facets.typeCounts.get(t) ?? 0;
      return count > 0 || selectedTypes.has(t);
    })
      .map((t) => ({
        key: t,
        label: TYPE_LABELS[t],
        count: facets.typeCounts.get(t) ?? 0,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [facets, selectedTypes]);

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
        // Per-column quick filters. Type, Town, and Venue are multi-select;
        // an empty set means no filter. The venue set may include the
        // NO_VENUE sentinel to match events with no venue.
        if (colTowns.size > 0 && !colTowns.has(ev.location?.town ?? "")) return false;
        if (colVenues.size > 0) {
          const v = ev.location?.venue?.trim() ?? "";
          const matched = v ? colVenues.has(v) : colVenues.has(NO_VENUE);
          if (!matched) return false;
        }
        if (colTitle && !matchesTitleQuery(colTitle, ev)) return false;
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
      const k = dayKey(item.ev.start, region.timeZone);
      const list = map.get(k) ?? [];
      list.push(item);
      map.set(k, list);
    }
    return map;
  }, [filtered, sortedFlat, region.timeZone]);

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
        // Remember the chosen region so reloads come back to it.
        try {
          localStorage.setItem("goingson:regionId", nextRegionId);
        } catch {
          // localStorage can be disabled in private browsing — ignore
        }
        // Reset filters that don't make sense across regions.
        setCenter({ mode: ANY, label: "" });
        setCenterQuery("");
        setSelectedTypes(new Set());
        setColTowns(new Set());
        setColVenues(new Set());
        setColTitle("");
      } catch (err) {
        setRegionError((err as Error).message);
      }
    });
  }

  // On first mount: if the user picked a different region in a prior session,
  // switch to it. The initial server-rendered payload uses the default region
  // (so SSR is consistent across users); we then swap to the remembered one.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("goingson:regionId");
      if (saved && saved !== region.id && manifest?.regions.some((r) => r.id === saved)) {
        handleRegionChange(saved);
      }
    } catch {
      // localStorage unavailable — no-op
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the browser tab title in sync with the active region.
  useEffect(() => {
    document.title = `Goings On — ${region.displayName}`;
  }, [region.displayName]);

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

  // Mobile: filter disclosure defaults closed. Desktop: defaults open.
  // Why useState+useEffect instead of pure CSS: the native <details> element
  // takes non-summary children OUT of normal flow when [open] is false, so
  // CSS `display: flex !important` makes them render visually but they don't
  // push subsequent siblings down — the col-filter-row ends up overlapping
  // the filters card. Forcing `open` on desktop solves this cleanly.
  // SSR default `true` keeps desktop flicker-free; mobile gets a brief
  // (~50ms hydration window) expand→collapse that's barely perceptible.
  // Uses matchMedia (not window.innerWidth) so it matches the same CSS
  // breakpoint exactly, including under devtools viewport emulation where
  // innerWidth reports the outer-window width.
  const [filtersOpen, setFiltersOpen] = useState(true);
  useEffect(() => {
    if (typeof window !== "undefined" &&
        window.matchMedia("(max-width: 720px)").matches) {
      setFiltersOpen(false);
    }
  }, []);

  // One-line summary for the collapsible filter chip on mobile. Pulls together
  // every active filter (types, towns, venues, title text, center+distance,
  // date range) so the user can see what's set without expanding. On desktop
  // the chip is hidden by CSS — the full filter card is always visible there.
  // Order: most-specific facets first (types/towns/venues/title), then
  // location, then dates. Long values are truncated by CSS ellipsis.
  const filterSummary = (() => {
    const parts: string[] = [];
    const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`;
    if (selectedTypes.size > 0) parts.push(plural(selectedTypes.size, "type"));
    if (colTowns.size > 0) parts.push(plural(colTowns.size, "town"));
    if (colVenues.size > 0) parts.push(plural(colVenues.size, "venue"));
    if (colTitle) parts.push(`"${colTitle}"`);
    if (center.mode === "resolved") {
      parts.push(`${center.label} · ${distanceMi}mi`);
    } else if (center.mode === NO_LOCATION) {
      parts.push("No location");
    }
    const fmt = (iso: string) =>
      new Date(iso + "T12:00:00").toLocaleDateString(region.locale, {
        month: "short",
        day: "numeric",
        timeZone: region.timeZone,
      });
    if (fromDate && toDate) parts.push(`${fmt(fromDate)}–${fmt(toDate)}`);
    else if (fromDate) parts.push(`from ${fmt(fromDate)}`);
    else if (toDate) parts.push(`until ${fmt(toDate)}`);
    return parts.length === 0 ? "All events" : parts.join(" · ");
  })();

  const hasActiveFilters =
    selectedTypes.size > 0 ||
    colTowns.size > 0 ||
    colVenues.size > 0 ||
    !!colTitle ||
    !!sortBy;

  return (
    <main>
      <header>
        <div className="header-row">
          <h1>Goings On <span className="muted">— {region.displayName}</span></h1>
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

      {/* Mobile: collapsible disclosure (default closed) so the dense filter
       * card doesn't push the events below the fold. Desktop: CSS hides the
       * <summary> and force-shows the body, so the layout is unchanged. */}
      <details
        className="filters-collapsible"
        open={filtersOpen}
        onToggle={(e) => setFiltersOpen(e.currentTarget.open)}
      >
        <summary className="filters-summary">
          <span className="filters-summary-label">Filters</span>
          <span className="filters-summary-text">{filterSummary}</span>
          <span className="filters-summary-caret" aria-hidden>▾</span>
        </summary>

      {/* Mobile-only quick-filter pickers. Mirror the column-header row
       * (which is hidden on mobile) so users can adjust Types/Towns/Venues
       * /Title without scrolling past the filter card. Order: Types first
       * because event-type is the most common filter. State is shared
       * with the column-header pickers — both render the same selection. */}
      <div className="filters-pickers">
        <label className="filters-picker-row">
          <span>Types</span>
          <MultiSelectPicker
            label="types"
            singularLabel="type"
            selected={selectedTypes}
            onChange={setSelectedTypes}
            options={columnTypeOptions}
          />
        </label>
        <label className="filters-picker-row">
          <span>Towns</span>
          <MultiSelectPicker
            label="towns"
            singularLabel="town"
            selected={colTowns}
            onChange={setColTowns}
            options={columnTownOptions.map((t) => ({ key: t.name, label: t.name, count: t.count }))}
          />
        </label>
        <label className="filters-picker-row">
          <span>Venues</span>
          <MultiSelectPicker
            label="venues"
            singularLabel="venue"
            selected={colVenues}
            onChange={setColVenues}
            options={columnVenueOptions}
          />
        </label>
        <label className="filters-picker-row">
          <span>Title</span>
          <input
            type="search"
            placeholder="Title, description, venue, town…"
            aria-label="Filter by event title or description"
            value={colTitle}
            onChange={(e) => setColTitle(e.target.value)}
          />
        </label>
        {hasActiveFilters && (
          <button
            type="button"
            className="link-btn filters-picker-clear"
            onClick={() => {
              setSelectedTypes(new Set());
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

      {/* Inner disclosure: Center-on/dates/Refresh defaults COLLAPSED so the
       * filter card doesn't show every input by default. Most users browsing
       * a region don't need to change the date range or set a location —
       * those are advanced filters. Click "Location & dates" to expand. */}
      <details className="filters-loc">
        <summary className="filters-loc-summary">
          <span className="filters-loc-label">Location &amp; dates</span>
          <span className="filters-loc-caret" aria-hidden>▾</span>
        </summary>
      <section className="filters">
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
            <span>Dates</span>
            <DateRangePicker
              fromDate={fromDate}
              toDate={toDate}
              onChange={({ fromDate: f, toDate: t }) => {
                setFromDate(f);
                setToDate(t);
              }}
              locale={region.locale}
            />
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
      </details>
      </details>

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
          <MultiSelectPicker
            label="types"
            singularLabel="type"
            selected={selectedTypes}
            onChange={setSelectedTypes}
            options={columnTypeOptions}
          />
        </div>
        <div className="col-filter col-event">
          <SortButtons col="title" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
          <input
            type="search"
            placeholder="Title, description, venue, town…"
            aria-label="Filter by event title or description"
            value={colTitle}
            onChange={(e) => setColTitle(e.target.value)}
          />
        </div>
        {(selectedTypes.size > 0 ||
          colTowns.size > 0 ||
          colVenues.size > 0 ||
          colTitle ||
          sortBy) && (
          <button
            type="button"
            className="link-btn col-filter-clear"
            onClick={() => {
              setSelectedTypes(new Set());
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
                    <span className="event-title-row">
                      {isIcsUrl(ev.url) ? (
                        // Title link would just download an .ics file — not
                        // useful as a description. Route the title click to
                        // the add-to-calendar widget. Always render the
                        // standalone calendar icon too so every event has a
                        // consistent action affordance.
                        <>
                          <AddToCalendar event={ev} triggerLabel={ev.title} />
                          <AddToCalendar event={ev} />
                        </>
                      ) : (
                        <>
                          <a
                            href={ev.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="event-title"
                          >
                            {ev.title}
                          </a>
                          <AddToCalendar event={ev} />
                        </>
                      )}
                    </span>
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
          // Each day is a <details> so clicking the date heading collapses
          // that day's events. Defaults open. The chevron indicator and
          // count badge are added via CSS (.day-heading::before / ::after).
          <details key={day} className="day-group" open>
            <summary className="day-heading">
              {formatDayHeading(day, region.timeZone, region.locale)}
              <span className="day-heading-count">
                {list.length} {list.length === 1 ? "event" : "events"}
              </span>
            </summary>
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
                      <span className="event-title-row">
                        {isIcsUrl(ev.url) ? (
                          <>
                            <AddToCalendar event={ev} triggerLabel={ev.title} />
                            <AddToCalendar event={ev} />
                          </>
                        ) : (
                          <>
                            <a
                              href={ev.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="event-title"
                            >
                              {ev.title}
                            </a>
                            <AddToCalendar event={ev} />
                          </>
                        )}
                      </span>
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
          </details>
        ))}

      <footer>
        Region: <code>{region.id}</code> · See <code>config/regions/{region.id}/sources.json</code>{" "}
        for configured sources.
      </footer>
    </main>
  );
}

type SortableColumn = "time" | "town" | "venue" | "type" | "title";
