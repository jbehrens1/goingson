"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import type { Role } from "@/lib/auth";
import { TYPE_LABELS, type EventType } from "@/lib/categorize";
import type { NewsletterSubscription } from "@/lib/newsletter/types";
import { MultiSelectPicker } from "../_components/MultiSelectPicker";

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: number;
  subscriptions: NewsletterSubscription[];
};

const ROLES: Role[] = ["regular", "admin", "owner"];

export function AdminUsersTable({
  initialUsers,
  regions,
  venuesByRegion,
  townsByRegion,
  eventTypes,
}: {
  initialUsers: UserRow[];
  regions: string[];
  venuesByRegion: Record<string, string[]>;
  townsByRegion: Record<string, string[]>;
  eventTypes: EventType[];
}) {
  const [users, setUsers] = useState(initialUsers);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [_, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function changeRole(user: UserRow, nextRole: Role) {
    if (nextRole === user.role) return;
    const verb =
      ROLES.indexOf(nextRole) > ROLES.indexOf(user.role) ? "promote" : "demote";
    if (
      !confirm(
        `${verb[0].toUpperCase() + verb.slice(1)} ${user.email} from ${user.role} → ${nextRole}?`,
      )
    ) {
      return;
    }
    setError(null);
    setPendingId(user.id);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/role", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId: user.id, role: nextRole }),
        });
        const json = (await res.json()) as { ok: boolean; error?: string };
        if (!json.ok) {
          setError(json.error ?? "Update failed");
          return;
        }
        setUsers((prev) =>
          prev.map((u) => (u.id === user.id ? { ...u, role: nextRole } : u)),
        );
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setPendingId(null);
      }
    });
  }

  function toggleExpanded(userId: string) {
    setExpandedId((prev) => (prev === userId ? null : userId));
  }

  return (
    <>
      {error && <p className="hint hint-error">{error}</p>}
      <table className="sources-table">
        <thead>
          <tr>
            <th>Email</th>
            <th>Name</th>
            <th>Role</th>
            <th>Newsletters</th>
            <th>Joined</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const subCount = u.subscriptions.length;
            const isExpanded = expandedId === u.id;
            return (
              <Fragment key={u.id}>
                <tr>
                  <td>{u.email}</td>
                  <td>{u.name}</td>
                  <td>
                    <select
                      value={u.role}
                      disabled={pendingId === u.id}
                      onChange={(e) => changeRole(u, e.target.value as Role)}
                      title="Change role"
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    {pendingId === u.id && (
                      <span className="muted small"> …saving</span>
                    )}
                  </td>
                  <td>
                    {subCount === 0 ? (
                      <span className="muted small">—</span>
                    ) : (
                      <button
                        type="button"
                        className="link-btn admin-sub-toggle"
                        onClick={() => toggleExpanded(u.id)}
                        title={isExpanded ? "Hide details" : "Show subscription filters"}
                      >
                        {subCount} {subCount === 1 ? "sub" : "subs"}
                        <span className="admin-sub-caret" aria-hidden>
                          {isExpanded ? "▾" : "▸"}
                        </span>
                      </button>
                    )}
                  </td>
                  <td className="muted small">
                    {new Date(u.createdAt).toLocaleDateString()}
                  </td>
                </tr>
                {isExpanded && subCount > 0 && (
                  <tr className="admin-sub-detail-row">
                    <td colSpan={5}>
                      <SubscriptionList
                        userId={u.id}
                        subs={u.subscriptions}
                        regions={regions}
                        venuesByRegion={venuesByRegion}
                        townsByRegion={townsByRegion}
                        eventTypes={eventTypes}
                        onChanged={(newSubs) =>
                          setUsers((prev) =>
                            prev.map((row) =>
                              row.id === u.id
                                ? { ...row, subscriptions: newSubs }
                                : row,
                            ),
                          )
                        }
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

/** Render every subscription on a user as a tidy parameter card. */
function SubscriptionList({
  userId,
  subs,
  regions,
  venuesByRegion,
  townsByRegion,
  eventTypes,
  onChanged,
}: {
  userId: string;
  subs: NewsletterSubscription[];
  regions: string[];
  venuesByRegion: Record<string, string[]>;
  townsByRegion: Record<string, string[]>;
  eventTypes: EventType[];
  onChanged: (next: NewsletterSubscription[]) => void;
}) {
  return (
    <div className="admin-sub-list">
      {subs.map((s) => (
        <SubscriptionCard
          key={s.id}
          userId={userId}
          sub={s}
          regions={regions}
          venuesByRegion={venuesByRegion}
          townsByRegion={townsByRegion}
          eventTypes={eventTypes}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}

function SubscriptionCard({
  userId,
  sub,
  regions,
  venuesByRegion,
  townsByRegion,
  eventTypes,
  onChanged,
}: {
  userId: string;
  sub: NewsletterSubscription;
  regions: string[];
  venuesByRegion: Record<string, string[]>;
  townsByRegion: Record<string, string[]>;
  eventTypes: EventType[];
  onChanged: (next: NewsletterSubscription[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<NewsletterSubscription>(sub);
  const [saving, startSave] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Picker option lists tied to whichever region the admin currently has
  // selected in the draft. When they change region, the town/venue lists
  // update too. Same selectable-set convention as the user-facing editor:
  // empty selection means "all of this kind."
  const typeOptions = useMemo(
    () =>
      eventTypes
        .map((t) => ({ key: t, label: TYPE_LABELS[t] ?? t, count: 0 }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [eventTypes],
  );
  const townOptions = useMemo(
    () =>
      (townsByRegion[draft.region] ?? []).map((t) => ({
        key: t,
        label: t,
        count: 0,
      })),
    [townsByRegion, draft.region],
  );
  const venueOptions = useMemo(
    () =>
      (venuesByRegion[draft.region] ?? []).map((v) => ({
        key: v,
        label: v,
        count: 0,
      })),
    [venuesByRegion, draft.region],
  );

  async function callApi(
    action: "patch" | "delete",
    payload?: Record<string, unknown>,
  ) {
    setError(null);
    const res = await fetch("/api/admin/user-subscription", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, action, subscriptionId: sub.id, ...payload }),
    });
    const json = (await res.json()) as {
      ok: boolean;
      state?: { subscriptions: NewsletterSubscription[] };
      error?: string;
    };
    if (!json.ok || !json.state) {
      setError(json.error ?? "Update failed");
      return;
    }
    onChanged(json.state.subscriptions);
    setEditing(false);
  }

  function save() {
    startSave(async () => {
      // Only send fields the admin actually changed. Avoids clobbering
      // surpriseHistory + lastSentAt which the user-facing UI also leaves alone.
      const patch: Partial<NewsletterSubscription> = {};
      const keys: (keyof NewsletterSubscription)[] = [
        "name", "region", "schedule", "lookaheadDays",
        "types", "towns", "venues", "surprise",
        "center", "radiusMi",
      ];
      for (const k of keys) {
        if (JSON.stringify(draft[k]) !== JSON.stringify(sub[k])) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (patch as any)[k] = draft[k];
        }
      }
      await callApi("patch", { patch });
    });
  }

  function remove() {
    if (!confirm(`Delete "${sub.name || "this subscription"}" for this user?`)) return;
    startSave(async () => {
      await callApi("delete");
    });
  }

  // Test-send via the admin API. `recipient: "admin"` mails the digest
  // to the admin (with [PREVIEW] prefix) so they can see what the user
  // would receive; `"user"` mails it to the actual user. Both bypass the
  // due-date cooldown via forceSend=true on the server side.
  const [testStatus, setTestStatus] = useState<string | null>(null);
  function sendTest(recipient: "admin" | "user") {
    if (
      recipient === "user" &&
      !confirm(
        `Send a real test of "${sub.name || "this subscription"}" to this user's email now?`,
      )
    ) {
      return;
    }
    setTestStatus(null);
    setError(null);
    startSave(async () => {
      try {
        const res = await fetch("/api/admin/newsletter-test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            userId,
            subscriptionId: sub.id,
            recipient,
          }),
        });
        const json = (await res.json()) as {
          ok: boolean;
          error?: string;
          skipped?: string;
          recipient?: string;
        };
        if (!json.ok) {
          setError(json.error ?? "Send failed");
          return;
        }
        if (json.skipped) {
          setTestStatus(`Skipped: ${json.skipped}`);
        } else {
          setTestStatus(
            `Sent to ${json.recipient ?? (recipient === "admin" ? "you" : "user")}`,
          );
        }
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }


  const typeLabels =
    sub.types.length === 0
      ? "All types"
      : sub.types
          .map((t) => TYPE_LABELS[t] ?? t)
          .join(", ");
  const townList = sub.towns ?? [];
  const townSummary =
    townList.length === 0
      ? "All towns"
      : townList.length <= 5
      ? townList.join(", ")
      : `${townList.slice(0, 5).join(", ")} + ${townList.length - 5} more`;
  const venueSummary =
    sub.venues.length === 0
      ? "All venues"
      : sub.venues.length <= 3
      ? sub.venues.join(", ")
      : `${sub.venues.slice(0, 3).join(", ")} + ${sub.venues.length - 3} more`;
  const center =
    sub.center && sub.radiusMi
      ? `${sub.center.label} · ${sub.radiusMi} mi`
      : sub.center
      ? sub.center.label
      : "No location filter";
  const lastSent = sub.lastSentAt
    ? new Date(sub.lastSentAt).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "never";

  return (
    <div className="admin-sub-card">
      <div className="admin-sub-card-head">
        <span className="admin-sub-card-name">{sub.name || "(unnamed)"}</span>
        <span className="admin-sub-card-region">{sub.region}</span>
        <span className="admin-sub-card-schedule">
          {sub.schedule} · {sub.lookaheadDays}d lookahead
        </span>
        <div className="admin-sub-card-actions">
          {editing ? (
            <>
              <button
                type="button"
                className="ghost-btn"
                disabled={saving}
                onClick={save}
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                className="ghost-btn"
                disabled={saving}
                onClick={() => {
                  setDraft(sub);
                  setEditing(false);
                  setError(null);
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="ghost-btn"
                disabled={saving}
                onClick={() => sendTest("admin")}
                title="Send this user's digest to YOUR email (admin preview). Subject will be tagged [PREVIEW]."
              >
                {saving ? "Sending…" : "Send test to me"}
              </button>
              <button
                type="button"
                className="ghost-btn"
                disabled={saving}
                onClick={() => sendTest("user")}
                title="Send a real digest to the user's email address (bypasses cooldown)"
              >
                Send test to user
              </button>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
              <button
                type="button"
                className="ghost-btn sub-delete-btn"
                disabled={saving}
                onClick={remove}
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>
      {testStatus && <p className="hint hint-ok">{testStatus}</p>}
      {error && <p className="hint hint-error">{error}</p>}
      {editing ? (
        <dl className="admin-sub-card-grid">
          <dt>Name</dt>
          <dd>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </dd>
          <dt>Region</dt>
          <dd>
            <select
              value={draft.region}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  region: e.target.value,
                  // Switching region invalidates town/venue selections
                  // since they're region-scoped.
                  towns: [],
                  venues: [],
                })
              }
            >
              {regions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
              {/* If the user's region isn't in the manifest (e.g. a deleted
                * region), keep it visible as the current selection. */}
              {!regions.includes(draft.region) && (
                <option value={draft.region}>{draft.region} (unknown)</option>
              )}
            </select>
          </dd>
          <dt>Schedule</dt>
          <dd>
            <select
              value={draft.schedule}
              onChange={(e) =>
                setDraft({ ...draft, schedule: e.target.value as "daily" | "weekly" })
              }
            >
              <option value="weekly">weekly</option>
              <option value="daily">daily</option>
            </select>{" "}
            <input
              type="number"
              min={1}
              max={30}
              value={draft.lookaheadDays}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  lookaheadDays: Math.max(1, Math.min(30, Number(e.target.value) || 1)),
                })
              }
              style={{ width: "5rem" }}
            />{" "}
            <span className="muted small">d lookahead</span>
          </dd>
          <dt>Types</dt>
          <dd>
            <MultiSelectPicker
              label="types"
              singularLabel="type"
              selected={new Set(draft.types)}
              onChange={(next) =>
                setDraft({ ...draft, types: [...next] as EventType[] })
              }
              options={typeOptions}
            />
          </dd>
          <dt>Towns</dt>
          <dd>
            <MultiSelectPicker
              label="towns"
              singularLabel="town"
              selected={new Set(draft.towns ?? [])}
              onChange={(next) => setDraft({ ...draft, towns: [...next] })}
              options={townOptions}
            />
          </dd>
          <dt>Venues</dt>
          <dd>
            <MultiSelectPicker
              label="venues"
              singularLabel="venue"
              selected={new Set(draft.venues)}
              onChange={(next) => setDraft({ ...draft, venues: [...next] })}
              options={venueOptions}
            />
          </dd>
          <dt>Surprise</dt>
          <dd>
            <select
              value={draft.surprise}
              onChange={(e) =>
                setDraft({ ...draft, surprise: e.target.value as typeof draft.surprise })
              }
            >
              <option value="never">never</option>
              <option value="sometimes">sometimes</option>
              <option value="often">often</option>
            </select>
          </dd>
        </dl>
      ) : (
        <dl className="admin-sub-card-grid">
          <dt>Types</dt>
          <dd>{typeLabels}</dd>
          <dt>Towns</dt>
          <dd>{townSummary}</dd>
          <dt>Venues</dt>
          <dd>{venueSummary}</dd>
          <dt>Location</dt>
          <dd>{center}</dd>
          <dt>Surprise</dt>
          <dd>{sub.surprise}</dd>
          <dt>Last sent</dt>
          <dd>{lastSent}</dd>
        </dl>
      )}
    </div>
  );
}
