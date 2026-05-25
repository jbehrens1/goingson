"use client";

import { useMemo, useState, useTransition } from "react";
import { TYPE_LABELS, type EventType } from "@/lib/categorize";
import {
  DEFAULT_SUBSCRIPTION,
  LOOKAHEAD_MAX,
  LOOKAHEAD_MIN,
  MAX_SUBSCRIPTIONS_PER_USER,
  type NewsletterState,
  type NewsletterSubscription,
  type Schedule,
  type SurpriseLevel,
} from "@/lib/newsletter/types";
import { MultiSelectPicker } from "../_components/MultiSelectPicker";

type Props = {
  initialState: NewsletterState;
  regions: string[];
  venuesByRegion: Record<string, string[]>;
  eventTypes: EventType[];
};

export function AccountSubscriptions({
  initialState,
  regions,
  venuesByRegion,
  eventTypes,
}: Props) {
  const [state, setState] = useState<NewsletterState>(initialState);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [globalOk, setGlobalOk] = useState<string | null>(null);
  const [isAdding, startAdd] = useTransition();
  /** Subscription IDs that should render in expanded (edit) mode. Cards are
   *  collapsed by default; clicking the summary line toggles expansion.
   *  Newly-added subs are auto-added here so the editor opens immediately. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function addNew() {
    setGlobalError(null);
    setGlobalOk(null);
    if (state.subscriptions.length >= MAX_SUBSCRIPTIONS_PER_USER) {
      setGlobalError(
        `Maximum ${MAX_SUBSCRIPTIONS_PER_USER} subscriptions per account.`,
      );
      return;
    }
    const region = regions[0] ?? "metrowest";
    const newSub = {
      ...DEFAULT_SUBSCRIPTION,
      region,
      name: `${region} ${DEFAULT_SUBSCRIPTION.schedule} digest`,
    };
    startAdd(async () => {
      try {
        const res = await fetch("/api/account/preferences", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(newSub),
        });
        const json = (await res.json()) as {
          ok: boolean;
          error?: string;
          state?: NewsletterState;
          created?: NewsletterSubscription;
        };
        if (!json.ok || !json.state) {
          setGlobalError(json.error ?? "Add failed");
          return;
        }
        setState(json.state);
        // Auto-open the new card so the user can configure it right away.
        if (json.created) {
          setExpanded((prev) => new Set([...prev, json.created!.id]));
        }
        setGlobalOk("Subscription added.");
      } catch (err) {
        setGlobalError((err as Error).message);
      }
    });
  }

  function onSubChanged(next: NewsletterState) {
    setState(next);
  }

  return (
    <div className="account-subs">
      <div className="account-subs-toolbar">
        <button
          type="button"
          className="primary-btn"
          onClick={addNew}
          disabled={isAdding || state.subscriptions.length >= MAX_SUBSCRIPTIONS_PER_USER}
        >
          {isAdding ? "Adding…" : "+ Add subscription"}
        </button>
        <span className="muted small">
          {state.subscriptions.length} / {MAX_SUBSCRIPTIONS_PER_USER} subscriptions
        </span>
        {globalError && <span className="hint hint-error">{globalError}</span>}
        {globalOk && <span className="hint hint-ok">{globalOk}</span>}
      </div>

      {state.subscriptions.length === 0 && (
        <p className="muted" style={{ marginTop: "1rem" }}>
          You haven&rsquo;t subscribed to any newsletters yet. Click <strong>+ Add
          subscription</strong> to create your first one.
        </p>
      )}

      <div className="account-subs-list">
        {state.subscriptions.map((sub) => (
          <SubscriptionCard
            key={sub.id}
            sub={sub}
            regions={regions}
            venuesByRegion={venuesByRegion}
            eventTypes={eventTypes}
            onChanged={onSubChanged}
            expanded={expanded.has(sub.id)}
            onToggle={() => toggleExpanded(sub.id)}
          />
        ))}
      </div>
    </div>
  );
}

/** Compact one-line summary used in the collapsed card header. */
function summarize(
  s: NewsletterSubscription,
  eventTypes: EventType[],
): string {
  const parts: string[] = [];
  parts.push(s.region);
  parts.push(s.schedule === "daily" ? "daily" : "weekly");
  parts.push(`${s.lookaheadDays}d window`);
  parts.push(s.types.length === 0 ? "all types" : `${s.types.length} type${s.types.length === 1 ? "" : "s"}`);
  parts.push(s.venues.length === 0 ? "all venues" : `${s.venues.length} venue${s.venues.length === 1 ? "" : "s"}`);
  if (s.center && s.radiusMi) {
    parts.push(`${s.radiusMi}mi of ${s.center.label.split(",")[0]}`);
  }
  if (s.surprise !== "never") parts.push(`surprise: ${s.surprise}`);
  // Silence unused-prop lint without removing the parameter.
  void eventTypes;
  return parts.join(" · ");
}

function SubscriptionCard({
  sub,
  regions,
  venuesByRegion,
  eventTypes,
  onChanged,
  expanded,
  onToggle,
}: {
  sub: NewsletterSubscription;
  regions: string[];
  venuesByRegion: Record<string, string[]>;
  eventTypes: EventType[];
  onChanged: (s: NewsletterState) => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [draft, setDraft] = useState<NewsletterSubscription>(sub);
  const [centerQuery, setCenterQuery] = useState(sub.center?.label ?? "");
  const [centerErr, setCenterErr] = useState<string | null>(null);
  const [isLookingUp, startLookup] = useTransition();
  const [isSaving, startSave] = useTransition();
  const [isDeleting, startDelete] = useTransition();
  const [isTesting, startTest] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(sub),
    [draft, sub],
  );

  const venues = venuesByRegion[draft.region] ?? [];
  const typeOptions = useMemo(
    () => eventTypes.map((t) => ({ key: t, label: TYPE_LABELS[t], count: 0 })),
    [eventTypes],
  );
  const venueOptions = useMemo(
    () => venues.map((v) => ({ key: v, label: v, count: 0 })),
    [venues],
  );

  function patch(p: Partial<NewsletterSubscription>) {
    setDraft((d) => ({ ...d, ...p }));
    setOkMsg(null);
  }

  async function lookupCenter() {
    setCenterErr(null);
    const q = centerQuery.trim();
    if (!q) {
      patch({ center: undefined, radiusMi: undefined });
      return;
    }
    startLookup(async () => {
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
        if (res.status === 404) {
          setCenterErr(`No location found for "${q}"`);
          return;
        }
        if (!res.ok) {
          setCenterErr(`Lookup failed (HTTP ${res.status})`);
          return;
        }
        const json = (await res.json()) as {
          ok: boolean;
          lat: number;
          lon: number;
          displayName?: string;
        };
        if (!json.ok) {
          setCenterErr("Lookup failed");
          return;
        }
        patch({
          center: { lat: json.lat, lon: json.lon, label: json.displayName ?? q },
          radiusMi: draft.radiusMi ?? 15,
        });
      } catch (err) {
        setCenterErr((err as Error).message);
      }
    });
  }

  function save() {
    setError(null);
    setOkMsg(null);
    startSave(async () => {
      try {
        const res = await fetch("/api/account/preferences", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: sub.id, patch: draft }),
        });
        const json = (await res.json()) as {
          ok: boolean;
          error?: string;
          state?: NewsletterState;
        };
        if (!json.ok || !json.state) {
          setError(json.error ?? "Save failed");
          return;
        }
        onChanged(json.state);
        const updated = json.state.subscriptions.find((s) => s.id === sub.id);
        if (updated) setDraft(updated);
        setOkMsg("Saved.");
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  function remove() {
    if (!confirm(`Unsubscribe and delete "${sub.name}"?`)) return;
    setError(null);
    setOkMsg(null);
    startDelete(async () => {
      try {
        const res = await fetch("/api/account/preferences", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: sub.id }),
        });
        const json = (await res.json()) as {
          ok: boolean;
          error?: string;
          state?: NewsletterState;
        };
        if (!json.ok || !json.state) {
          setError(json.error ?? "Delete failed");
          return;
        }
        onChanged(json.state);
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
        // Save draft first so the preview reflects unsaved tweaks.
        if (dirty) {
          await fetch("/api/account/preferences", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: sub.id, patch: draft }),
          });
        }
        const res = await fetch("/api/newsletter/test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subscriptionId: sub.id }),
        });
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

  // Collapsed: a single-line summary with the chevron + name + details.
  // Click anywhere on the header (except the chevron control) opens the editor.
  if (!expanded) {
    return (
      <article className="sub-card sub-card-collapsed">
        <button
          type="button"
          className="sub-summary-btn"
          onClick={onToggle}
          aria-expanded="false"
        >
          <span className="sub-summary-chevron">▸</span>
          <span className="sub-summary-name">{sub.name}</span>
          <span className="sub-summary-details muted small">
            {summarize(sub, eventTypes)}
          </span>
        </button>
      </article>
    );
  }

  return (
    <article className="sub-card sub-card-expanded">
      <header className="sub-card-head">
        <button
          type="button"
          className="sub-summary-chevron-btn"
          onClick={onToggle}
          title="Collapse"
          aria-expanded="true"
        >
          ▾
        </button>
        <input
          className="sub-name-input"
          value={draft.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder="Subscription name"
        />
        <div className="sub-card-actions">
          <button
            type="button"
            className="primary-btn"
            onClick={save}
            disabled={isSaving || !dirty}
            title={!dirty ? "No changes to save" : "Save changes"}
          >
            {isSaving ? "Saving…" : dirty ? "Save" : "Saved"}
          </button>
          <button
            type="button"
            className="ghost-btn"
            onClick={sendTest}
            disabled={isTesting}
            title="Generate and email this subscription's digest right now"
          >
            {isTesting ? "Sending…" : "Send preview"}
          </button>
          <button
            type="button"
            className="ghost-btn sub-delete-btn"
            onClick={remove}
            disabled={isDeleting}
            title="Unsubscribe and delete"
          >
            {isDeleting ? "…" : "Delete"}
          </button>
        </div>
      </header>

      <div className="account-row">
        <label>
          <span>Region</span>
          <select
            value={draft.region}
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
            value={draft.schedule}
            onChange={(e) => patch({ schedule: e.target.value as Schedule })}
          >
            <option value="daily">Daily (each morning)</option>
            <option value="weekly">Weekly (Fri morning)</option>
          </select>
        </label>

        <label>
          <span>Look ahead (days)</span>
          <input
            type="number"
            min={LOOKAHEAD_MIN}
            max={LOOKAHEAD_MAX}
            step={1}
            value={draft.lookaheadDays}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (!Number.isFinite(n)) return;
              patch({
                lookaheadDays: Math.max(LOOKAHEAD_MIN, Math.min(LOOKAHEAD_MAX, n)),
              });
            }}
          />
        </label>

        <label>
          <span>Surprise events</span>
          <select
            value={draft.surprise}
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
            selected={new Set(draft.types)}
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
            selected={new Set(draft.venues)}
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
            {draft.center && (
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
          {draft.center && <span className="hint">Centered on: {draft.center.label}</span>}
          {centerErr && <span className="hint hint-error">{centerErr}</span>}
        </label>

        <label className={draft.center ? "" : "disabled"}>
          <span>Within (miles)</span>
          <input
            type="number"
            min={1}
            max={250}
            step={1}
            value={draft.radiusMi ?? 15}
            disabled={!draft.center}
            onChange={(e) =>
              patch({ radiusMi: Math.max(1, Number(e.target.value) || 0) })
            }
          />
        </label>
      </div>

      <div className="sub-card-footer">
        {error && <span className="hint hint-error">{error}</span>}
        {okMsg && <span className="hint hint-ok">{okMsg}</span>}
      </div>
    </article>
  );
}
