"use client";

// Hotel-booking-style date range picker. Single `<details>`-driven popover
// that opens one month calendar (two on wider screens). User clicks one day
// to start, another to end. We expose the chosen range as ISO date strings
// (YYYY-MM-DD) to match the rest of the filter state.

import { useEffect, useRef, useState } from "react";
import { DayPicker, type DateRange } from "react-day-picker";
import "react-day-picker/style.css";

type Props = {
  /** YYYY-MM-DD, or empty string for unset. */
  fromDate: string;
  toDate: string;
  onChange: (next: { fromDate: string; toDate: string }) => void;
  /** Optional ARIA label / button label fallback. */
  label?: string;
  /** Locale for formatting the trigger label. */
  locale?: string;
};

function parseYmd(s: string): Date | undefined {
  if (!s) return undefined;
  // Parse as local midnight so the calendar's `selected` matches what the
  // user picked. `new Date("2026-07-03")` is UTC midnight in some engines.
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d, 12, 0, 0);
}

function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatRangeLabel(from: string, to: string, locale: string): string {
  const f = parseYmd(from);
  const t = parseYmd(to);
  const fmt = (d: Date, opts: Intl.DateTimeFormatOptions) =>
    d.toLocaleDateString(locale, opts);
  if (f && t) {
    const sameYear = f.getFullYear() === t.getFullYear();
    return sameYear
      ? `${fmt(f, { month: "short", day: "numeric" })} – ${fmt(t, { month: "short", day: "numeric", year: "numeric" })}`
      : `${fmt(f, { month: "short", day: "numeric", year: "numeric" })} – ${fmt(t, { month: "short", day: "numeric", year: "numeric" })}`;
  }
  if (f) return `From ${fmt(f, { month: "short", day: "numeric", year: "numeric" })}`;
  if (t) return `Until ${fmt(t, { month: "short", day: "numeric", year: "numeric" })}`;
  return "Any date";
}

export function DateRangePicker({
  fromDate,
  toDate,
  onChange,
  label = "Date range",
  locale = "en-US",
}: Props) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [showTwoMonths, setShowTwoMonths] = useState(false);

  // Show two months side-by-side on wider screens. Re-check on resize so the
  // picker stays usable if the user rotates a tablet or resizes the window.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 640px)");
    const update = () => setShowTwoMonths(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Close on outside-click and Escape, matching the pattern used by every
  // other <details>-popover in the app (AdminDropdown, AddToCalendar, etc.).
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const el = detailsRef.current;
      if (!el || !el.open) return;
      if (e.target instanceof Node && !el.contains(e.target)) el.open = false;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && detailsRef.current?.open) {
        detailsRef.current.open = false;
      }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const selected: DateRange | undefined = (() => {
    const from = parseYmd(fromDate);
    const to = parseYmd(toDate);
    if (!from && !to) return undefined;
    return { from, to };
  })();

  function handleSelect(range: DateRange | undefined) {
    // react-day-picker's range mode handles all three click states for us:
    //   click 1 (no range)       → range = { from: <clicked>, to: undefined }
    //   click 2 (from set)       → range = { from: <earlier>, to: <later>   }
    //   click 3 (both set)       → range = { from: <clicked>, to: undefined } (reset)
    // We just forward the new range to parent state and leave the popover
    // open. The user closes it explicitly via outside-click, Escape, or Done.
    if (!range) {
      onChange({ fromDate: "", toDate: "" });
      return;
    }
    onChange({
      fromDate: range.from ? toYmd(range.from) : "",
      toDate: range.to ? toYmd(range.to) : "",
    });
  }

  function clearRange(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    onChange({ fromDate: "", toDate: "" });
    if (detailsRef.current) detailsRef.current.open = false;
  }

  return (
    <details className="daterange" ref={detailsRef}>
      <summary className="daterange-trigger" aria-label={label}>
        <span className="daterange-label">{formatRangeLabel(fromDate, toDate, locale)}</span>
        <span className="daterange-caret" aria-hidden>▾</span>
      </summary>
      <div className="daterange-popover" role="dialog" aria-label={label}>
        <DayPicker
          mode="range"
          selected={selected}
          onSelect={handleSelect}
          numberOfMonths={showTwoMonths ? 2 : 1}
          showOutsideDays
        />
        <div className="daterange-actions">
          <button type="button" className="link-btn" onClick={clearRange}>
            Clear
          </button>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => {
              if (detailsRef.current) detailsRef.current.open = false;
            }}
          >
            Done
          </button>
        </div>
      </div>
    </details>
  );
}
