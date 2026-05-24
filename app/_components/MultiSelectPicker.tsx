"use client";

import { useEffect, useRef, useState } from "react";

export type MultiSelectOption = {
  key: string;
  label: string;
  count: number;
  isGroup?: boolean;
};

export function MultiSelectPicker({
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
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const visible = query
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options;

  function toggle(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  }

  // Close when clicking outside or on Escape — standard popover convention.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const el = detailsRef.current;
      if (!el || !el.open) return;
      if (e.target instanceof Node && !el.contains(e.target)) {
        el.open = false;
      }
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

  const summary =
    selected.size === 0
      ? `All ${label} (${options.length})`
      : selected.size === 1
        ? (() => {
            const k = [...selected][0];
            const found = options.find((o) => o.key === k);
            return found ? found.label : `1 ${singularLabel}`;
          })()
        : `${selected.size} ${label}`;

  return (
    <details className="col-multi" ref={detailsRef}>
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
            <p className="empty muted small">
              No {label} match &ldquo;{query}&rdquo;.
            </p>
          )}
          {visible.map((o) => (
            <label
              key={o.key}
              className={`col-multi-item${o.isGroup ? " col-multi-item-group" : ""}${o.count === 0 ? " col-multi-item-empty" : ""}`}
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
