"use client";

// Client-side wrapper around the header's Admin dropdown so we can close it
// on outside-click and on Escape. Same pattern as MultiSelectPicker; lifted
// into its own component so the SiteHeader stays a server component (it
// needs filesystem access for the pending-count + role lookups).

import Link from "next/link";
import { useEffect, useRef } from "react";

type Props = {
  isOwner: boolean;
  pendingCount: number;
};

export function AdminDropdown({ isOwner, pendingCount }: Props) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const el = ref.current;
      if (!el || !el.open) return;
      if (e.target instanceof Node && !el.contains(e.target)) {
        el.open = false;
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && ref.current?.open) {
        ref.current.open = false;
      }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // Close the menu when a link is clicked. <details> doesn't toggle on
  // child click by default, so we close it explicitly after navigation
  // intent is recorded.
  function closeMenu() {
    if (ref.current) ref.current.open = false;
  }

  return (
    <details className="header-dropdown" ref={ref}>
      <summary>
        Admin
        {pendingCount > 0 && (
          <span
            className="header-badge"
            title={`${pendingCount} pending suggestion${pendingCount === 1 ? "" : "s"}`}
          >
            {pendingCount}
          </span>
        )}
        <span className="header-dropdown-caret" aria-hidden>
          ▾
        </span>
      </summary>
      <div className="header-dropdown-menu" role="menu">
        <Link href="/sources" role="menuitem" onClick={closeMenu}>
          Sources
        </Link>
        <Link href="/admin/qc" role="menuitem" onClick={closeMenu}>
          QC
        </Link>
        <Link href="/sources/pending" role="menuitem" onClick={closeMenu}>
          Pending
          {pendingCount > 0 && (
            <span className="header-badge">{pendingCount}</span>
          )}
        </Link>
        <Link href="/admin/discover" role="menuitem" onClick={closeMenu}>
          Discover
        </Link>
        {isOwner && (
          <Link href="/admin" role="menuitem" onClick={closeMenu}>
            Users
          </Link>
        )}
      </div>
    </details>
  );
}
