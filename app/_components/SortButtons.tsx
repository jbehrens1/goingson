"use client";

export type SortDir = "asc" | "desc";

export function SortButtons<TCol extends string>({
  col,
  sortBy,
  sortDir,
  onToggle,
}: {
  col: TCol;
  sortBy: TCol | null;
  sortDir: SortDir;
  onToggle: (col: TCol, dir: SortDir) => void;
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
