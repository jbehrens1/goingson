"use client";

// Tiny calendar-icon button that opens a dropdown of add-to-calendar
// destinations (Google / Outlook / Apple-via-ICS / Yahoo). Uses the same
// <details>+outside-click pattern as AdminDropdown so it has no JS state
// to coordinate. Pure UI — the URL building lives in lib/calendar-links.

import { useEffect, useRef } from "react";
import type { EventRecord } from "@/lib/types";
import {
  googleCalendarUrl,
  outlookLiveUrl,
  office365Url,
  yahooCalendarUrl,
  icsDataUrl,
  icsFileName,
} from "@/lib/calendar-links";

type Props = {
  event: EventRecord;
  /** When the trigger is the title itself (because the event's URL is a
   *  raw .ics file and not a useful description page), render with no
   *  visible button — the parent's title click opens us. */
  triggerLabel?: string;
};

export function AddToCalendar({ event, triggerLabel }: Props) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const el = ref.current;
      if (!el || !el.open) return;
      if (e.target instanceof Node && !el.contains(e.target)) el.open = false;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && ref.current?.open) ref.current.open = false;
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  function closeMenu() {
    if (ref.current) ref.current.open = false;
  }

  return (
    <details className="atc" ref={ref}>
      <summary
        className="atc-trigger"
        aria-label={`Add "${event.title}" to your calendar`}
        title="Add to calendar"
      >
        {triggerLabel ? (
          <span className="atc-trigger-label">{triggerLabel}</span>
        ) : (
          <CalendarIcon />
        )}
      </summary>
      <div className="atc-menu" role="menu">
        <a
          href={googleCalendarUrl(event)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={closeMenu}
          role="menuitem"
        >
          Google Calendar
        </a>
        <a
          href={icsDataUrl(event)}
          download={icsFileName(event)}
          onClick={closeMenu}
          role="menuitem"
        >
          Apple Calendar <span className="atc-muted">(.ics)</span>
        </a>
        <a
          href={outlookLiveUrl(event)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={closeMenu}
          role="menuitem"
        >
          Outlook.com
        </a>
        <a
          href={office365Url(event)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={closeMenu}
          role="menuitem"
        >
          Office 365
        </a>
        <a
          href={yahooCalendarUrl(event)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={closeMenu}
          role="menuitem"
        >
          Yahoo Calendar
        </a>
      </div>
    </details>
  );
}

// Inline SVG calendar icon. Inherits currentColor so the icon takes its
// color from the surrounding link/button style. 14×14 keeps it visually
// in line with body text without dominating.
function CalendarIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="16" y1="2" x2="16" y2="6" />
    </svg>
  );
}
