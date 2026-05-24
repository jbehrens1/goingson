"use client";

import { useMemo, useState, useTransition } from "react";
import { TYPE_LABELS, type EventType } from "@/lib/categorize";
import type { NewsletterPrefs, Schedule, SurpriseLevel } from "@/lib/newsletter/types";
import { MultiSelectPicker } from "../_components/MultiSelectPicker";

type Props = {
  initialPrefs: NewsletterPrefs;
  regions: string[];
  venuesByRegion: Record<string, string[]>;
  eventTypes: EventType[];
};

export function AccountPrefs({
  initialPrefs,
  regions,
  venuesByRegion,
  eventTypes,
}: Props) {
  const [prefs, setPrefs] = useState<NewsletterPrefs>(initialPrefs);
  const [centerQuery, setCenterQuery] = useState(initialPrefs.center?.label ?? "");
  const [centerLookupError, setCenterLookupError] = useState<string | null>(null);
  const [isLookingUp, startLookup] = useTransition();
  const [isSaving, startSave] = useTransition();
  const [isTesting, startTest] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const venues = venuesByRegion[prefs.region] ?? [];
  const typeOptions = useMemo(
    () =>
      eventTypes.map((t) => ({
        key: t,
        label: TYPE_LABELS[t],
        count: 0,
      })),
    [eventTypes],
  );
  const venueOptions = useMemo(
    () => venues.map((v) => ({ key: v, label: v, count: 0 })),
    [venues],
  );

  function patch(p: Partial<NewsletterPrefs>) {
    setPrefs((prev) => ({ ...prev, ...p }));
    setOkMsg(null);
  }

  async function lookupCenter() {
    setCenterLookupError(null);
    const q = centerQuery.trim();
    if (!q) {
      patch({ center: undefined, radiusMi: undefined });
      return;
    }
    startLookup(async () => {
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
        if (res.status === 404) {
          setCenterLookupError(`No location found for "${q}"`);
          return;
        }
        if (!res.ok) {
          setCenterLookupError(`Lookup failed (HTTP ${res.status})`);
          return;
        }
        const json = (await res.json()) as {
          ok: boolean;
          lat: number;
          lon: number;
          displayName?: string;
        };
        if (!json.ok) {
          setCenterLookupError("Lookup failed");
          return;
        }
        patch({
          center: { lat: json.lat, lon: json.lon, label: json.displayName ?? q },
          radiusMi: prefs.radiusMi ?? 15,
        });
      } catch (err) {
        setCenterLookupError((err as Error).message);
      }
    });
  }

  function save() {
    setError(null);
    setOkMsg(null);
    startSave(async () => {
      try {
        const res = await fetch("/api/account/preferences", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(prefs),
        });
        const json = (await res.json()) as { ok: boolean; error?: string };
        if (!json.ok) {
          setError(json.error ?? "Save failed");
          return;
        }
        setOkMsg("Preferences saved.");
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  function sendTest() {
    setError(null);
    setOkMsg(null);
    startTest(async () => {
      try {
        // Save current prefs first so the test reflects unsaved changes.
        await fetch("/api/account/preferences", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(prefs),
        });
        const res = await fetch("/api/newsletter/test", { method: "POST" });
        const json = (await res.json()) as {
          ok: boolean;
          error?: string;
          skipped?: string;
          emailId?: string;
          matched?: number;
          surprises?: number;
        };
        if (!json.ok) {
          setError(json.error ?? "Send failed");
          return;
        }
        if (json.skipped) {
          setOkMsg(`Preview not sent: ${json.skipped}`);
          return;
        }
        setOkMsg(
          `Preview sent (${json.matched ?? 0} matched + ${json.surprises ?? 0} surprises) · check your inbox.`,
        );
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <div className="account-prefs">
      <div className="account-row">
        <label className="account-toggle">
          <input
            type="checkbox"
            checked={prefs.subscribed}
            onChange={(e) => patch({ subscribed: e.target.checked })}
          />
          <span>Subscribe to the Goings On newsletter</span>
        </label>
      </div>

      <fieldset disabled={!prefs.subscribed} className="account-fieldset">
        <div className="account-row">
          <label>
            <span>Region</span>
            <select
              value={prefs.region}
              onChange={(e) => patch({ region: e.target.value, venues: [] })}
            >
              {regions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Frequency</span>
            <select
              value={prefs.schedule}
              onChange={(e) => patch({ schedule: e.target.value as Schedule })}
            >
              <option value="daily">Daily (every morning)</option>
              <option value="weekly">Weekly (Friday morning)</option>
            </select>
          </label>

          <label>
            <span>Surprise events</span>
            <select
              value={prefs.surprise}
              onChange={(e) => patch({ surprise: e.target.value as SurpriseLevel })}
              title="How often the digest includes events outside your filters"
            >
              <option value="never">Never</option>
              <option value="sometimes">Sometimes (2 per digest)</option>
              <option value="often">Often (5 per digest)</option>
            </select>
          </label>
        </div>

        <div className="account-row">
          <div className="account-picker">
            <label className="account-label">Event types</label>
            <MultiSelectPicker
              label="types"
              singularLabel="type"
              selected={new Set(prefs.types)}
              onChange={(next) => patch({ types: [...next] as EventType[] })}
              options={typeOptions}
            />
            <span className="muted small">Empty = include all types</span>
          </div>

          <div className="account-picker">
            <label className="account-label">Venues</label>
            <MultiSelectPicker
              label="venues"
              singularLabel="venue"
              selected={new Set(prefs.venues)}
              onChange={(next) => patch({ venues: [...next] })}
              options={venueOptions}
            />
            <span className="muted small">Empty = include all venues</span>
          </div>
        </div>

        <div className="account-row">
          <label className="grow">
            <span>Center on (optional)</span>
            <div className="center-input-wrap">
              <input
                type="text"
                placeholder='Address, city, or ZIP (e.g. "Wellesley, MA")'
                value={centerQuery}
                onChange={(e) => setCenterQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    lookupCenter();
                  }
                }}
              />
              <button
                type="button"
                className="ghost-btn"
                onClick={lookupCenter}
                disabled={isLookingUp || !centerQuery.trim()}
              >
                {isLookingUp ? "Locating…" : "Set"}
              </button>
              {prefs.center && (
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => {
                    setCenterQuery("");
                    patch({ center: undefined, radiusMi: undefined });
                  }}
                >
                  Clear
                </button>
              )}
            </div>
            {prefs.center && (
              <span className="hint">Centered on: {prefs.center.label}</span>
            )}
            {centerLookupError && (
              <span className="hint hint-error">{centerLookupError}</span>
            )}
          </label>

          <label className={prefs.center ? "" : "disabled"}>
            <span>Within (miles)</span>
            <input
              type="number"
              min={1}
              max={250}
              step={1}
              value={prefs.radiusMi ?? 15}
              disabled={!prefs.center}
              onChange={(e) =>
                patch({ radiusMi: Math.max(1, Number(e.target.value) || 0) })
              }
            />
          </label>
        </div>
      </fieldset>

      <div className="account-actions">
        <button
          type="button"
          className="primary-btn"
          onClick={save}
          disabled={isSaving}
        >
          {isSaving ? "Saving…" : "Save preferences"}
        </button>
        <button
          type="button"
          className="ghost-btn"
          onClick={sendTest}
          disabled={isTesting}
          title="Generate the digest and email it to you immediately"
        >
          {isTesting ? "Sending…" : "Send me a preview"}
        </button>
        {error && <span className="hint hint-error">{error}</span>}
        {okMsg && <span className="hint hint-ok">{okMsg}</span>}
      </div>
    </div>
  );
}
